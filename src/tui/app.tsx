/**
 * TUI App — main Ink application component.
 * Wraps the full REPL experience: header, output log, status bar, input.
 */

import React, { useState, useCallback, useRef, useEffect } from "react";
import { Box, useInput, useApp } from "ink";
import { Header } from "./components/Header.js";
import { Input } from "./components/Input.js";
import { Output, type OutputLine } from "./components/Output.js";
import { StatusBar } from "./components/StatusBar.js";
import { handleCommand, type SessionState } from "../commands.js";
import { loadConfig } from "../config.js";
import { loadContextFiles } from "../context.js";
import { loadSkills } from "../skills.js";
import { createProvider } from "../llm/index.js";
import { runAgent, type HarnessEvent } from "../harness.js";
import { highlightChunk, createHighlighter, type HighlightState } from "../highlight.js";
import { expandAlias } from "../commands.js";
import { LLMError } from "../llm/types.js";
import * as fs from "node:fs";
import * as path from "node:path";

const VERSION = "0.4.0";

// ── Helpers ───────────────────────────────────────────────────────

let lineIdCounter = 0;

function makeLine(type: OutputLine["type"], content: string, raw?: string): OutputLine {
  return { id: ++lineIdCounter, type, content, raw };
}

function shorten(text: string, max: number): string {
  const lines = text.split("\n");
  const first = lines[0].trim();
  if (first.length <= max) return first;
  return first.slice(0, max - 3) + "...";
}

function phaseIcon(phase: string): string {
  switch (phase) {
    case "plan": return "🧠";
    case "act": return "🔧";
    case "observe": return "👀";
    case "verify": return "✅";
    case "settle": return "🏁";
    default: return "•";
  }
}

// ── Props ─────────────────────────────────────────────────────────

interface AppProps {
  projectRoot: string;
  initialProvider?: string;
  initialModel?: string;
  initialKey?: string;
}

// ── Component ─────────────────────────────────────────────────────

