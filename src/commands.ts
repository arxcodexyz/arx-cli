/**
 * Slash command registry for ArxCode CLI.
 * All commands are resolved here at runtime.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as cp from "node:child_process";
import * as crypto from "node:crypto";
import chalk from "chalk";
import type { ArxConfig, ProviderId } from "./config.js";
import { loadConfig, resolveProviderConfig, configStatus } from "./config.js";
import { TOOL_DEFS } from "./tools.js";
import { PROVIDER_REGISTRY } from "./llm/types.js";
import { loadContextFiles } from "./context.js";
import { glob } from "glob";

// ── Model Presets ───────────────────────────────────

export const MODEL_PRESETS: Record<string, { id: string; name: string; description: string }[]> = {
  anthropic: [
    { id: "claude-opus-4-8", name: "Claude Opus 4", description: "Most capable — complex builds" },
    { id: "claude-sonnet-4-8", name: "Claude Sonnet 4", description: "Fast & capable — daily driver" },
    { id: "claude-haiku-4-8", name: "Claude Haiku 4", description: "Fastest — quick fixes" },
  ],
  openai: [
    { id: "gpt-5.1", name: "GPT-5.1", description: "Latest — best all-around" },
    { id: "gpt-5", name: "GPT-5", description: "Balanced speed & quality" },
    { id: "gpt-5-mini", name: "GPT-5 Mini", description: "Fast — lightweight builds" },
  ],
  groq: [
    { id: "meta-llama/llama-4-scout-17b-16e-instruct", name: "Llama 4 Scout", description: "Fast & free — daily driver" },
    { id: "meta-llama/llama-4-maverick-17b-128e-instruct", name: "Llama 4 Maverick", description: "More capable, still fast" },
    { id: "deepseek-ai/deepseek-r1-distill-llama-70b", name: "DeepSeek R1 70B", description: "Reasoning powerhouse" },
    { id: "qwen-qwq-32b", name: "Qwen QWQ 32B", description: "Strong reasoning, free" },
  ],
  deepseek: [
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", description: "Latest — best all-around ($0.14/M)" },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", description: "Fastest — daily driver" },
    { id: "deepseek-chat", name: "V3 (legacy)", description: "Deprecated 2026/07/24 → use V4 Flash" },
    { id: "deepseek-reasoner", name: "R1 (legacy)", description: "Deep reasoning — deprecated 2026/07/24" },
  ],
  "deepseek-anthropic": [
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", description: "Latest — best all-around (via Anthropic API)" },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", description: "Fastest — daily driver (via Anthropic API)" },
    { id: "claude-opus-4-8", name: "→ V4 Pro (mapped)", description: "Maps to deepseek-v4-pro" },
    { id: "claude-sonnet-4-8", name: "→ V4 Flash (mapped)", description: "Maps to deepseek-v4-flash" },
  ],
  openrouter: [
    { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4 (OR)", description: "Best all-around via OpenRouter" },
    { id: "anthropic/claude-opus-4", name: "Claude Opus 4 (OR)", description: "Most capable via OpenRouter" },
    { id: "openai/gpt-5.1", name: "GPT-5.1 (OR)", description: "Latest OpenAI via OpenRouter" },
    { id: "deepseek/deepseek-chat", name: "DeepSeek-V3 (OR)", description: "Cheap & fast via OpenRouter" },
    { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro (OR)", description: "1M context via OpenRouter" },
  ],
  xai: [
    { id: "grok-4", name: "Grok-4", description: "xAI flagship — strong all-around" },
    { id: "grok-4-mini", name: "Grok-4 Mini", description: "Faster, lighter Grok" },
    { id: "grok-3", name: "Grok-3", description: "Previous generation" },
  ],
  google: [
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", description: "1M context — best reasoning" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", description: "Fast, 1M context — daily driver" },
    { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", description: "Fastest, free tier available" },
  ],
  custom: [
    { id: "", name: "Custom model", description: "Set model via /model <name>" },
  ],
};

// ── Session State ──────────────────────────────────────────────────

/** All slash commands for auto-complete */
export const SLASH_COMMANDS = [
  "/model", "/provider", "/temp", "/config", "/tools",
  "/project", "/session", "/key", "/clear", "/compact",
  "/reload", "/save", "/load", "/sessions", "/review",
  "/commit", "/export", "/search", "/diff",
  "/status", "/log", "/find", "/stream",
  "/wallet", "/balance",
  "/alias", "/setup",
  "/help", "/quit", "/h", "/q", "/new", "/reset",
];

export interface SessionState {
  config: ArxConfig;
  projectRoot: string;
  providerId: ProviderId;
  model: string;
  apiKey: string;
  maxSteps: number;
  exit: boolean;
  clearHistory: boolean;
  message?: string;
  /** Temperature (0-2). undefined = provider default */
  temperature?: number;
  /** Loaded context files (AGENTS.md, etc.) */
  contextFiles?: import("./context.js").ContextFile[];
  /** Conversation history for compaction */
  conversation?: import("./llm/types.js").AgentMessage[];
  /** Track if a compaction is pending */
  compactPending?: { instructions?: string };
  /** Pending code review prompt (set by /review command) */
  reviewPrompt?: string;
  /** Pending commit message prompt (set by /commit command) */
  commitPrompt?: string;
  /** Streaming toggle (default: true). Set by /stream command. */
  streaming?: boolean;
}

// ── Command Handler ────────────────────────────────────────────────

