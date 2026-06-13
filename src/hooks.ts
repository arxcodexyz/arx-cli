/**
 * Hooks System — proactive guardrails for the agent.
 *
 * Hook events:
 *   pre_tool_use   — before executing a tool (can block)
 *   post_tool_use  — after executing a tool (can auto-run follow-ups)
 *   session_start  — when REPL starts
 *   session_stop   — before exiting (can warn about uncommitted changes)
 *
 * Hooks are configured in .arx/hooks.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as cp from "node:child_process";

// ── Types ──────────────────────────────────────────────────────────

export type HookEvent = "pre_tool_use" | "post_tool_use" | "session_start" | "session_stop";

export type HookAction = "block" | "warn" | "confirm" | "run";

export interface Hook {
  name: string;
  event: HookEvent;
  /** Tool name to match (for pre/post_tool_use). Omit = match all. */
  tool?: string;
  /** Pattern to match against tool input or command. Supports * wildcard. */
  pattern?: string;
  /** What to do when matched */
  action: HookAction;
  /** Message to display. Use {command}, {tool}, {path} for interpolation. */
  message?: string;
  /** Command to run (for action=run on post_tool_use) */
  command?: string;
  /** Only run if this glob matches changed files (post_tool_use) */
  if_files?: string;
}

export interface HookContext {
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  projectRoot: string;
}

export interface HookResult {
  /** Name of the matched hook */
  hook: string;
  /** Action taken */
  action: HookAction;
  /** Message to display */
  message: string;
  /** If action=confirm, was it allowed? */
  allowed?: boolean;
  /** Output of run action */
  output?: string;
}

// ── Load ──────────────────────────────────────────────────────────

const HOOKS_FILE = ".arx/hooks.json";

export function loadHooks(projectRoot: string): Hook[] {
  const filePath = path.join(projectRoot, HOOKS_FILE);
  try {
    if (!fs.existsSync(filePath)) return getDefaultHooks();
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as { hooks?: Hook[] };
    return [...getDefaultHooks(), ...(parsed.hooks ?? [])];
  } catch {
    return getDefaultHooks();
  }
}

// ── Built-in Defaults ─────────────────────────────────────────────

function getDefaultHooks(): Hook[] {
  return [
    {
      name: "rm-rf-guard",
      event: "pre_tool_use",
      pattern: "rm -rf /*",
      action: "block",
      message: "🚫 Blocked dangerous command: rm -rf on root. If intentional, disable this hook.",
    },
    {
      name: "force-push-guard",
      event: "pre_tool_use",
      pattern: "push --force*",
      action: "confirm",
      message: "⚠️ Force push detected. This rewrites remote history. Continue?",
    },
    {
      name: "git-clean-guard",
      event: "pre_tool_use",
      pattern: "clean -f*",
      action: "confirm",
      message: "⚠️ git clean -f will delete untracked files. Continue?",
    },
    {
      name: "uncommitted-guard",
      event: "session_stop",
      action: "warn",
      message: "📝 Uncommitted changes detected. Consider committing before exit.",
    },
    {
      name: "auto-typecheck",
      event: "post_tool_use",
      tool: "write_file",
      if_files: "*.ts",
      action: "run",
      command: "npx tsc --noEmit 2>&1 | head -20",
      message: "⚡ Auto type-check...",
    },
  ];
}

// ── Match ─────────────────────────────────────────────────────────

/**
 * Check if a pattern matches a text. Supports * wildcards.
 */
function matchPattern(pattern: string, text: string): boolean {
  // Convert glob-ish pattern to regex
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  const re = new RegExp(escaped, "i");
  return re.test(text);
}

/**
 * Find matching hooks for an event + context.
 */
export function findHooks(hooks: Hook[], event: HookEvent, ctx: HookContext): Hook[] {
  return hooks.filter((h) => {
    if (h.event !== event) return false;
    if (h.tool && h.tool !== ctx.toolName) return false;

    if (h.pattern) {
      // Build searchable text from context
      const searchText = [
        ctx.toolName,
        ctx.toolInput?.command,
        ctx.toolInput?.path,
        ctx.toolInput?.old_string,
        JSON.stringify(ctx.toolInput),
      ]
        .filter(Boolean)
        .join(" ");
      if (!matchPattern(h.pattern, searchText)) return false;
    }

    // if_files check (for post_tool_use)
    if (h.if_files && ctx.toolInput?.path) {
      const filePath = String(ctx.toolInput.path);
      if (!matchPattern(h.if_files, filePath)) return false;
    }

    return true;
  });
}

// ── Execute ───────────────────────────────────────────────────────

export interface RunHookOpts {
  confirmFn?: (message: string) => Promise<boolean>;
}

export async function runHook(
  hook: Hook,
  ctx: HookContext,
  opts: RunHookOpts = {},
): Promise<HookResult> {
  // Interpolate message
  let message = hook.message || "";
  message = message
    .replace(/\{command\}/g, String(ctx.toolInput?.command || ""))
    .replace(/\{tool\}/g, String(ctx.toolName || ""))
    .replace(/\{path\}/g, String(ctx.toolInput?.path || ""));

  const result: HookResult = { hook: hook.name, action: hook.action, message };

  switch (hook.action) {
    case "block": {
      return result;
    }

    case "warn": {
      return result;
    }

    case "confirm": {
      if (opts.confirmFn) {
        result.allowed = await opts.confirmFn(message);
      } else {
        // Default: allow (non-interactive context)
        result.allowed = true;
      }
      return result;
    }

    case "run": {
      if (hook.command) {
        try {
          const output = cp.execSync(hook.command, {
            cwd: ctx.projectRoot,
            timeout: 30_000,
            encoding: "utf-8",
            maxBuffer: 100_000,
            stdio: ["pipe", "pipe", "pipe"],
          });
          result.output = output.trim();
        } catch (err: any) {
          result.output = err.stderr || err.message || "hook failed";
        }
      }
      return result;
    }

    default:
      return result;
  }
}

/**
 * Run all matching hooks for an event. Returns the first block, or all results.
 */
export async function runHooks(
  hooks: Hook[],
  event: HookEvent,
  ctx: HookContext,
  opts: RunHookOpts = {},
): Promise<HookResult[]> {
  const matched = findHooks(hooks, event, ctx);
  if (!matched.length) return [];

  const results: HookResult[] = [];
  for (const hook of matched) {
    const r = await runHook(hook, ctx, opts);
    results.push(r);
    if (r.action === "block" || r.allowed === false) break;
  }
  return results;
}

/**
 * Check whether any result blocked the action.
 */
export function isBlocked(results: HookResult[]): boolean {
  return results.some((r) => r.action === "block" || r.allowed === false);
}

// ── Session Stop Check ────────────────────────────────────────────

/**
 * Check if git working tree is dirty.
 */
export function hasUncommittedChanges(projectRoot: string): boolean {
  try {
    const output = cp.execSync("git status --porcelain", {
      cwd: projectRoot,
      timeout: 5_000,
      encoding: "utf-8",
    });
    return output.trim().length > 0;
  } catch {
    return false;
  }
}
