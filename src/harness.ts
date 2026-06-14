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
import { executeTool, setProjectRoot, TOOL_DEFS, toolTitle, type ToolOutcome } from "./tools.js";
import type { ContextFile } from "./context.js";
import { loadContextFiles } from "./context.js";
import { loadHooks, runHooks, isBlocked, type Hook, type HookResult } from "./hooks.js";
import { executeSkillTool, type Skill } from "./skills.js";
import { getMcpRegistry, callMcpTool } from "./mcp.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ──────────────────────────────────────────────────────────

/** Per-tool output cap in characters (saves tokens before sending to LLM) */
const TOOL_OUTPUT_CAPS: Record<string, number> = {
  read_file: 12000,      // code files can be long
  search: 5000,           // grep results
  run_command: 6000,      // shell output
  run_tests: 4000,        // test output
  web_search: 3000,       // search snippets
  git_diff: 8000,         // diffs can be large
  git_log: 4000,          // commit history
  git_status: 3000,       // status
  list_files: 3000,       // dir listing
  find_files: 3000,       // glob results
  // wallet tools: no cap (tiny output)
};

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
  /** Loaded skills (custom tools + context) */
  skills?: Skill[];
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
  const skills = opts.skills || [];
  const system = systemPrompt(opts.projectRoot, workspaceFiles, contextFiles, skills);

  // Merge skill tools with built-in tools
  const allTools = [...TOOL_DEFS];
  const skillMap = new Map<string, Skill>();
  for (const skill of skills) {
    for (const tool of skill.tools) {
      allTools.push({
        name: tool.name,
        description: `[skill:${skill.name}] ${tool.description}`,
        input_schema: {
          type: "object",
          properties: tool.input_schema.properties,
          required: tool.input_schema.required,
          additionalProperties: tool.input_schema.additionalProperties ?? false,
        },
      });
      skillMap.set(tool.name, skill);
    }
  }

  // Merge MCP tools from connected servers
  const mcpRegistry = getMcpRegistry();
  for (const tool of mcpRegistry.toolDefs) {
    allTools.push(tool);
  }

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
        tools: allTools,
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

    const readCalls = toolCalls.filter(tc => READ_TOOLS.has(tc.name) || skillMap.has(tc.name));
    const writeCalls = toolCalls.filter(tc => !READ_TOOLS.has(tc.name) && !skillMap.has(tc.name));

    const resultBlocks: ContentBlock[] = [];
    const toolResults: Array<{ tc: typeof toolCalls[0]; r: Awaited<ReturnType<typeof executeTool>> }> = [];
    let verified = false;

    // ── Hooks: pre_tool_use ──────────────────────────────────────
    const hooks = loadHooks(opts.projectRoot);
    const blockedTools: Set<string> = new Set();
    const hookMessages: string[] = [];

    for (const tc of toolCalls) {
      const ctx = { toolName: tc.name, toolInput: tc.input, projectRoot: opts.projectRoot };
      const results = await runHooks(hooks, "pre_tool_use", ctx);
      if (isBlocked(results)) {
        blockedTools.add(tc.id);
        for (const r of results) {
          if (r.action === "block" || r.allowed === false) {
            hookMessages.push(`[hook:${r.hook}] ${r.message}`);
          }
        }
      }
    }

    // Execute read-only tools in parallel (skip blocked)
    if (readCalls.length > 0) {
      const allowedReads = readCalls.filter(tc => !blockedTools.has(tc.id));
      const results = await Promise.all(
        allowedReads.map(tc => dispatchTool(tc.name, tc.input, skillMap).then(r => ({ tc, r })))
      );
      for (const { tc, r } of results) {
        toolResults.push({ tc, r });
        if (r.verifies && !verified) {
          verified = true;
          yield { type: "status", phase: "verify", label: "Verifying..." };
        }
      }
    }

    // Execute write tools sequentially (skip blocked)
    for (const tc of writeCalls) {
      if (blockedTools.has(tc.id)) continue;
      const r = await dispatchTool(tc.name, tc.input, skillMap);
      toolResults.push({ tc, r });
      if (r.verifies && !verified) {
        verified = true;
        yield { type: "status", phase: "verify", label: "Verifying..." };
      }
    }

    // Yield blocked tool results
    for (const msg of hookMessages) {
      yield {
        type: "tool_result" as const,
        toolId: "hook",
        toolName: "hook",
        toolOk: false,
        toolOutput: msg,
      };
      resultBlocks.push({
        type: "tool_result",
        tool_use_id: "hook",
        content: msg,
        is_error: true,
      });
    }

    // ── Hooks: post_tool_use ─────────────────────────────────────
    for (const tr of toolResults) {
      const ctx = { toolName: tr.tc.name, toolInput: tr.tc.input, toolOutput: tr.r.output, projectRoot: opts.projectRoot };
      const postResults = await runHooks(hooks, "post_tool_use", ctx);
      for (const pr of postResults) {
        if (pr.action === "run" && pr.output) {
          yield {
            type: "status" as const,
            phase: "verify",
            label: pr.message || `hook: ${pr.hook}`,
          };
          // Don't add hook run output to conversation — it's for display only
        } else if (pr.action === "warn") {
          yield {
            type: "tool_result" as const,
            toolId: "hook",
            toolName: "hook",
            toolOk: true,
            toolOutput: `[hook:${pr.hook}] ${pr.message}`,
          };
          resultBlocks.push({
            type: "tool_result",
            tool_use_id: "hook",
            content: `[hook:${pr.hook}] ${pr.message}`,
            is_error: false,
          });
        }
      }
    }

    // Emit all tool results (in original order)
    const tcMap = new Map(toolCalls.map((tc, i) => [tc.id, i]));
    toolResults.sort((a, b) => (tcMap.get(a.tc.id) ?? 0) - (tcMap.get(b.tc.id) ?? 0));

    for (const { tc, r } of toolResults) {
      // Smart truncation: cap tool output to save tokens before sending to LLM
      const maxLen = TOOL_OUTPUT_CAPS[tc.name] ?? 6000;
      const truncated = r.output.length > maxLen
        ? r.output.slice(0, maxLen) + `\n... (${r.output.length - maxLen} more chars)`
        : r.output;

      yield {
        type: "tool_result",
        toolId: tc.id,
        toolName: tc.name,
        toolOk: r.ok,
        toolOutput: truncated,
      };
      resultBlocks.push({
        type: "tool_result",
        tool_use_id: tc.id,
        content: truncated,
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

// ── Helpers ─────────────────────────────────────────────────────────

/** Dispatch tool execution: built-in, skill tool, or MCP tool */
async function dispatchTool(
  name: string,
  input: Record<string, unknown>,
  skillMap: Map<string, Skill>,
): Promise<ToolOutcome> {
  // Check if this is a skill tool
  const skill = skillMap.get(name);
  if (skill) {
    const result = await executeSkillTool(skill, name, input);
    return { ok: result.ok, output: result.output };
  }
  // Check if this is an MCP tool (prefixed with mcp_)
  if (name.startsWith("mcp_")) {
    const result = await callMcpTool(name, input);
    return { ok: result.ok, output: result.output };
  }
  // Default: built-in tool
  return executeTool(name, input);
}

/** Check if a tool is a known built-in read tool */
function isBuiltinReadTool(name: string): boolean {
  const READ_TOOLS = new Set([
    "list_files", "read_file", "search", "find_files",
    "git_diff", "git_log", "git_status", "web_search", "wallet_balance",
  ]);
  return READ_TOOLS.has(name);
}

/** Quick scan to show the agent what files exist. Limited to 40 entries to save tokens. */
function scanWorkspace(root: string): string[] {
  const files: string[] = [];
  try {
    walk(root, root, files, 40);
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