export function handleCommand(input: string, state: SessionState): string | null {
  const trimmed = input.trim();

  // /model — show or switch model
  if (trimmed === "/model" || trimmed.startsWith("/model ")) {
    const arg = trimmed.slice(7).trim();
    if (!arg) {
      // Show available models
      return showModels(state);
    }
    // Switch model
    const found = findModel(state.providerId, arg);
    if (found) {
      state.model = found;
      state.config.model = found;
      return chalk.green(`\n  ✓ Model: ${chalk.bold(found)}\n`);
    }
    return chalk.red(`\n  ✗ Model "${arg}" not found for provider "${state.providerId}". Use /model to list.\n`);
  }

  // /provider — show or switch provider
  if (trimmed === "/provider" || trimmed.startsWith("/provider ")) {
    const arg = trimmed.slice(10).trim();
    if (!arg) {
      return showProviders(state);
    }
    // Validate against registry
    const meta = PROVIDER_REGISTRY[arg as ProviderId];
    if (!meta) {
      const valid = Object.keys(PROVIDER_REGISTRY).join(", ");
      return chalk.red(`\n  ✗ Unknown provider: ${arg}. Valid: ${valid}\n`);
    }
    const newProvider = arg as ProviderId;
    state.providerId = newProvider;
    state.config.provider = newProvider;
    // Auto-pick first model for new provider
    state.model = MODEL_PRESETS[newProvider]?.[0]?.id || meta.defaultModel;
    state.config.model = state.model;
    // Resolve key for new provider
    const keys = (state.config.keys as Record<string, string | undefined>) ?? {};
    const key = keys[newProvider] || state.apiKey;
    if (key) state.apiKey = key;
    const hasKey = keys[newProvider];

    return chalk.green(`\n  ✓ Provider: ${chalk.bold(meta.name)} | Model: ${state.model} | Key: ${hasKey ? "✓" : "✗ MISSING"}\n`);
  }

  // /config — show config
  if (trimmed === "/config") {
    return "\n" + configStatus(state.config) + "\n";
  }

  // /tools — list available tools
  if (trimmed === "/tools") {
    return showTools();
  }

  // /help — show all commands
  if (trimmed === "/help" || trimmed === "/?" || trimmed === "/h") {
    return showHelp();
  }

  // /clear or /new — clear conversation
  if (trimmed === "/clear" || trimmed === "/new" || trimmed === "/reset") {
    state.clearHistory = true;
    return chalk.green("\n  ✓ Session cleared. Fresh start.\n");
  }

  // /project — show or change project root
  if (trimmed === "/project" || trimmed.startsWith("/project ")) {
    const arg = trimmed.slice(9).trim();
    if (!arg) {
      return chalk.dim(`\n  Project: ${state.projectRoot}\n`);
    }
    const newPath = path.resolve(arg);
    if (!fs.existsSync(newPath)) {
      return chalk.red(`\n  ✗ Directory not found: ${newPath}\n`);
    }
    state.projectRoot = newPath;
    state.config.project = newPath;
    return chalk.green(`\n  ✓ Project: ${chalk.bold(newPath)}\n`);
  }

  // /session — show session info
  if (trimmed === "/session") {
    return showSession(state);
  }

  // /quit, /exit, /q
  if (trimmed === "/quit" || trimmed === "/exit" || trimmed === "/q") {
    state.exit = true;
    return chalk.dim("\n  👋 Bye!\n");
  }

  // /compact [instructions] — compress conversation context
  if (trimmed === "/compact" || trimmed.startsWith("/compact ")) {
    const instructions = trimmed.slice(9).trim() || undefined;
    state.compactPending = { instructions };
    const hint = instructions ? ` (with instructions: "${instructions}")` : "";
    return chalk.cyan(`\n  ⚡ Compaction queued${hint}. Send your next prompt to trigger it.\n`);
  }

  // /reload — re-scan context files (AGENTS.md, etc.)
  if (trimmed === "/reload") {
    state.contextFiles = loadContextFiles(state.projectRoot);
    const count = state.contextFiles?.length ?? 0;
    if (count > 0) {
      const names = state.contextFiles!.map(f => f.name).join(", ");
      return chalk.green(`\n  ✓ Reloaded ${count} context file(s): ${names}\n`);
    }
    return chalk.yellow(`\n  ⚠ No context files found in ${state.projectRoot}\n`);
  }

  // /temp [value] — show or set temperature
  if (trimmed === "/temp" || trimmed.startsWith("/temp ")) {
    const arg = trimmed.slice(6).trim();
    if (!arg) {
      const current = state.temperature != null ? state.temperature.toFixed(1) : "provider default (~0.7)";
      return chalk.dim(`\n  Temperature: ${chalk.bold(current)}\n  Set: /temp 0.0 - 2.0\n`);
    }
    const val = parseFloat(arg);
    if (isNaN(val) || val < 0 || val > 2) {
      return chalk.red(`\n  ✗ Invalid temperature: ${arg}. Use 0.0 - 2.0\n`);
    }
    state.temperature = val;
    const label = val === 0 ? "deterministic" : val < 0.5 ? "focused" : val < 1.0 ? "balanced" : "creative";
    return chalk.green(`\n  ✓ Temperature: ${chalk.bold(val.toFixed(1))} (${label})\n`);
  }

  // /save <name> — save current session
  if (trimmed.startsWith("/save ")) {
    const name = trimmed.slice(6).trim();
    if (!name) return chalk.red("\n  ✗ Usage: /save <name>\n");
    return saveSession(name, state);
  }

  // /load <name> — load a saved session
  if (trimmed.startsWith("/load ")) {
    const name = trimmed.slice(6).trim();
    if (!name) return chalk.red("\n  ✗ Usage: /load <name>\n");
    return loadSession(name, state);
  }

  // /sessions — list saved sessions
  if (trimmed === "/sessions") {
    return listSessions();
  }

  // /review [target] — code review
  if (trimmed === "/review" || trimmed.startsWith("/review ")) {
    const arg = trimmed.slice(8).trim();
    return handleReview(arg, state);
  }

  // /commit [--amend|-a] — AI generate commit message
  if (trimmed === "/commit" || trimmed.startsWith("/commit ")) {
    const arg = trimmed.slice(8).trim();
    return handleCommit(arg, state);
  }

  // /export [path] — export conversation to markdown
  if (trimmed === "/export" || trimmed.startsWith("/export ")) {
    const arg = trimmed.slice(8).trim();
    return exportConversation(arg, state);
  }

  // /search <query> — web search (Whoogle)
  if (trimmed.startsWith("/search ")) {
    const query = trimmed.slice(8).trim();
    if (!query) return chalk.red("\n  ✗ Usage: /search <query>\n");
    return searchWeb(query);
  }

  // /diff [target] — show git diff
  if (trimmed === "/diff" || trimmed.startsWith("/diff ")) {
    const arg = trimmed.slice(6).trim();
    return showDiff(arg, state);
  }

  // /status — show git status
  if (trimmed === "/status") {
    return showGitStatus(state);
  }

  // /log [n] — show recent git commits
  if (trimmed === "/log" || trimmed.startsWith("/log ")) {
    const arg = trimmed.slice(5).trim();
    const count = parseInt(arg, 10) || 10;
    return showGitLog(Math.min(count, 30), state);
  }

  // /find <pattern> — find files by name
  if (trimmed.startsWith("/find ")) {
    const pattern = trimmed.slice(6).trim();
    if (!pattern) return chalk.red("\n  ✗ Usage: /find <pattern>   e.g. /find *.ts\n");
    return findFiles(pattern, state);
  }

  // /stream [on|off] — toggle streaming mode
  if (trimmed === "/stream" || trimmed.startsWith("/stream ")) {
    const arg = trimmed.slice(8).trim();
    if (!arg) {
      const status = state.streaming !== false ? chalk.green("on") : chalk.red("off");
      return chalk.dim(`\n  Streaming: ${status}\n  Toggle: /stream on | /stream off\n`);
    }
    if (arg === "on" || arg === "true" || arg === "1") {
      state.streaming = true;
      return chalk.green("\n  ✓ Streaming ON\n");
    }
    if (arg === "off" || arg === "false" || arg === "0") {
      state.streaming = false;
      return chalk.yellow("\n  ✓ Streaming OFF (responses will arrive in one shot)\n");
    }
    return chalk.red(`\n  ✗ Invalid: ${arg}. Use on/off.\n`);
  }

  // /wallet [evm|solana] — generate wallet
  if (trimmed === "/wallet" || trimmed.startsWith("/wallet ")) {
    const arg = trimmed.slice(8).trim() || "evm";
    return generateWalletCli(arg);
  }

  // /balance <chain> <address> — check balance
  if (trimmed.startsWith("/balance ")) {
    const parts = trimmed.slice(9).trim().split(/\s+/);
    if (parts.length < 2) return chalk.red("\n  ✗ Usage: /balance <chain> <address>\n  Example: /balance ethereum 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045\n");
    return checkBalanceCli(parts[0], parts[1]);
  }

  // /alias [name] [prompt] — create or list command aliases
  if (trimmed === "/alias" || trimmed.startsWith("/alias ")) {
    const rest = trimmed.slice(7).trim();
    return handleAlias(rest, state);
  }

  // /setup — interactive provider setup wizard
  if (trimmed === "/setup") {
    return setupWizard(state);
  }

  // /key — set API key
  if (trimmed.startsWith("/key ")) {
    const key = trimmed.slice(5).trim();
    state.apiKey = key;
    state.config.apiKey = key;
    if (!state.config.keys) state.config.keys = {};
    state.config.keys[state.providerId] = key;
    return chalk.green(`\n  ✓ API key set for ${state.providerId}\n`);
  }

  return null; // not a command
}