export const App: React.FC<AppProps> = ({
  projectRoot,
  initialProvider,
  initialModel,
  initialKey,
}) => {
  const { exit } = useApp();

  // Load config and initialize session state
  const cfg = loadConfig(projectRoot);
  if (initialProvider) cfg.provider = initialProvider as any;
  if (initialModel) cfg.model = initialModel;
  if (initialKey) cfg.apiKey = initialKey;

  const providerId = (cfg.provider ?? "anthropic") as any;
  const model = cfg.model || (cfg.models as any)?.[providerId] || "";
  const apiKey = cfg.apiKey || (cfg.keys as any)?.[providerId] || "";

  // Session state (mutable ref for async access, plus state for rendering)
  const stateRef = useRef<SessionState>({
    config: cfg,
    projectRoot,
    providerId,
    model,
    apiKey,
    maxSteps: cfg.maxSteps ?? 24,
    exit: false,
    clearHistory: false,
    contextFiles: loadContextFiles(projectRoot),
    conversation: [],
  });

  // UI state
  const [outputLines, setOutputLines] = useState<OutputLine[]>(() => [
    makeLine("info", `Provider: ${providerId}  ·  Model: ${model || "(default)"}  ·  ${projectRoot}`),
  ]);
  const [phase, setPhase] = useState("idle");
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState(0);
  const [inputTokens, setInputTokens] = useState(0);
  const [outputTokens, setOutputTokens] = useState(0);
  const [startTime, setStartTime] = useState(0);

  // Refs for async streaming
  const abortRef = useRef<AbortController | null>(null);
  const highlighterRef = useRef<HighlightState>(createHighlighter());

  // Add a line to output
  const addLine = useCallback((line: OutputLine) => {
    setOutputLines(prev => [...prev, line]);
  }, []);

  // Handle Ctrl+C to interrupt
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (running) {
        // Interrupt the agent
        abortRef.current?.abort();
        addLine(makeLine("info", "^C — interrupted"));
        setRunning(false);
        setPhase("idle");
      } else {
        // Exit the app
        exit();
      }
    }
  });

  // ── Submit Handler ──────────────────────────────────────────────

  const handleSubmit = useCallback(
    async (input: string) => {
      const state = stateRef.current;

      // Slash command?
      if (input.startsWith("/")) {
        const output = handleCommand(input, state);
        if (output) {
          addLine(makeLine("info", output));
        }
        if (state.exit) {
          exit();
          return;
        }
        // Auto-trigger review/commit if queued
        if (state.reviewPrompt || state.commitPrompt) {
          await runAgentWithState("", state);
        }
        if (state.clearHistory) {
          state.conversation = [];
          state.clearHistory = false;
          addLine(makeLine("info", "Session cleared."));
        }
        return;
      }

      // Validate API key
      if (!state.apiKey) {
        addLine(makeLine("error", "No API key. Set one with /key <***> or /provider <name>."));
        return;
      }

      await runAgentWithState(input, state);

      if (state.clearHistory) {
        state.conversation = [];
        state.clearHistory = false;
      }
    },
    [addLine, exit],
  );

  // ── Run Agent ───────────────────────────────────────────────────

  const runAgentWithState = useCallback(
    async (input: string, state: SessionState) => {
      // Handle code review/commit pending
      let prompt: string;
      if (state.reviewPrompt) {
        prompt = state.reviewPrompt;
        state.reviewPrompt = undefined;
        if (input && !input.startsWith("/")) {
          prompt += `\n\nAdditional instructions from user: ${input}`;
        }
        addLine(makeLine("phase", "🔍 Running code review..."));
      } else if (state.commitPrompt) {
        prompt = state.commitPrompt;
        state.commitPrompt = undefined;
        if (input && !input.startsWith("/")) {
          prompt += `\n\nAdditional instructions from user: ${input}`;
        }
        addLine(makeLine("phase", "📝 Generating commit message..."));
      } else {
        // Handle compaction if pending
        if (state.compactPending) {
          addLine(makeLine("phase", "⚠ Compaction not yet supported in TUI mode. Use readline REPL for /compact."));
          state.compactPending = undefined;
          return;
        }
        prompt = input;
      }

      // Expand aliases
      const expanded = expandAlias(prompt);
      if (expanded !== prompt) {
        addLine(makeLine("info", `→ ${expanded.slice(0, 80)}...`));
        prompt = expanded;
      }

      // Expand @file references
      const expandedInput = expandFileRefs(prompt, state.projectRoot);
      if (expandedInput !== prompt) {
        addLine(makeLine("info", "📎 Expanded @file references"));
      }

      // Load skills
      const skills = loadSkills(state.projectRoot).skills;

      // Create provider
      let provider;
      try {
        provider = createProvider({
          provider: state.providerId,
          apiKey: state.apiKey,
          model: state.model || undefined,
          baseUrl: state.config.baseUrl,
          temperature: state.temperature,
        });
      } catch (err) {
        addLine(makeLine("error", `${err instanceof Error ? err.message : err}`));
        return;
      }

      // Start streaming
      setRunning(true);
      setSteps(0);
      setInputTokens(0);
      setOutputTokens(0);
      setStartTime(Date.now());
      abortRef.current = new AbortController();
      highlighterRef.current = createHighlighter();

      let currentText = "";
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let stepCount = 0;
      const currentToolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
      const currentToolResults: Array<{ type: "tool_result"; tool_use_id: string; content: string; is_error: boolean }> = [];

      try {
        for await (const ev of runAgent(provider, {
          prompt: expandedInput,
          projectRoot: state.projectRoot,
          maxSteps: state.maxSteps,
          contextFiles: state.contextFiles,
          history: state.conversation?.length ? state.conversation : undefined,
          temperature: state.temperature,
          skills,
          signal: abortRef.current.signal,
        })) {
          switch (ev.type) {
            case "status": {
              const ph = ev.phase || "";
              const label = ev.label || "";
              const icon = phaseIcon(ph);
              setPhase(ph);
              if (ph !== "settle") {
                addLine(makeLine("phase", `${icon} ${label}`));
              }
              break;
            }

            case "assistant_delta": {
              const hstate = highlighterRef.current;
              if (!currentText) {
                // First text chunk — add a prefix marker
                addLine(makeLine("text", "┃ ", ""));
              }
              const highlighted = highlightChunk(hstate, ev.text!);
              // Append to the last text line or create new one
              currentText += ev.text!;
              setOutputLines(prev => {
                const last = prev[prev.length - 1];
                if (last && last.type === "text") {
                  // Update last line in place
                  const updated = [...prev];
                  updated[updated.length - 1] = {
                    ...last,
                    content: last.content + (last.raw || highlighted || ev.text!),
                  };
                  return updated;
                }
                return [...prev, makeLine("text", highlighted || ev.text!)];
              });
              break;
            }

            case "assistant_stop": {
              // End of text block
              if (currentText) {
                addLine(makeLine("divider", ""));
              }
              break;
            }

            case "tool_call": {
              const title = ev.toolTitle || ev.toolName || "";
              addLine(makeLine("tool_call", title));
              currentToolCalls.push({ id: ev.toolId!, name: ev.toolName!, input: ev.toolInput! });
              break;
            }

            case "tool_result": {
              const summary = shorten(ev.toolOutput || "", 100);
              if (ev.toolOk) {
                addLine(makeLine("tool_result_ok", summary));
              } else {
                addLine(makeLine("tool_result_err", summary));
              }
              currentToolResults.push({
                type: "tool_result",
                tool_use_id: ev.toolId!,
                content: ev.toolOutput || "",
                is_error: !ev.toolOk,
              });
              break;
            }

            case "usage": {
              totalInputTokens += ev.inputTokens ?? 0;
              totalOutputTokens += ev.outputTokens ?? 0;
              setInputTokens(totalInputTokens);
              setOutputTokens(totalOutputTokens);
              if (state) {
                state.totalInputTokens = (state.totalInputTokens ?? 0) + (ev.inputTokens ?? 0);
                state.totalOutputTokens = (state.totalOutputTokens ?? 0) + (ev.outputTokens ?? 0);
              }
              break;
            }

            case "error": {
              addLine(makeLine("error", ev.message || "Unknown error"));
              break;
            }

            case "done": {
              stepCount = ev.steps ?? stepCount;
              setSteps(stepCount);

              // Flush highlighter buffer
              const hstate = highlighterRef.current;
              if (hstate.buffer) {
                addLine(makeLine("text", hstate.inBlock
                  ? hstate.buffer
                  : hstate.buffer));
                hstate.buffer = "";
              }

              const tokenStr = (totalInputTokens > 0 || totalOutputTokens > 0)
                ? ` ↥${totalInputTokens.toLocaleString()} ↧${totalOutputTokens.toLocaleString()}`
                : "";
              const stepStr = `${stepCount} step${stepCount !== 1 ? "s" : ""}`;
              addLine(makeLine("done", `${stepStr}${tokenStr}`));

              // Hint for compaction
              const msgCount = (state.conversation?.length ?? 0) + 2;
              if (msgCount > 15) {
                const estCtx = ((msgCount * 2000) / 1000).toFixed(0);
                addLine(makeLine("info", `💡 ${msgCount} msgs (~${estCtx}K ctx) — /compact to save tokens`));
              }
              break;
            }
          }
        }

        setPhase("settle");
      } catch (err) {
        if (err instanceof LLMError) {
          addLine(makeLine("error", `LLM Error: ${err.message}`));
        } else if (err instanceof Error && err.name === "AbortError") {
          // User interrupted — already handled
        } else {
          addLine(makeLine("error", `${err instanceof Error ? err.message : err}`));
        }
        setPhase("idle");
        return;
      } finally {
        setRunning(false);
        abortRef.current = null;
      }

      // Save conversation to session state
      try {
        state.conversation = state.conversation ?? [];
        state.conversation.push({
          role: "user",
          content: [{ type: "text", text: expandedInput }],
        });

        const assistantBlocks: any[] = [];
        if (currentText) assistantBlocks.push({ type: "text", text: currentText });
        for (const tc of currentToolCalls) {
          assistantBlocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
        }
        if (assistantBlocks.length > 0) {
          state.conversation.push({ role: "assistant", content: assistantBlocks });
        }
        if (currentToolResults.length > 0) {
          state.conversation.push({ role: "user", content: currentToolResults });
        }
      } catch {
        // Non-fatal
      }

      setPhase("idle");
    },
    [addLine],
  );

  // ── Render ──────────────────────────────────────────────────────

  return (
    <Box flexDirection="column" height="100%" padding={0}>
      <Header state={stateRef.current} version={VERSION} />
      <Output lines={outputLines} maxLines={200} />
      <StatusBar
        phase={phase}
        steps={steps}
        inputTokens={inputTokens}
        outputTokens={outputTokens}
        elapsedMs={startTime && running ? Date.now() - startTime : 0}
      />
      <Input
        onSubmit={handleSubmit}
        disabled={running}
      />
    </Box>
  );
};

