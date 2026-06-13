/**
 * ArxCode CLI agent harness — the autonomous coding loop.
 * plan → act → observe → verify → settle
 *
 * Ported from ArxCode Studio agent harness and adapted for:
 * - Real filesystem (no VFS)
 * - Real shell execution (no mock)
 * - Iterative console output
 */

import type { AgentMessage, ContentBlock, LLMProvider } from "./llm/types.js";
import { systemPrompt, compactionPrompt } from "./prompts.js";
import { executeTool, setProjectRoot, TOOL_DEFS, toolTitle } from "./tools.js";
import type { ContextFile } from "./context.js";
import { loadContextFiles } from "./context.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ──────────────────────────────────────────────────────────

export interface RunOptions {
  prompt: string;
  projectRoot: string;
  maxSteps?: number;
  signal?: AbortSignal;
  /** Pre-loaded context files (AGENTS.md etc) */
  contextFiles?: ContextFile[];
  /** Previous conversation to continue from (used after compaction) */
  history?: AgentMessage[];
  /** Temperature override (0-2). Omit for provider default. */
  temperature?: number;
}

export interface HarnessEvent {
  type: "status" | "assistant_delta" | "assistant_stop" | "tool_call" | "tool_result" | "error" | "done" | "usage";
  // Status
  phase?: string;
  label?: string;
  // Text
  text?: string;
  // Tool
  toolId?: string;
  toolName?: string;
  toolTitle?: string;
  toolInput?: Record<string, unknown>;
  toolOk?: boolean;
  toolOutput?: string;
  // Error
  message?: string;
  // Done
  summary?: string;
  steps?: number;
  // Usage
  inputTokens?: number;
  outputTokens?: number;
}

// ── Harness ────────────────────────────────────────────────────────

const DEFAULT_MAX_STEPS = 24;

export async function* runAgent(
  provider: LLMProvider,
  opts: RunOptions,
): AsyncGenerator<HarnessEvent, void, unknown> {
  setProjectRoot(opts.projectRoot);
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;

  // Load context files if not provided
  const contextFiles = opts.contextFiles ?? loadContextFiles(opts.projectRoot);

  // Quick scan of workspace files
  const workspaceFiles = scanWorkspace(opts.projectRoot);
  const system = systemPrompt(opts.projectRoot, workspaceFiles, contextFiles);

  // Build conversation — use existing history if provided (post-compaction)
  const convo: AgentMessage[] = opts.history?.length
    ? [...opts.history]
    : [];

  // Add the current prompt
  convo.push({
    role: "user",
    content: [{ type: "text", text: opts.prompt }],
  });

  let lastText = "";
  let totalSteps = 0;

  yield { type: "status", phase: "plan", label: "Planning..." };

  for (let step = 0; step < maxSteps; step++) {
    totalSteps = step + 1;
    const toolCalls: { id: string; name: string; input: Record<string, unknown> }[] = [];
    let textBuf = "";

    try {
      for await (const ev of provider.streamChat({
        system,
        messages: convo,
        tools: TOOL_DEFS,
        signal: opts.signal,
        temperature: opts.temperature,
      })) {
        if (ev.type === "text_delta") {
          textBuf += ev.text;
          yield { type: "assistant_delta", text: ev.text };
        } else if (ev.type === "tool_use") {
          toolCalls.push({ id: ev.id, name: ev.name, input: ev.input });
        } else if (ev.type === "usage") {
          yield { type: "usage", inputTokens: ev.inputTokens, outputTokens: ev.outputTokens };
        }
      }
    } catch (err) {
      yield {
        type: "error",
        message: err instanceof Error ? err.message : "Model request failed",
      };
      return;
    }

    if (textBuf.trim()) {
      lastText = textBuf;
      yield { type: "assistant_stop" };
    }

    // Record assistant turn
    const assistantBlocks: ContentBlock[] = [];
    if (textBuf) assistantBlocks.push({ type: "text", text: textBuf });
    for (const tc of toolCalls)
      assistantBlocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
    if (assistantBlocks.length) convo.push({ role: "assistant", content: assistantBlocks });

    // No tools → agent is done
    if (!toolCalls.length) break;

    yield {
      type: "status",
      phase: "act",
      label: `Running ${toolCalls.length} tool${toolCalls.length > 1 ? "s" : ""}${toolCalls.length > 1 ? " (parallel)" : ""}...`,
    };

    // Emit all tool_call events upfront
    for (const tc of toolCalls) {
      yield {
        type: "tool_call",
        toolId: tc.id,
        toolName: tc.name,
        toolTitle: toolTitle(tc.name, tc.input),
        toolInput: tc.input,
      };
    }

    // Split into read-only and write tools for parallel execution
    const READ_TOOLS = new Set([
      "list_files", "read_file", "search", "find_files",
      "git_diff", "git_log", "git_status", "web_search", "wallet_balance",
    ]);

    const readCalls = toolCalls.filter(tc => READ_TOOLS.has(tc.name));
    const writeCalls = toolCalls.filter(tc => !READ_TOOLS.has(tc.name));

    const resultBlocks: ContentBlock[] = [];
    const toolResults: Array<{ tc: typeof toolCalls[0]; r: Awaited<ReturnType<typeof executeTool>> }> = [];
    let verified = false;

    // Execute read-only tools in parallel
    if (readCalls.length > 0) {
      const results = await Promise.all(
        readCalls.map(tc => executeTool(tc.name, tc.input).then(r => ({ tc, r })))
      );
      for (const { tc, r } of results) {
        toolResults.push({ tc, r });
        if (r.verifies && !verified) {
          verified = true;
          yield { type: "status", phase: "verify", label: "Verifying..." };
        }
      }
    }

    // Execute write tools sequentially (order matters)
    for (const tc of writeCalls) {
      const r = await executeTool(tc.name, tc.input);
      toolResults.push({ tc, r });
      if (r.verifies && !verified) {
        verified = true;
        yield { type: "status", phase: "verify", label: "Verifying..." };
      }
    }

    // Emit all tool results (in original order)
    const tcMap = new Map(toolCalls.map((tc, i) => [tc.id, i]));
    toolResults.sort((a, b) => (tcMap.get(a.tc.id) ?? 0) - (tcMap.get(b.tc.id) ?? 0));

    for (const { tc, r } of toolResults) {
      yield {
        type: "tool_result",
        toolId: tc.id,
        toolName: tc.name,
        toolOk: r.ok,
        toolOutput: r.output,
      };
      resultBlocks.push({
        type: "tool_result",
        tool_use_id: tc.id,
        content: r.output,
        is_error: !r.ok,
      });
    }

    if (!verified) yield { type: "status", phase: "observe", label: "Observing..." };
    convo.push({ role: "user", content: resultBlocks });
  }

  yield {
    type: "status",
    phase: "settle",
    label: "Done.",
  };

  yield {
    type: "done",
    summary: lastText.trim() || "(no summary)",
    steps: totalSteps,
  };
}

/** Quick scan to show the agent what files exist. Limited to 100 entries. */
function scanWorkspace(root: string): string[] {
  const files: string[] = [];
  try {
    walk(root, root, files, 100);
  } catch {
    // ignore scan errors
  }
  return files;
}

function walk(base: string, dir: string, out: string[], limit: number) {
  if (out.length >= limit) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".env.example") continue;
    if (e.name === "node_modules" || e.name === ".git" || e.name === "dist" || e.name === "build") continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full);
    if (e.isDirectory()) {
      walk(base, full, out, limit);
    } else {
      out.push(rel);
      if (out.length >= limit) return;
    }
  }
}