// ── Display Helpers ────────────────────────────────────────────────

function showModels(state: SessionState): string {
  const presets = MODEL_PRESETS[state.providerId] || [];
  if (!presets.length) return chalk.yellow("\n  No models available for this provider.\n");

  let out = `\n${chalk.bold.cyan("  Models for")} ${chalk.bold(state.providerId)}\n\n`;
  for (const p of presets) {
    const active = p.id === state.model ? chalk.green(" ●") : "  ";
    out += `  ${active} ${chalk.bold(p.name)}  ${chalk.dim(p.id)}\n`;
    out += `      ${chalk.dim(p.description)}\n\n`;
  }
  out += chalk.dim(`  Switch: /model <name>   e.g. /model ${presets[0]?.id.split("/").pop()}\n`);
  return out;
}

function showProviders(state: SessionState): string {
  let out = `\n${chalk.bold.cyan("  Providers")}\n\n`;
  for (const [id, meta] of Object.entries(PROVIDER_REGISTRY)) {
    const active = id === state.providerId ? chalk.green(" ●") : "  ";
    const keys = (state.config.keys as Record<string, string | undefined>) ?? {};
    const hasKey = !!keys[id];
    const keyStatus = hasKey ? chalk.green("key ✓") : chalk.red("no key");
    out += `  ${active} ${chalk.bold(meta.name)}  ${chalk.dim(keyStatus)}\n`;
    out += `      ${chalk.dim(meta.description)}\n`;
  }
  out += `\n  ${chalk.dim("Switch: /provider <name>   Add key: /key <***>")}\n`;
  return out;
}

function showTools(): string {
  let out = `\n${chalk.bold.cyan("  Tools")}\n\n`;
  for (const t of TOOL_DEFS) {
    out += `  ${chalk.bold(t.name)}  ${chalk.dim(t.description.slice(0, 80))}\n`;
  }
  return out + "\n";
}

function showHelp(): string {
  return `
${chalk.bold.cyan("  ArxCode CLI — v0.2.0")}  ${chalk.dim("Private AI builder · BYOK · 15 tools · 25 commands")}

  ${chalk.bold.yellow("▸ Session")}
  ${chalk.bold("/model")} [name]     Show or switch model
  ${chalk.bold("/provider")} [name]  Show or switch provider (${Object.keys(PROVIDER_REGISTRY).join(", ")})
  ${chalk.bold("/temp")} [0-2]      Show or set temperature (0=deterministic, 1=balanced, 2=creative)
  ${chalk.bold("/stream")} [on|off]  Toggle streaming mode
  ${chalk.bold("/config")}          Show current configuration
  ${chalk.bold("/session")}         Show session info
  ${chalk.bold("/key")} <***>       Set API key for current provider
  ${chalk.bold("/clear")}           Start a new session (clear history)

  ${chalk.bold.yellow("▸ Context")}
  ${chalk.bold("/project")} [dir]   Show or change project directory
  ${chalk.bold("/reload")}          Re-scan project context files (AGENTS.md etc)
  ${chalk.bold("/compact")} [instr] Compress conversation context (saves tokens)
  ${chalk.bold("/tools")}           List available agent tools

  ${chalk.bold.yellow("▸ Files")}
  ${chalk.bold("/find")} <pattern>  Find files by name glob (e.g. /find *.ts)
  ${chalk.bold("/save")} <name>     Save current session
  ${chalk.bold("/load")} <name>     Load a saved session
  ${chalk.bold("/sessions")}        List saved sessions
  ${chalk.bold("/export")} [path]   Export conversation to markdown

  ${chalk.bold.yellow("▸ Git")}
  ${chalk.bold("/diff")} [target]   View git diff (unstaged, staged, branch, commit)
  ${chalk.bold("/status")}          Git working tree status
  ${chalk.bold("/log")} [n]         Recent git commits (default: 10)
  ${chalk.bold("/review")} [target] Code review — diff, staged, branch, commit
  ${chalk.bold("/commit")} [--amend] AI generate commit message

  ${chalk.bold.yellow("▸ Web3")}
  ${chalk.bold("/wallet")} [chain]  Generate crypto wallet (evm, solana)
  ${chalk.bold("/balance")} <c> <a> Check wallet balance (e.g. /balance ethereum 0x...)
  ${chalk.bold("/search")} <query>  Search the web via Whoogle

  ${chalk.bold.yellow("▸ Shell")}
  ${chalk.bold("!command")}          Run shell command and send output to agent
  ${chalk.bold("!!command")}         Run shell command (don't send to agent)
  ${chalk.bold("@path/file")}        Reference a file — injects contents into the prompt
  ${chalk.bold("line\\\\")}              End a line with \\\\ for multi-line input

  ${chalk.bold("/help")}            Show this help
  ${chalk.bold("/quit")}            Exit
  ${chalk.dim("Tab")}                Auto-complete commands, models, providers, @paths
`;
}