// ── @file Reference Expansion ─────────────────────────────────────

function expandFileRefs(input: string, projectRoot: string): string {
  const re = /(?:^|\s)@([^\s:]+(?:\.[a-zA-Z]{1,10})?(?::\d+(?:-\d+)?)?)(?=\s|$)/g;

  let result = input;
  let match: RegExpExecArray | null;

  while ((match = re.exec(input)) !== null) {
    const ref = match[1];
    let filePath = ref;
    let lineRange: string | undefined;

    const colonIdx = ref.lastIndexOf(":");
    if (colonIdx > 0) {
      const after = ref.slice(colonIdx + 1);
      if (/^\d+(-\d+)?$/.test(after)) {
        filePath = ref.slice(0, colonIdx);
        lineRange = after;
      }
    }

    const absPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(projectRoot, filePath);

    if (!fs.existsSync(absPath)) continue;

    try {
      const stat = fs.statSync(absPath);
      if (stat.isDirectory()) continue;

      let content: string;
      const lang = path.extname(absPath).slice(1) || "text";
      const relPath = path.relative(projectRoot, absPath);

      if (lineRange) {
        const fileContent = fs.readFileSync(absPath, "utf-8");
        const lines = fileContent.split("\n");
        const [startStr, endStr] = lineRange.split("-");
        const start = Math.max(1, parseInt(startStr, 10)) - 1;
        const end = endStr ? parseInt(endStr, 10) : start + 1;
        content = lines.slice(start, end).join("\n");
      } else {
        content = fs.readFileSync(absPath, "utf-8");
        const lineCount = content.split("\n").length;
        if (lineCount > 500) {
          content = content.split("\n").slice(0, 500).join("\n");
          content += `\n// ... (truncated, ${lineCount - 500} more lines)`;
        }
      }

      const replacement = `\n\n<file path="${relPath}">\n\`\`\`${lang}\n${content}\n\`\`\`\n</file>\n\n`;
      const prefix = input[match.index!] === "@" ? "" : input[match.index!] || "";
      const oldText = prefix + "@" + ref;
      const newText = prefix + replacement;

      if (result.includes(oldText)) {
        result = result.split(oldText).join(newText);
      }
    } catch {
      // skip unreadable files
    }
  }

  return result;
}