function showSession(state: SessionState): string {
  const temp = state.temperature != null ? state.temperature.toFixed(1) : "default";
  return `
${chalk.bold.cyan("  Session")}
  Provider : ${chalk.bold(state.providerId)}
  Model    : ${chalk.bold(state.model)}
  Project  : ${chalk.dim(state.projectRoot)}
  Max steps: ${state.maxSteps}
  Temp     : ${temp}
  API Key  : ${state.apiKey ? chalk.green("✓") : chalk.red("✗ MISSING")}
`;
}

function findModel(provider: string, query: string): string | null {
  const presets = MODEL_PRESETS[provider] || [];
  const q = query.toLowerCase();

  // Exact match on id
  for (const p of presets) {
    if (p.id.toLowerCase() === q) return p.id;
  }
  // Match on name
  for (const p of presets) {
    if (p.name.toLowerCase().includes(q)) return p.id;
  }
  // Partial match on id
  for (const p of presets) {
    if (p.id.toLowerCase().includes(q)) return p.id;
  }
  return null;
}

// ── Session Save/Load ──────────────────────────────────────────────

const SESSIONS_DIR = path.join(os.homedir(), ".arx_sessions");

interface SavedSession {
  name: string;
  providerId: string;
  model: string;
  projectRoot: string;
  temperature?: number;
  conversation: import("./llm/types.js").AgentMessage[];
  savedAt: string;
}

function ensureSessionsDir(): void {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

function saveSession(name: string, state: SessionState): string {
  ensureSessionsDir();
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const file = path.join(SESSIONS_DIR, `${safeName}.json`);

  const session: SavedSession = {
    name: safeName,
    providerId: state.providerId,
    model: state.model,
    projectRoot: state.projectRoot,
    temperature: state.temperature,
    conversation: state.conversation ?? [],
    savedAt: new Date().toISOString(),
  };

  try {
    fs.writeFileSync(file, JSON.stringify(session, null, 2));
    return chalk.green(`\n  ✓ Session saved: ${chalk.bold(safeName)} (${session.conversation.length} messages)\n  ${chalk.dim(file)}\n`);
  } catch (err) {
    return chalk.red(`\n  ✗ Failed to save: ${err instanceof Error ? err.message : err}\n`);
  }
}

function loadSession(name: string, state: SessionState): string {
  ensureSessionsDir();
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const file = path.join(SESSIONS_DIR, `${safeName}.json`);

  if (!fs.existsSync(file)) {
    return chalk.red(`\n  ✗ Session "${safeName}" not found.\n  Use /sessions to list saved sessions.\n`);
  }

  try {
    const raw = fs.readFileSync(file, "utf-8");
    const session: SavedSession = JSON.parse(raw);

    state.providerId = session.providerId as ProviderId;
    state.model = session.model;
    state.projectRoot = session.projectRoot;
    state.temperature = session.temperature;
    state.conversation = session.conversation;
    state.config.provider = session.providerId as ProviderId;
    state.config.model = session.model;
    state.clearHistory = false;

    // Re-load context files for the loaded project
    state.contextFiles = loadContextFiles(session.projectRoot);

    return chalk.green(
      `\n  ✓ Loaded: ${chalk.bold(safeName)}\n` +
      `  Provider: ${session.providerId}  |  Model: ${session.model}\n` +
      `  Messages: ${session.conversation.length}  |  Saved: ${new Date(session.savedAt).toLocaleString()}\n` +
      chalk.dim(`  Continue your conversation...\n`)
    );
  } catch (err) {
    return chalk.red(`\n  ✗ Failed to load: ${err instanceof Error ? err.message : err}\n`);
  }
}

function listSessions(): string {
  ensureSessionsDir();
  const files = fs.readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith(".json"))
    .sort();

  if (!files.length) {
    return chalk.dim("\n  No saved sessions. Use /save <name> to save.\n");
  }

  let out = `\n${chalk.bold.cyan("  Saved Sessions")}\n\n`;
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(SESSIONS_DIR, file), "utf-8");
      const s: SavedSession = JSON.parse(raw);
      const date = new Date(s.savedAt).toLocaleDateString();
      out += `  ${chalk.bold(s.name.padEnd(20))} ${chalk.dim(s.providerId.padEnd(15))} ${s.conversation.length} msgs  ${date}\n`;
    } catch {
      out += `  ${chalk.dim(file.replace(".json", ""))} ${chalk.red("(corrupt)")}\n`;
    }
  }
  out += `\n  ${chalk.dim("Load: /load <name>")}\n`;
  return out;
}

// ── Code Review ────────────────────────────────────────────────────

const REVIEW_MAX_DIFF = 300_000; // 300KB limit

function handleReview(target: string, state: SessionState): string {
  const projectRoot = state.projectRoot;

  // Determine the diff source
  let diff: string;
  let label: string;

  try {
    if (!target || target === "unstaged") {
      // Unstaged changes
      diff = execGit(projectRoot, ["diff", "--", "."]);
      label = "unstaged changes";
    } else if (target === "staged" || target === "cached") {
      // Staged changes
      diff = execGit(projectRoot, ["diff", "--cached", "--", "."]);
      label = "staged changes";
    } else if (target.includes("..") || target.includes("...")) {
      // Commit range: HEAD~3..HEAD or main...feature
      diff = execGit(projectRoot, ["diff", target]);
      label = `diff ${target}`;
    } else if (fs.existsSync(path.resolve(projectRoot, target))) {
      // Specific file
      diff = execGit(projectRoot, ["diff", "--", target]);
      label = `diff ${target}`;
    } else if (target.match(/^[a-f0-9]{7,40}$/)) {
      // Looks like a commit SHA
      diff = execGit(projectRoot, ["show", "--format=", target]);
      label = `commit ${target.slice(0, 7)}`;
    } else {
      // Assume branch name
      diff = execGit(projectRoot, ["diff", target, "--", "."]);
      label = `diff vs ${target}`;
    }
  } catch (err) {
    return chalk.red(`\n  ✗ Git error: ${err instanceof Error ? err.message : err}\n  Make sure you're in a git repo.\n`);
  }

  if (!diff.trim()) {
    return chalk.yellow(`\n  ⚠ No changes to review (${label}).\n`);
  }

  // Truncate huge diffs
  if (diff.length > REVIEW_MAX_DIFF) {
    diff = diff.slice(0, REVIEW_MAX_DIFF);
    diff += `\n\n... (truncated to 300KB — original was larger)`;
  }

  // Build review prompt
  const reviewPrompt = buildReviewPrompt(diff, label, projectRoot);

  // Set as pending review — will be processed by bin/arx.ts
  state.reviewPrompt = reviewPrompt;

  const lines = diff.split("\n").length;
  const files = [...new Set(
    diff.split("\n")
      .filter(l => l.startsWith("diff --git"))
      .map(l => l.split(" b/")[1])
  )];

  return chalk.cyan(
    `\n  🔍 Reviewing ${chalk.bold(label)}: ${files.length} file(s), ${lines} lines\n` +
    chalk.dim(`  Send your next prompt → agent will review the changes.\n`)
  );
}

function execGit(cwd: string, args: string[]): string {
  try {
    const result = cp.execSync(
      `git ${args.map(a => a.includes(" ") ? `"${a}"` : a).join(" ")}`,
      { cwd, timeout: 10_000, encoding: "utf-8", maxBuffer: 500_000, stdio: ["pipe", "pipe", "pipe"] }
    );
    return result;
  } catch (err: any) {
    // git diff returns exit 1 for binary files, but still has output
    if (err.stdout) return err.stdout;
    throw err;
  }
}

function buildReviewPrompt(diff: string, label: string, projectRoot: string): string {
  const contextFiles = loadContextFiles(projectRoot);
  const contextSection = contextFiles.length > 0
    ? `\n\nProject context files have been loaded (${contextFiles.map(f => f.name).join(", ")}). Use these for convention/style reference.`
    : "";

  return `## CODE REVIEW

Review the following git diff (${label}). Be thorough and concise.

### Review checklist:
1. **Bugs & Logic** — edge cases, null checks, off-by-one, race conditions
2. **Security** — injection, unsafe eval, secret leaks, path traversal
3. **Performance** — N+1 queries, unnecessary allocations, sync blocking
4. **Style & Conventions** — naming, consistency with project patterns
5. **Architecture** — coupling, single responsibility, dependency direction
6. **Tests** — missing edge cases, testability concerns

### Format your response as:
**[VERDICT]** 🔴 Block / 🟡 Approve with comments / 🟢 LGTM

**Critical** (must fix):
- item

**Issues** (should fix):
- item

**Nits** (nice to have):
- item

**Summary**: 1-2 sentence verdict.

Be constructive, not pedantic. Focus on things that actually matter.${contextSection}

\`\`\`diff
${diff}
\`\`\``;
}

// ── Commit Message Generator ───────────────────────────────────────

function handleCommit(arg: string, state: SessionState): string {
  const projectRoot = state.projectRoot;
  const isAmend = arg === "--amend" || arg === "-a";
  const amendFlag = isAmend ? " --amend" : "";

  let diff: string;
  let label: string;

  try {
    // Get staged diff
    diff = execGit(projectRoot, ["diff", "--cached", "--", "."]);
    label = "staged changes";
    
    // If nothing staged, check if --amend was requested (use last commit)
    if (!diff.trim() && isAmend) {
      diff = execGit(projectRoot, ["show", "--format=", "HEAD"]);
      label = "last commit (amend)";
    }
  } catch (err) {
    return chalk.red(`\n  ✗ Git error: ${err instanceof Error ? err.message : err}\n`);
  }

  if (!diff.trim()) {
    return chalk.yellow(
      `\n  ⚠ No staged changes. Stage files with \`git add\` first.\n` +
      `  Use \`/commit --amend\` to revise the last commit message.\n`
    );
  }

  if (diff.length > 50000) {
    diff = diff.slice(0, 50000) + `\n\n... (truncated to 50KB)`;
  }

  const stats = execGit(projectRoot, ["diff", "--cached", "--stat", "--", "."]).slice(0, 500);

  const commitPrompt = `## GENERATE COMMIT MESSAGE

Generate a concise, conventional commit message for these staged changes${amendFlag}.

### Rules:
- Use conventional commits format: **type(scope): description**
- Types: feat, fix, chore, docs, refactor, test, perf, style
- Keep the subject line under 72 characters
- Add bullet points in the body for significant changes
- Be specific — mention files/modules affected
- Output ONLY the commit message, nothing else

### Changed files:
${stats}

\`\`\`diff
${diff}
\`\`\``;

  state.commitPrompt = commitPrompt;

  const files = [...new Set(
    diff.split("\n")
      .filter(l => l.startsWith("diff --git"))
      .map(l => l.split(" b/")[1])
  )];

  return chalk.magenta(
    `\n  📝 Generating commit message for ${files.length} file(s)...\n` +
    chalk.dim(`  Use \`/commit --amend\` for last commit revision.\n`)
  );
}

// ── Export Conversation ────────────────────────────────────────────

function exportConversation(filePath: string | undefined, state: SessionState): string {
  if (!state.conversation || state.conversation.length === 0) {
    return chalk.yellow("\n  ⚠ No conversation to export.\n");
  }

  const now = new Date();
  const dateStr = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const defaultName = `arx-session-${dateStr}.md`;
  const exportPath = filePath
    ? path.isAbsolute(filePath) ? filePath : path.resolve(state.projectRoot, filePath)
    : path.resolve(state.projectRoot, defaultName);

  try {
    let md = `# ArxCode Session Export\n\n`;
    md += `- **Date**: ${now.toLocaleString()}\n`;
    md += `- **Provider**: ${state.providerId}\n`;
    md += `- **Model**: ${state.model || "default"}\n`;
    md += `- **Project**: ${state.projectRoot}\n`;
    md += `- **Messages**: ${state.conversation.length}\n`;
    md += `\n---\n\n`;

    for (let i = 0; i < state.conversation.length; i++) {
      const m = state.conversation[i];
      const role = m.role === "user" ? "🧑 **You**" : "🤖 **ArxCode**";
      md += `### ${role}\n\n`;

      for (const block of m.content) {
        if (block.type === "text" && block.text) {
          md += block.text + "\n\n";
        } else if (block.type === "tool_use") {
          md += `> 🔧 Tool: \`${block.name}\` — \`${JSON.stringify(block.input).slice(0, 200)}\`\n\n`;
        } else if (block.type === "tool_result") {
          const label = block.is_error ? "❌" : "✓";
          const content = block.content.slice(0, 500);
          md += `> ${label} Result: ${content}\n\n`;
        }
      }

      if (i < state.conversation.length - 1) {
        md += `---\n\n`;
      }
    }

    fs.writeFileSync(exportPath, md, "utf-8");

    return chalk.green(
      `\n  ✓ Exported ${state.conversation.length} messages\n` +
      `  ${chalk.dim(exportPath)}\n`
    );
  } catch (err) {
    return chalk.red(`\n  ✗ Export failed: ${err instanceof Error ? err.message : err}\n`);
  }
}

// ── Web Search ─────────────────────────────────────────────────────

function searchWeb(query: string): string {
  // Use fetch synchronously via a sync wrapper — we call this from a sync handler
  // The REPL will show "Searching..." and then display results when ready
  const url = `http://127.0.0.1:50997/search?q=${encodeURIComponent(query)}&format=json`;

  try {
    // Use execSync with curl to avoid async issues in the sync command handler
    const raw = cp.execSync(
      `curl -s --max-time 8 "${url}"`,
      { timeout: 10_000, encoding: "utf-8", maxBuffer: 500_000 }
    );
    const data = JSON.parse(raw) as { results?: Array<{ title: string; href: string; text: string }> };
    const results = data.results || [];

    if (!results.length) {
      return chalk.yellow(`\n  No results for "${query}".\n`);
    }

    let out = `\n${chalk.bold.cyan("  Web Search")}  ${chalk.dim(`"${query}"`)}\n\n`;
    for (let i = 0; i < Math.min(results.length, 8); i++) {
      const r = results[i];
      out += `  ${chalk.bold(String(i + 1))}. ${chalk.bold(r.title)}\n`;
      out += `     ${chalk.dim.underline(r.href)}\n`;
      out += `     ${r.text.slice(0, 200)}\n\n`;
    }
    out += chalk.dim(`  Powered by Whoogle\n`);
    return out;
  } catch (err: any) {
    return chalk.red(`\n  ✗ Search failed: ${err.message || err}\n  Is Whoogle running? (port 50997)\n`);
  }
}

// ── Git Diff Viewer ─────────────────────────────────────────────────

function showDiff(target: string, state: SessionState): string {
  const projectRoot = state.projectRoot;
  const args: string[] = [];
  let label: string;

  if (!target || target === "unstaged") {
    args.push("diff", "--", ".");
    label = "unstaged changes";
  } else if (target === "staged" || target === "cached") {
    args.push("diff", "--cached", "--", ".");
    label = "staged changes";
  } else if (target.includes("..") || target.includes("...")) {
    args.push("diff", target);
    label = `diff ${target}`;
  } else if (target.match(/^[a-f0-9]{7,40}$/)) {
    args.push("show", "--format=", target);
    label = `commit ${target.slice(0, 7)}`;
  } else {
    args.push("diff", target, "--", ".");
    label = `diff vs ${target}`;
  }

  try {
    const diff = execGit(projectRoot, args);
    if (!diff.trim()) {
      return chalk.yellow(`\n  ⚠ No changes (${label}).\n`);
    }

    // Colorize diff output
    const lines = diff.split("\n");
    let colored = "";
    let added = 0;
    let removed = 0;

    for (const line of lines.slice(0, 300)) { // limit to 300 lines
      if (line.startsWith("+") && !line.startsWith("+++")) {
        colored += chalk.green(line) + "\n";
        added++;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        colored += chalk.red(line) + "\n";
        removed++;
      } else if (line.startsWith("@@")) {
        colored += chalk.cyan(line) + "\n";
      } else {
        colored += chalk.dim(line) + "\n";
      }
    }

    if (lines.length > 300) {
      colored += chalk.dim(`\n... (${lines.length - 300} more lines)`);
    }

    const files = [...new Set(
      diff.split("\n")
        .filter(l => l.startsWith("diff --git"))
        .map(l => l.split(" b/")[1])
    )];

    return `\n${chalk.bold.cyan(`  Diff: ${label}`)}  ${chalk.green(`+${added}`)} ${chalk.red(`-${removed}`)}  ${chalk.dim(`${files.length} file(s)`)}\n\n${colored}\n`;
  } catch (err: any) {
    return chalk.red(`\n  ✗ Git error: ${err.message || err}\n`);
  }
}

// ── Git Status ──────────────────────────────────────────────────────

function showGitStatus(state: SessionState): string {
  try {
    const output = execGit(state.projectRoot, ["status", "--short"]);
    if (!output.trim()) {
      return chalk.green("\n  ✓ Working tree clean. Nothing to commit.\n");
    }
    // Colorize status codes
    const lines = output.split("\n").filter(Boolean);
    let colored = `\n${chalk.bold.cyan("  Git Status")}\n\n`;
    for (const line of lines.slice(0, 40)) {
      const status = line.slice(0, 2);
      const file = line.slice(3);
      // Color by status type
      if (status.includes("M") || status.includes("A")) colored += `  ${chalk.yellow(status)} ${file}\n`;
      else if (status.includes("D")) colored += `  ${chalk.red(status)} ${chalk.red(file)}\n`;
      else if (status.includes("?")) colored += `  ${chalk.dim(status)} ${chalk.dim(file)}\n`;
      else if (status.includes("R")) colored += `  ${chalk.magenta(status)} ${file}\n`;
      else colored += `  ${status} ${file}\n`;
    }
    if (lines.length > 40) colored += chalk.dim(`  ... and ${lines.length - 40} more\n`);
    return colored + "\n";
  } catch (err: any) {
    return chalk.red(`\n  ✗ Git error: ${err.message || err}\n`);
  }
}

// ── Git Log ─────────────────────────────────────────────────────────

function showGitLog(count: number, state: SessionState): string {
  try {
    const output = execGit(state.projectRoot, ["log", `-${count}`, "--oneline", "--decorate"]);
    if (!output.trim()) return chalk.yellow("\n  No commits yet.\n");
    const lines = output.split("\n").filter(Boolean);
    let colored = `\n${chalk.bold.cyan(`  Git Log (last ${lines.length})`)}\n\n`;
    for (const line of lines) {
      // Color: SHA in yellow, refs in cyan, message white
      const match = line.match(/^([a-f0-9]+)\s(.*)$/);
      if (match) {
        colored += `  ${chalk.yellow(match[1])} ${match[2]}\n`;
      } else {
        colored += `  ${line}\n`;
      }
    }
    return colored + "\n";
  } catch (err: any) {
    return chalk.red(`\n  ✗ Git error: ${err.message || err}\n`);
  }
}

// ── Find Files ──────────────────────────────────────────────────────

function findFiles(pattern: string, state: SessionState): string {
  try {
    const files = glob.sync(pattern, {
      cwd: state.projectRoot,
      nodir: true,
      ignore: ["node_modules/**", ".git/**", "dist/**", "build/**", "*.lock"],
    });
    if (!files.length) {
      return chalk.yellow(`\n  No files matching "${pattern}".\n`);
    }
    const sorted = files.sort().slice(0, 40);
    let out = `\n${chalk.bold.cyan(`  Find: ${pattern}`)}  ${chalk.dim(`${files.length} file(s)`)}\n\n`;
    // Group by directory
    let currentDir = "";
    for (const f of sorted) {
      const dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ".";
      if (dir !== currentDir) {
        currentDir = dir;
        out += `  ${chalk.dim(`${dir}/`)}\n`;
      }
      const name = f.includes("/") ? f.slice(f.lastIndexOf("/") + 1) : f;
      out += `    ${name}\n`;
    }
    if (files.length > 40) out += chalk.dim(`  ... and ${files.length - 40} more\n`);
    return out + "\n";
  } catch (err: any) {
    return chalk.red(`\n  ✗ Find error: ${err.message || err}\n`);
  }
}

// ── Wallet CLI ──────────────────────────────────────────────────────

function generateWalletCli(chain: string): string {
  const c = chain.toLowerCase();
  if (c !== "evm" && c !== "solana") {
    return chalk.red(`\n  ✗ Unknown chain: ${chain}. Use: evm or solana\n`);
  }

  if (c === "solana") {
    const seed = crypto.randomBytes(32);
    // Derive Solana keypair using ed25519
    const kp = crypto.generateKeyPairSync("ed25519");
    const pubKey = kp.publicKey.export({ type: "spki", format: "der" });
    const pubRaw = pubKey.slice(pubRawLen(pubKey));
    const address = bs58EncodeCmd(pubRaw);
    return `
${chalk.bold.green("  🔑 Solana Wallet Generated")}

  ${chalk.dim("Address:    ")} ${chalk.bold(address)}
  ${chalk.dim("Secret Key: ")} [${seed.toString("hex").slice(0, 16)}...] (64 bytes)
  ${chalk.dim("Network:    ")} Solana

  ${chalk.yellow("⚠️  Save your secret key. Never share it.")}
`;
  }

  // EVM
  const pk = crypto.randomBytes(32);
  const ecdh = crypto.createECDH("secp256k1");
  ecdh.setPrivateKey(pk);
  const pubKey = ecdh.getPublicKey(undefined, "uncompressed");
  const pubNoPrefix = pubKey.slice(1);
  const hash = crypto.createHash("sha256").update(pubNoPrefix).digest();
  const address = hash.slice(-20).toString("hex");
  const pkHex = pk.toString("hex");

  return `
${chalk.bold.green("  🔑 EVM Wallet Generated")}

  ${chalk.dim("Address:      ")} ${chalk.bold("0x" + address)}
  ${chalk.dim("Private Key:  ")} 0x${pkHex.slice(0, 8)}...${pkHex.slice(-8)}
  ${chalk.dim("Full PK:      ")} ${chalk.red("0x" + pkHex)}  ${chalk.dim("← save securely!")}
  ${chalk.dim("Networks:     ")} Ethereum, BSC, Polygon, Arbitrum, Base, + any EVM

  ${chalk.yellow("⚠️  Anyone with the private key controls this wallet.")}
`;
}

function checkBalanceCli(chain: string, address: string): string {
  const rpcs: Record<string, { url: string; symbol: string }> = {
    ethereum: { url: "https://ethereum-rpc.publicnode.com", symbol: "ETH" },
    bsc: { url: "https://bsc-rpc.publicnode.com", symbol: "BNB" },
    polygon: { url: "https://polygon-bor-rpc.publicnode.com", symbol: "MATIC" },
    arbitrum: { url: "https://arbitrum-one-rpc.publicnode.com", symbol: "ETH" },
    base: { url: "https://base-rpc.publicnode.com", symbol: "ETH" },
    solana: { url: "https://api.mainnet-beta.solana.com", symbol: "SOL" },
  };

  const rpc = rpcs[chain.toLowerCase()];
  if (!rpc) {
    return chalk.red(`\n  ✗ Unknown chain: ${chain}. Supported: ${Object.keys(rpcs).join(", ")}\n`);
  }

  try {
    const isSolana = chain === "solana";
    const body = isSolana
      ? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [address] })
      : JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] });

    const raw = cp.execSync(
      `curl -s --max-time 8 -X POST -H "Content-Type: application/json" -d '${body.replace(/'/g, "'\\''")}' "${rpc.url}"`,
      { timeout: 10_000, encoding: "utf-8", maxBuffer: 100_000 }
    );

    const data = JSON.parse(raw);
    if (data.error) {
      return chalk.red(`\n  ✗ RPC error: ${data.error.message}\n`);
    }

    if (isSolana) {
      const sol = (data.result?.value ?? 0) / 1_000_000_000;
      return `\n  ${chalk.bold.green("💰 Balance")}\n\n  Address: ${chalk.dim(address)}\n  Balance: ${chalk.bold(sol.toFixed(4))} ${rpc.symbol}\n`;
    }

    const wei = BigInt(data.result || "0x0");
    const balance = Number(wei) / 1e18;
    return `\n  ${chalk.bold.green("💰 Balance")}\n\n  Address: ${chalk.dim(address)}\n  Balance: ${chalk.bold(balance.toFixed(6))} ${rpc.symbol}\n`;
  } catch (err: any) {
    return chalk.red(`\n  ✗ Balance check failed: ${err.message || err}\n`);
  }
}

function pubRawLen(spkiDer: Buffer): number {
  // SPKI DER for Ed25519: 32-byte public key is at a fixed offset
  // 302a 3005 0603 2b65 7003 2100 <32 bytes>
  return 32; // last 32 bytes are the raw key
}

function bs58EncodeCmd(data: Buffer): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits = [0];
  for (const byte of data) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] * 256;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let encoded = "";
  for (const byte of data) {
    if (byte !== 0) break;
    encoded += ALPHABET[0];
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    encoded += ALPHABET[digits[i]];
  }
  return encoded;
}

// ── Alias System ────────────────────────────────────────────────────

const ALIAS_FILE = path.join(os.homedir(), ".arx_aliases.json");

interface Aliases {
  [name: string]: string;
}

function loadAliases(): Aliases {
  try {
    if (fs.existsSync(ALIAS_FILE)) {
      return JSON.parse(fs.readFileSync(ALIAS_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function saveAliases(aliases: Aliases): void {
  fs.writeFileSync(ALIAS_FILE, JSON.stringify(aliases, null, 2));
}

function handleAlias(rest: string, _state: SessionState): string {
  const aliases = loadAliases();

  // /alias — list all
  if (!rest) {
    const names = Object.keys(aliases);
    if (!names.length) return chalk.dim("\n  No aliases. Create: /alias <name> <prompt>\n");
    let out = `\n${chalk.bold.cyan("  Aliases")}\n\n`;
    for (const [name, prompt] of Object.entries(aliases)) {
      out += `  ${chalk.bold(name)}  →  ${chalk.dim(prompt.slice(0, 80))}\n`;
    }
    out += `\n  ${chalk.dim("Use: /alias <name>  |  Delete: /alias <name> --delete")}\n`;
    return out;
  }

  const parts = rest.split(/\s+/);
  const name = parts[0];

  // /alias <name> --delete
  if (parts[1] === "--delete" || parts[1] === "-d") {
    if (!aliases[name]) return chalk.red(`\n  ✗ Alias "${name}" not found.\n`);
    delete aliases[name];
    saveAliases(aliases);
    return chalk.green(`\n  ✓ Deleted alias: ${name}\n`);
  }

  // /alias <name> <prompt>
  if (parts.length >= 2) {
    const prompt = parts.slice(1).join(" ");
    aliases[name] = prompt;
    saveAliases(aliases);
    return chalk.green(`\n  ✓ Alias saved: ${chalk.bold(name)} → ${chalk.dim(prompt.slice(0, 60))}\n`);
  }

  // /alias <name> — show
  if (aliases[name]) {
    return `\n  ${chalk.bold(name)}  →  ${aliases[name]}\n`;
  }
  return chalk.red(`\n  ✗ Alias "${name}" not found.\n`);
}

/**
 * Expand alias if the input matches a known alias name.
 * Called from bin/arx.ts before sending to agent.
 */
export function expandAlias(input: string): string {
  const trimmed = input.trim();
  const aliases = loadAliases();
  // Check exact match first
  if (aliases[trimmed]) return aliases[trimmed];
  // Check if starts with alias name + space
  for (const [name, prompt] of Object.entries(aliases)) {
    if (trimmed.startsWith(name + " ")) {
      return prompt + " " + trimmed.slice(name.length + 1);
    }
  }
  return input;
}

// ── Setup Wizard ────────────────────────────────────────────────────

function setupWizard(state: SessionState): string {
  let out = `\n${chalk.bold.cyan("  ArxCode CLI Setup")}\n\n`;

  // Current config
  out += `${chalk.yellow("▸ Current")}\n`;
  out += `  Provider : ${chalk.bold(state.providerId)}\n`;
  out += `  Model    : ${chalk.bold(state.model || "(default)")}\n`;
  out += `  API Key  : ${state.apiKey ? chalk.green("set") : chalk.red("missing")}\n\n`;

  // Providers
  out += `${chalk.yellow("▸ Providers")}  ${chalk.dim("/provider <name> to switch")}\n\n`;
  for (const [id, meta] of Object.entries(PROVIDER_REGISTRY)) {
    const keys = (state.config.keys as Record<string, string | undefined>) ?? {};
    const hasKey = !!keys[id];
    const marker = id === state.providerId ? chalk.green("●") : " ";
    const keyStatus = hasKey ? chalk.green("key ✓") : chalk.dim("no key");
    out += `  ${marker} ${chalk.bold(meta.name.padEnd(20))} ${keyStatus}  ${chalk.dim("/provider " + id)}\n`;
  }

  out += `\n${chalk.yellow("▸ Quick Start")}\n`;
  out += `  1. Set API key:  ${chalk.bold("/key sk-...")}\n`;
  out += `  2. Pick provider: ${chalk.bold("/provider groq")} (free!) or ${chalk.bold("/provider deepseek")} (cheap)\n`;
  out += `  3. Pick model:    ${chalk.bold("/model llama-4-scout")}\n`;
  out += `  4. Start coding:  ${chalk.dim("just type your prompt")}\n`;

  out += `\n${chalk.yellow("▸ Env Vars")}\n`;
  out += `  Copy ${chalk.bold(".env.example")} → ${chalk.bold(".env")} and fill in your keys.\n`;
  out += `  Or set per-provider: GROQ_API_KEY, DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, etc.\n`;

  out += `\n${chalk.dim("  Type /help for all commands, /tools for agent tools.\n")}`;
  return out;
}
