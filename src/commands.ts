/**
 * Slash command registry for ArxCode CLI.
 * All commands are resolved here at runtime.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as cp from "node:child_process";
import * as crypto from "node:crypto";
import * as readline from "node:readline";
import chalk from "chalk";
import type { ArxConfig, ProviderId } from "./config.js";
import { loadConfig, resolveProviderConfig, configStatus, saveConfig } from "./config.js";
import { TOOL_DEFS } from "./tools.js";
import { PROVIDER_REGISTRY } from "./llm/types.js";
import { loadContextFiles } from "./context.js";
import { glob } from "glob";
import YAML from "yaml";
import { loadHooks, type Hook, type HookEvent } from "./hooks.js";
import { loadSkills, getGlobalSkillsDir, getProjectSkillsDir, createExampleSkill, formatSkillContext, type Skill } from "./skills.js";
import { formatMcpStatus, loadMcpServersFromConfig, connectAllServers, disconnectAll, formatMcpPresets, MCP_PRESETS, applyMcpPreset } from "./mcp.js";
import {
  connectRemote, disconnectRemote, getActiveSession, getActiveTransport,
  loadRemoteConfig, saveRemoteConfig, remoteStatus, parseConnectionString,
  type RemoteConfig, type RemoteSession, type RemoteTransport,
} from "./remote.js";
import {
  loadRecipes, getRecipe, substituteVars, resolveVars,
  formatRecipeList, formatRecipeShow, createRecipeFile, deleteRecipe, initBuiltinRecipes,
  type Recipe,
} from "./recipes.js";
import {
  PROVIDER_PRICING, estimateCost, estimatePreCost,
  formatCostBreakdown, getPricingInfo, EFFORT_PRESETS,
  type EffortLevel, type EffortConfig,
} from "./pricing.js";

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
  "/tokens", "/effort", "/hook",
  "/skill",
  "/mcp",
  "/remote",
  "/recipe",
  "/version",
  "/mode",
  "/context", "/tree",
  "/docs",
  "/explain",
  "/plan",
  "/init",
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
  /** Cumulative token tracking for /tokens command */
  totalInputTokens?: number;
  totalOutputTokens?: number;
  /** Remote SSH agent config */
  remoteConfig?: RemoteConfig;
  /** Active remote transport (non-null when connected) */
  remoteTransport?: RemoteTransport;
  /** Pending MCP action executed by bin/arx.ts on next prompt */
  mcpPending?: "connect" | "disconnect";
  /** Fully-resolved recipe prompt ready to send to the agent */
  recipePrompt?: string;
  /** Pending recipe run — waiting for missing required vars from the user */
  recipePending?: { name: string; values: Record<string, string>; missing: string[] };
  /** Effort level for the agent (min/normal/max) */
  effort?: EffortLevel;
  /** Agent mode: "auto" (default), "plan" (plan only), "act" (execute only) */
  agentMode?: "auto" | "plan" | "act";
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
    // Case-insensitive lookup
    const argLower = arg.toLowerCase();
    const providerId = Object.keys(PROVIDER_REGISTRY).find(
      k => k.toLowerCase() === argLower
    ) as ProviderId | undefined;
    if (!providerId) {
      const valid = Object.keys(PROVIDER_REGISTRY).join(", ");
      return chalk.red(`\n  ✗ Unknown provider: ${arg}. Valid: ${valid}\n`);
    }
    const meta = PROVIDER_REGISTRY[providerId];
    state.providerId = providerId;
    state.config.provider = providerId;
    // Auto-pick first model for new provider
    state.model = MODEL_PRESETS[providerId]?.[0]?.id || meta.defaultModel;
    state.config.model = state.model;
    // Resolve key for new provider
    const keys = (state.config.keys as Record<string, string | undefined>) ?? {};
    const key = keys[providerId] || state.apiKey;
    if (key) state.apiKey = key;
    const hasKey = keys[providerId];

    // Persist config so keys survive restart
    state.config.provider = providerId;
    state.config.model = state.model;
    saveConfig(state.config);

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
    return chalk.dim("\n  see ya!\n");
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

  // /tokens — show token usage for current session
  if (trimmed === "/tokens") {
    return showTokens(state);
  }

  // /hook [name] — list hooks or disable/enable
  if (trimmed === "/hook" || trimmed.startsWith("/hook ")) {
    const arg = trimmed.slice(6).trim();
    return showHooks(state.projectRoot, arg);
  }

  // /skill [create|init|list] — manage skills
  if (trimmed === "/skill" || trimmed.startsWith("/skill ")) {
    const arg = trimmed.slice(7).trim();
    return handleSkill(arg, state);
  }

  // /mcp [list|add|config|disconnect|presets] — MCP server management
  if (trimmed === "/mcp" || trimmed.startsWith("/mcp ")) {
    const arg = trimmed.slice(5).trim();
    if (!arg || arg === "list" || arg === "status") {
      return formatMcpStatus();
    }
    if (arg === "presets" || arg === "available") {
      return formatMcpPresets();
    }
    if (arg.startsWith("add ")) {
      const name = arg.slice(4).trim().toLowerCase();
      return handleMcpAdd(name, state);
    }
    if (arg.startsWith("config ")) {
      const rest = arg.slice(7).trim();
      return handleMcpConfig(rest, state);
    }
    if (arg === "connect" || arg === "reload") {
      state.mcpPending = "connect";
      return chalk.cyan("\n  ⚡ MCP connect queued. Send your next prompt to initialize.\n");
    }
    if (arg === "disconnect" || arg === "off") {
      state.mcpPending = "disconnect";
      return chalk.yellow("\n  ⚡ MCP disconnect queued. Send your next prompt to disconnect.\n");
    }
    return chalk.red(`\n  ✗ Unknown: ${arg}. Use: /mcp list | /mcp add <name> | /mcp config <name> <key>=<val> | /mcp presets | /mcp connect | /mcp disconnect\n`);
  }

  // /recipe — manage and run prompt recipes
  if (trimmed === "/recipe" || trimmed.startsWith("/recipe ")) {
    const rest = trimmed.slice(8).trim();
    return handleRecipe(rest, state);
  }

  // /remote — connect/disconnect SSH remote agent
  if (trimmed === "/remote" || trimmed.startsWith("/remote ")) {
    const arg = trimmed.slice(8).trim();
    return handleRemote(arg, state);
  }

  // /version — show version info
  if (trimmed === "/version") {
    return showVersion();
  }

  // /mode — set agent mode (auto/plan/act)
  if (trimmed === "/mode" || trimmed.startsWith("/mode ")) {
    const arg = trimmed.slice(6).trim();
    return handleAgentMode(arg, state);
  }

  // /context — manage context files (add/remove/list)
  if (trimmed === "/context" || trimmed.startsWith("/context ")) {
    const arg = trimmed.slice(9).trim();
    return handleContext(arg, state);
  }

  // /tree — show visual project tree
  if (trimmed === "/tree" || trimmed.startsWith("/tree ")) {
    const arg = trimmed.slice(6).trim();
    return showProjectTree(arg, state);
  }

  // /docs — fetch documentation from web
  if (trimmed.startsWith("/docs ")) {
    const query = trimmed.slice(6).trim();
    if (!query) return chalk.red("\n  ✗ Usage: /docs <query>   e.g. /docs next.js app router\n");
    return fetchDocs(query);
  }

  // /explain — explain code in natural language
  if (trimmed.startsWith("/explain ")) {
    const target = trimmed.slice(9).trim();
    if (!target) return chalk.red("\n  ✗ Usage: /explain <path>   e.g. /explain src/harness.ts\n");
    return handleExplain(target, state);
  }

  // /plan — generate an implementation plan
  if (trimmed === "/plan" || trimmed.startsWith("/plan ")) {
    const arg = trimmed.slice(6).trim();
    return handlePlan(arg, state);
  }

  // /init — create project context files
  if (trimmed === "/init") {
    return initProject(state);
  }

  // /key — set API key (persists to ~/.arxrc.yaml)
  if (trimmed.startsWith("/key ")) {
    const key = trimmed.slice(5).trim();
    state.apiKey = key;
    state.config.apiKey = key;
    if (!state.config.keys) state.config.keys = {};
    state.config.keys[state.providerId] = key;
    saveConfig(state.config);
    return chalk.green(`\n  ✓ API key set for ${state.providerId} (saved)\n`);
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
${chalk.bold.cyan("  ArxCode CLI — v0.7.0")}  ${chalk.dim("Private AI coding agent · 16 tools · 41 commands")}

  ${chalk.bold.yellow("▸ Session")}
  ${chalk.bold("/model")} [name]     Show or switch model
  ${chalk.bold("/provider")} [name]  Show or switch provider (${Object.keys(PROVIDER_REGISTRY).join(", ")})
  ${chalk.bold("/mode")} [mode]     Set agent mode (auto|plan|act)
  ${chalk.bold("/temp")} [0-2]      Show or set temperature
  ${chalk.bold("/stream")} [on|off]  Toggle streaming mode
  ${chalk.bold("/config")}          Show / get / set configuration
  ${chalk.bold("/session")}         Show session info
  ${chalk.bold("/version")}         Show version info
  ${chalk.bold("/key")} <***>       Set API key for current provider
  ${chalk.bold("/effort")} [level]  Set agent effort (min|normal|max)
  ${chalk.bold("/clear")}           Start a new session (clear history)
  ${chalk.bold("/init")}            Initialize project context files

  ${chalk.bold.yellow("▸ Context")}
  ${chalk.bold("/project")} [dir]   Show or change project directory
  ${chalk.bold("/reload")}          Re-scan project context files (AGENTS.md etc)
  ${chalk.bold("/context")} <cmd>   Manage context files (add|remove|list)
  ${chalk.bold("/compact")} [instr] Compress conversation context (saves tokens)
  ${chalk.bold("/tokens")}          Show session token usage & cost estimate
  ${chalk.bold("/hook")}            List active hooks (guardrails)
  ${chalk.bold("/tools")}           List available agent tools
  ${chalk.bold("/tree")} [depth]    Show project tree (default: 2, max: 5)

  ${chalk.bold.yellow("▸ Files & Code")}
  ${chalk.bold("/find")} <pattern>  Find files by name glob
  ${chalk.bold("/save")} <name>     Save current session
  ${chalk.bold("/load")} <name>     Load a saved session
  ${chalk.bold("/sessions")}        List saved sessions
  ${chalk.bold("/export")} [path]   Export conversation to markdown
  ${chalk.bold("/explain")} <path>  Explain code in natural language
  ${chalk.bold("/plan")} <goal>     Generate an implementation plan
  ${chalk.bold("/docs")} <query>    Fetch documentation from web

  ${chalk.bold.yellow("▸ Git")}
  ${chalk.bold("/diff")} [target]   View git diff (unstaged, staged, branch, commit)
  ${chalk.bold("/status")}          Git working tree status
  ${chalk.bold("/log")} [n]         Recent git commits (default: 10)
  ${chalk.bold("/review")} [target] Code review — diff, staged, branch, commit
  ${chalk.bold("/commit")} [--amend] AI generate commit message

  ${chalk.bold.yellow("▸ Web3")}
  ${chalk.bold("/wallet")} [chain]  Generate crypto wallet (evm, solana)
  ${chalk.bold("/balance")} <c> <a> Check wallet balance
  ${chalk.bold("/search")} <query>  Search the web via Whoogle

  ${chalk.bold.yellow("▸ Shell")}
  ${chalk.bold("!command")}          Run shell command and send output to agent
  ${chalk.bold("!!command")}         Run shell command (don't send to agent)
  ${chalk.bold("@path/file")}        Reference a file — injects contents into the prompt
  ${chalk.bold("line\\\\")}           End a line with \\\\ for multi-line input

  ${chalk.bold("/help")}            Show this help
  ${chalk.bold("/quit")}            Exit
  ${chalk.dim("Tab")}                Auto-complete commands, models, providers, @paths
`;
}

// ── New Command Handlers (v0.7.0) ────────────────────────────────────

function showVersion(): string {
  return `
${chalk.bold.cyan("  ArxCode CLI")}  ${chalk.bold("v0.7.0")}
${chalk.dim("  Private AI coding agent · 16 tools · 41 commands")}

  ${chalk.yellow("▸ Features")}
  ${chalk.dim("  9 providers  ·  MCP client  ·  SSH remote  ·  Skills  ·  Recipes  ·  Hooks")}
  ${chalk.dim("  Agent modes  ·  Code review  ·  Token tracking  ·  Session save/load")}

  ${chalk.dim("  https://github.com/fanzru/arxcode-cli")}
`;
}

/** Agent mode: auto (default), plan (plan-only), act (execution-only) */
function handleAgentMode(arg: string, state: SessionState): string {
  if (!arg) {
    const current = state.agentMode || "auto";
    const desc: Record<string, string> = {
      auto: "Default — plan + act + verify loop",
      plan: "Plan only — generate a plan without executing it",
      act: "Execute only — skip planning, go straight to action",
    };
    return `
${chalk.bold.cyan("  Agent Mode")}

  ${chalk.green("●")} ${chalk.bold("auto")}     ${chalk.dim("— plan + act + observe + verify (default)")}
  ${chalk.dim("○")} ${chalk.bold("plan")}     ${chalk.dim("— plan only, no execution (use for design)")}
  ${chalk.dim("○")} ${chalk.bold("act")}      ${chalk.dim("— execute only, skip planning for quick fixes")}

  ${chalk.dim(`Current: ${chalk.bold(current)} — ${desc[current]}`)}
  ${chalk.dim("Switch: /mode plan | /mode act | /mode auto")}
`;
  }

  const mode = arg.toLowerCase() as "auto" | "plan" | "act";
  if (!["auto", "plan", "act"].includes(mode)) {
    return chalk.red(`\n  ✗ Invalid mode: "${arg}". Use: auto, plan, act\n`);
  }

  state.agentMode = mode;

  const label: Record<string, string> = {
    auto: "auto — plan + act + verify",
    plan: "plan — planning only, no execution",
    act: "act — execution only, skip planning",
  };

  const icon: Record<string, string> = { auto: "🤖", plan: "📋", act: "⚡" };
  return chalk.green(`\n  ${icon[mode]} Mode: ${chalk.bold(mode)} — ${label[mode]}\n`);
}

/** Context file management: /context add|remove|list <path> */
function handleContext(arg: string, state: SessionState): string {
  if (!arg || arg === "list") {
    const files = state.contextFiles || [];
    if (!files.length) {
      return chalk.dim("\n  No context files loaded.\n  Use /context add <path> to add files.\n");
    }
    let out = `\n${chalk.bold.cyan("  Context Files")}  ${chalk.dim(`(${files.length} loaded)`)}\n\n`;
    for (const f of files) {
      out += `  ${chalk.green("◇")} ${chalk.bold(f.name)}  ${chalk.dim(f.path)}\n`;
    }
    out += `\n${chalk.dim("  /context add <path>  |  /context remove <name>")}\n`;
    return out;
  }

  const parts = arg.split(/\\s+/);
  const sub = parts[0].toLowerCase();

  if (sub === "add" && parts[1]) {
    const filePath = path.resolve(state.projectRoot, parts.slice(1).join(" "));
    if (!fs.existsSync(filePath)) {
      return chalk.red(`\n  ✗ File not found: ${filePath}\n`);
    }
    if (fs.statSync(filePath).isDirectory()) {
      return chalk.yellow(`\n  ⚠ ${filePath} is a directory. Use individual files.\n`);
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const name = path.basename(filePath);
    state.contextFiles = state.contextFiles || [];
    state.contextFiles.push({ path: filePath, name, content });
    return chalk.green(`\n  ✓ Added context: ${chalk.bold(name)}\n  ${chalk.dim(filePath)}\n`);
  }

  if (sub === "remove" && parts[1]) {
    const target = parts.slice(1).join(" ");
    const files = state.contextFiles || [];
    const idx = files.findIndex(f => f.name === target || f.path.endsWith(target));
    if (idx === -1) {
      return chalk.red(`\n  ✗ Context file "${target}" not found. Use /context list to see loaded files.\n`);
    }
    state.contextFiles!.splice(idx, 1);
    return chalk.yellow(`\n  ✓ Removed context: ${chalk.bold(target)}\n`);
  }

  return chalk.red(`\n  ✗ Usage: /context list | /context add <path> | /context remove <name>\n`);
}

/** Project tree: /tree [depth] — shows filesystem tree */
function showProjectTree(depthStr: string, state: SessionState): string {
  const maxDepth = depthStr ? Math.min(parseInt(depthStr, 10) || 2, 5) : 2;
  const root = state.projectRoot;

  interface TreeNode {
    name: string;
    children: TreeNode[];
    isDir: boolean;
  }

  function buildTree(dir: string, depth: number): TreeNode[] {
    if (depth > maxDepth) return [];
    const nodes: TreeNode[] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith(".") && e.name !== ".env.example") continue;
        if (e.name === "node_modules" || e.name === ".git" || e.name === "dist" || e.name === "build") continue;
        const child: TreeNode = {
          name: e.name,
          children: e.isDirectory() ? buildTree(path.join(dir, e.name), depth + 1) : [],
          isDir: e.isDirectory(),
        };
        nodes.push(child);
      }
    } catch { /* ignore */ }
    return nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  function renderTree(nodes: TreeNode[], prefix: string): string {
    let out = "";
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const isLast = i === nodes.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const nextPrefix = prefix + (isLast ? "    " : "│   ");

      if (node.isDir) {
        out += `${prefix}${connector}${chalk.bold.cyan(node.name)}/\n`;
        if (node.children.length > 0) {
          out += renderTree(node.children, nextPrefix);
        }
      } else {
        out += `${prefix}${connector}${node.name}\n`;
      }
    }
    return out;
  }

  const tree = buildTree(root, 0);
  const projectName = path.basename(root);
  let out = `\n${chalk.bold.cyan("  Project Tree")}  ${chalk.dim(`${projectName}/`)}\n\n`;
  out += renderTree(tree, "  ");
  out += `\n${chalk.dim("  /tree [depth]  (default: 2, max: 5)")}\n`;
  return out;
}

/** /docs — fetch web docs for libraries, APIs, languages */
function fetchDocs(query: string): string {
  try {
    const url = `http://127.0.0.1:50997/search?q=${encodeURIComponent(query)}&format=json`;
    const raw = cp.execSync(
      `curl -s --max-time 10 "${url}"`,
      { timeout: 12_000, encoding: "utf-8", maxBuffer: 500_000 }
    );
    const data = JSON.parse(raw) as { results?: Array<{ title: string; href: string; text: string }> };
    const results = data.results || [];

    if (!results.length) {
      return chalk.yellow(`\n  No docs found for "${query}".\n`);
    }

    let out = `\n${chalk.bold.cyan("  📖 Docs")}  ${chalk.dim(`"${query}"`)}\n\n`;
    for (let i = 0; i < Math.min(results.length, 10); i++) {
      const r = results[i];
      const title = r.title.includes("·") || r.title.includes("-")
        ? r.title.replace(/(.*?)\s*[·|-]\s*(.*)/, (_, a, b) => `${chalk.bold(a.trim())}  ${chalk.dim(b.trim())}`)
        : chalk.bold(r.title);
      out += `  ${chalk.bold(String(i + 1))}. ${title}\n`;
      out += `     ${chalk.dim.underline(r.href)}\n`;
      if (r.text) out += `     ${r.text.slice(0, 250)}\n`;
      out += "\n";
    }
    out += chalk.dim("  Results from web search\n");
    return out;
  } catch (err: any) {
    return chalk.red(`\n  ✗ Docs search failed: ${err.message || err}\n  Is Whoogle running? (port 50997)\n`);
  }
}

/** /explain <path[:lines]> — reads code and queues explanation */
function handleExplain(target: string, state: SessionState): string {
  let filePath = target;
  let lineRange = "";
  const colonIdx = target.lastIndexOf(":");
  if (colonIdx > 0) {
    const after = target.slice(colonIdx + 1);
    if (/^\d+(-\d+)?$/.test(after)) {
      filePath = target.slice(0, colonIdx);
      lineRange = after;
    }
  }

  const absPath = path.resolve(state.projectRoot, filePath);
  if (!fs.existsSync(absPath)) {
    return chalk.red(`\n  ✗ File not found: ${absPath}\n`);
  }
  if (fs.statSync(absPath).isDirectory()) {
    return chalk.yellow(`\n  ⚠ ${filePath} is a directory. Use a file path.\n`);
  }

  const content = fs.readFileSync(absPath, "utf-8");
  const lines = content.split("\n");

  let snippet: string;
  if (lineRange) {
    const [startStr, endStr] = lineRange.split("-");
    const start = Math.max(1, parseInt(startStr, 10)) - 1;
    const end = endStr ? parseInt(endStr, 10) : start + 1;
    snippet = lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join("\n");
  } else {
    snippet = content.length > 8000
      ? content.slice(0, 8000) + `\n... (${content.length - 8000} more chars)`
      : content;
  }

  const lang = path.extname(absPath).slice(1) || "text";
  const relPath = path.relative(state.projectRoot, absPath);

  state.reviewPrompt = `## EXPLAIN CODE

Explain the following code from \`${relPath}\`${lineRange ? ` (lines ${lineRange})` : ""}.

### What to cover:
1. **Purpose** — what does this code do at a high level?
2. **Architecture** — how it fits into the larger codebase
3. **Key functions/classes** — what each major piece does
4. **Flow** — how data moves through this code
5. **Notable patterns** — any tricky or interesting parts

### Output format:
- Start with a 1-sentence summary
- Use bullet points and code references
- Be concise — assume the reader is a competent developer

\`\`\`${lang}
${snippet}
\`\`\``;

  return chalk.cyan(
    `\n  🔍 Explaining ${chalk.bold(relPath)}${lineRange ? ` (lines ${lineRange})` : ""}...\n` +
    chalk.dim(`  Send your next prompt → agent will explain the code.\n`)
  );
}

/** /plan <goal> — generate an implementation plan */
function handlePlan(goal: string, state: SessionState): string {
  if (!goal) {
    return chalk.dim(`\n  Usage: /plan <goal>
  Generate a structured implementation plan before coding.
  Example: /plan add user authentication with JWT

  Tip: Combine with /mode plan to generate plans without execution.\n`);
  }

  state.reviewPrompt = `## GENERATE IMPLEMENTATION PLAN

Generate a detailed implementation plan for the following goal:

### Goal
${goal}

### Project
${state.projectRoot}

### Structure your plan as:
1. **Summary** — 1-2 sentence overview
2. **Files to create/modify** — list each file with its purpose
3. **Implementation steps** — numbered, ordered, specific
4. **Dependencies** — any packages or config changes needed
5. **Testing** — how to verify each step works
6. **Risks** — potential issues or edge cases

Be specific about function names, file paths, and data flow.
Output ONLY the plan, no extra commentary.`;

  return chalk.cyan(
    `\n  📋 Generating plan for: ${chalk.bold(goal.slice(0, 80))}${goal.length > 80 ? "..." : ""}\n` +
    chalk.dim(`  Send your next prompt → agent will generate the plan.\n`)
  );
}

/** /init — create project context files */
function initProject(state: SessionState): string {
  const root = state.projectRoot;
  let created = 0;

  // Create .arx/ directory
  const arxDir = path.join(root, ".arx");
  if (!fs.existsSync(arxDir)) {
    fs.mkdirSync(arxDir, { recursive: true });
    created++;
  }

  // Create AGENTS.md if not exists
  const agentsMd = path.join(root, "AGENTS.md");
  if (!fs.existsSync(agentsMd)) {
    const content = `# ${path.basename(root)}

Project context for ArxCode CLI agent.

## Tech Stack
<!-- Describe your tech stack here -->

## Conventions
<!-- Coding conventions, style, naming -->

## Architecture
<!-- High-level architecture notes -->
`;
    fs.writeFileSync(agentsMd, content, "utf-8");
    created++;
  }

  // Create .arx/hooks.json
  const hooksFile = path.join(arxDir, "hooks.json");
  if (!fs.existsSync(hooksFile)) {
    const hooks = {
      hooks: [
        {
          name: "rm-rf-guard",
          event: "pre_tool_use",
          pattern: "rm -rf /*",
          action: "block",
          message: "🚫 Blocked dangerous command.",
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
      ],
    };
    fs.writeFileSync(hooksFile, JSON.stringify(hooks, null, 2), "utf-8");
    created++;
  }

  // Create .arxrc.yaml if not exists in project
  const arxrc = path.join(root, ".arxrc.yaml");
  if (!fs.existsSync(arxrc)) {
    const content = `# ArxCode CLI config
provider: anthropic
model: claude-sonnet-4-8
# keys:
#   anthropic: sk-ant-...
#   deepseek: sk-...
`;
    fs.writeFileSync(arxrc, content, "utf-8");
    created++;
  }

  // Create skills directory
  const skillsDir = path.join(arxDir, "skills");
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
    created++;
  }

  if (created === 0) {
    return chalk.yellow("\n  ⚠ Project already initialized. All files exist.\n");
  }

  let out = chalk.green(`\n  ✓ Initialized project (${created} item(s))\n\n`);
  if (fs.existsSync(agentsMd)) out += `  ${chalk.green("◇")} AGENTS.md — project context for the agent\n`;
  if (fs.existsSync(hooksFile)) out += `  ${chalk.green("◇")} .arx/hooks.json — guardrails & automation\n`;
  if (fs.existsSync(arxrc)) out += `  ${chalk.green("◇")} .arxrc.yaml — CLI config\n`;
  if (fs.existsSync(skillsDir)) out += `  ${chalk.green("◇")} .arx/skills/ — custom skills directory\n`;
  out += `\n${chalk.dim("  Edit AGENTS.md to describe your project.\n  Run /reload to pick up changes.")}\n`;
  return out;
}

function showSession(state: SessionState): string {
  const temp = state.temperature != null ? state.temperature.toFixed(1) : "default";
  const effort = state.effort ? EFFORT_PRESETS[state.effort] : EFFORT_PRESETS.normal;
  return `
${chalk.bold.cyan("  Session")}
  Mode     : ${chalk.bold(state.agentMode || "auto")}
  Provider : ${chalk.bold(state.providerId)}
  Model    : ${chalk.bold(state.model)}
  Project  : ${chalk.dim(state.projectRoot)}
  Effort   : ${effort.icon} ${chalk.bold(state.effort || "normal")}  ${chalk.dim(`(${state.maxSteps} steps, temp ${temp})`)}
  Max steps: ${state.maxSteps}
  Temp     : ${temp}
  API Key  : ${state.apiKey ? chalk.green("✓") : chalk.red("✗ MISSING")}
  Remote   : ${state.remoteTransport ? chalk.green(`🌐 ${state.remoteConfig?.username}@${state.remoteConfig?.host}`) : chalk.dim("none")}
`;
}

// ── Remote Command Handler ─────────────────────────────────────────

function handleRemote(arg: string, state: SessionState): string {
  if (!arg) {
    // Show status
    if (state.remoteTransport && state.remoteConfig) {
      const { host, port, username, projectRoot } = state.remoteConfig;
      const addr = port === 22 ? host : `${host}:${port}`;
      const projectRootStr = projectRoot;
      return [
        ``,
        `  ${chalk.bold.green("🌐 Remote Connected")}`,
        `  Host    : ${username}@${addr}`,
        `  Project : ${projectRootStr}`,
        ``,
        `  Disconnect: ${chalk.dim("/remote disconnect")}`,
        `  Status   : ${chalk.dim("/remote status")}`,
        ``,
      ].join("\n");
    }
    const saved = loadRemoteConfig(state.projectRoot);
    if (saved) {
      return [
        ``,
        `  ${chalk.yellow("🌐 Remote Saved (disconnected)")}`,
        `  Host    : ${saved.username}@${saved.host}${saved.port !== 22 ? `:${saved.port}` : ""}`,
        `  Project : ${saved.projectRoot}`,
        ``,
        `  Connect: ${chalk.dim(`/remote ssh ${saved.username}@${saved.host}`)}`,
        ``,
      ].join("\n");
    }
    return [
      ``,
      `  ${chalk.dim("🌐 Remote: not configured")}`,
      ``,
      `  Connect:  ${chalk.dim("/remote ssh user@host[:port]")}`,
      `  Disconnect: ${chalk.dim("/remote disconnect")}`,
      `  Status:    ${chalk.dim("/remote status")}`,
      ``,
    ].join("\n");
  }

  const parts = arg.split(/\s+/);
  const sub = parts[0].toLowerCase();

  if (sub === "disconnect") {
    if (!state.remoteTransport) {
      return chalk.yellow("\n  ⚠ Not connected.\n");
    }
    disconnectRemote();
    state.remoteTransport = undefined;
    state.remoteConfig = undefined;
    return chalk.green("\n  ✓ Disconnected from remote.\n");
  }

  if (sub === "status") {
    if (state.remoteTransport && state.remoteConfig) {
      return `\n  ${chalk.green("🌐 Connected:")} ${state.remoteConfig.username}@${state.remoteConfig.host}\n`;
    }
    return `\n  ${chalk.dim("🌐 Not connected.")}\n`;
  }

  if (sub === "ssh") {
    const connStr = parts.slice(1).join(" ").trim();
    if (!connStr) {
      return chalk.red("\n  ✗ Usage: /remote ssh user@host[:port]\n");
    }
    const parsed = parseConnectionString(connStr);
    if (!parsed) {
      return chalk.red(`\n  ✗ Invalid connection string: "${connStr}". Use user@host[:port]\n`);
    }

    // Disconnect existing first
    if (state.remoteTransport) {
      disconnectRemote();
      state.remoteTransport = undefined;
      state.remoteConfig = undefined;
    }

    // Check for saved config
    const saved = loadRemoteConfig(state.projectRoot);
    const privateKey = saved?.privateKey;
    const savedProjectRoot = saved?.projectRoot || `~`;

    // Build config — password will be prompted interactively
    const cfg: RemoteConfig = {
      host: parsed.host,
      port: parsed.port,
      username: parsed.username,
      privateKey,
      projectRoot: savedProjectRoot,
    };

    // If we need a password and don't have a key, we return a special marker
    // The actual connection happens in bin/arx.ts where we have readline
    if (!cfg.privateKey && !cfg.password) {
      // Store partial config and let the REPL handle the connection prompt
      state.remoteConfig = cfg;
      return `__REMOTE_NEED_PASSWORD__${parsed.username}@${parsed.host}`;
    }

    // Try connecting immediately (has key or password in saved config)
    return `__REMOTE_CONNECT_IMMEDIATE__`;
  }

  return chalk.red(`\n  ✗ Unknown remote command: ${arg}. Use: ssh, disconnect, status\n`);
}

function showTokens(state: SessionState): string {
  const inp = state.totalInputTokens ?? 0;
  const out = state.totalOutputTokens ?? 0;
  const total = inp + out;

  const { cost, label } = estimateCost(
    state.providerId,
    state.model,
    inp,
    out,
  );

  const msgCount = state.conversation?.length ?? 0;
  const estTokens = msgCount * 2000; // rough estimate

  return `
${chalk.bold.cyan("  Token Usage")}

  ${chalk.yellow("▲")} Input:    ${chalk.bold(inp.toLocaleString())}
  ${chalk.yellow("▼")} Output:   ${chalk.bold(out.toLocaleString())}
  ${chalk.bold("Σ")} Total:    ${chalk.bold(total.toLocaleString())}  ${chalk.dim(`(~${label})`)}

  ${chalk.dim("Pricing:")}  ${chalk.dim(getPricingInfo(state.providerId, state.model))}
  ${chalk.dim("Messages:")} ${msgCount}  ${chalk.dim(`(~${estTokens.toLocaleString()} est. context tokens)`)}
  ${chalk.dim("Use /compact to shrink context and save tokens.")}
`;
}

// ── /effort implementation ──────────────────────────────────────────

function handleEffort(arg: string, state: SessionState): string {
  if (!arg) {
    const current = state.effort || "normal";
    const cfg = EFFORT_PRESETS[current];
    return `
${chalk.bold.cyan(`  Effort: ${cfg.icon} ${chalk.bold(current)}`)}  ${chalk.dim(cfg.label)}

${chalk.dim("  Levels:")}
  ${chalk.green("●")} ${chalk.bold("min")}     ${chalk.dim("— quick fixes only (8 steps, temp 0)")}
  ${chalk.green("○")} ${chalk.bold("normal")}  ${chalk.dim("— balanced (24 steps, provider default temp)")}
  ${chalk.green("○")} ${chalk.bold("max")}     ${chalk.dim("— deep reasoning (48 steps, temp 0.2)")}

  ${chalk.dim(`Current: ${cfg.icon} ${chalk.bold(current)} — ${cfg.label}`)}
  ${chalk.dim("Switch: /effort min | /effort normal | /effort max")}
`;
  }

  const level = arg.toLowerCase() as EffortLevel;
  if (!EFFORT_PRESETS[level]) {
    return chalk.red(`\n  ✗ Invalid effort level: "${arg}". Use: min, normal, max\n`);
  }

  state.effort = level;
  const cfg = EFFORT_PRESETS[level];
  // Also set temperature and maxSteps directly so effort is applied immediately
  state.temperature = cfg.temperature;
  state.maxSteps = cfg.maxSteps;

  return chalk.green(`\n  ✓ Effort: ${cfg.icon} ${chalk.bold(level)} — ${cfg.label}\n`);
}

function showHooks(projectRoot: string, _arg: string): string {
  const hooks = loadHooks(projectRoot);

  if (!hooks.length) {
    return chalk.dim("\n  No hooks configured.\n  Create .arx/hooks.json to add hooks.\n");
  }

  const eventIcons: Record<HookEvent, string> = {
    pre_tool_use: "🔒",
    post_tool_use: "⚡",
    session_start: "🚀",
    session_stop: "🛑",
  };

  const actionColors: Record<string, (s: string) => string> = {
    block: chalk.red,
    confirm: chalk.yellow,
    warn: chalk.yellow,
    run: chalk.green,
  };

  let out = `\n${chalk.bold.cyan("  Hooks")}  ${chalk.dim(`(${hooks.length} active)`)}
\n  ${chalk.dim("Configure: .arx/hooks.json    │    /hook to list")}\n\n`;

  for (const h of hooks) {
    const icon = eventIcons[h.event] || "•";
    const color = actionColors[h.action] || chalk.white;
    out += `  ${icon} ${chalk.bold(h.name)}  ${color(h.action)}  ${chalk.dim(`on ${h.event}`)}\n`;
    if (h.pattern) out += `    pattern: ${chalk.dim(h.pattern)}\n`;
    if (h.tool) out += `    tool: ${chalk.dim(h.tool)}\n`;
    if (h.message) out += `    ${chalk.dim(h.message)}\n`;
    out += "\n";
  }

  out += chalk.dim("  To customize, edit .arx/hooks.json in your project root.\n");
  return out;
}

// ── Skills ──────────────────────────────────────────────────────────

function handleSkill(arg: string, state: SessionState): string {
  if (arg === "list" || !arg) {
    return showSkills(state.projectRoot);
  }
  if (arg === "init" || arg === "create") {
    const dir = getProjectSkillsDir(state.projectRoot);
    const skillDir = createExampleSkill(dir);
    return chalk.green(`\n  ✓ Created example skill at:\n    ${chalk.bold(skillDir)}\n\n  Edit SKILL.md to customize, then /skill reload\n`);
  }
  if (arg === "reload") {
    // Skills are reloaded on next agent run via bin/arx.ts
    return chalk.cyan("\n  ⚡ Skills will be reloaded on your next prompt.\n    Use /skill list to verify loaded skills.\n");
  }
  if (arg === "global") {
    const dir = getGlobalSkillsDir();
    fs.mkdirSync(dir, { recursive: true });
    return chalk.dim(`\n  Global skills directory: ${chalk.bold(dir)}\n  Place SKILL.md files here to make them available everywhere.\n`);
  }
  if (arg === "project") {
    const dir = getProjectSkillsDir(state.projectRoot);
    fs.mkdirSync(dir, { recursive: true });
    return chalk.dim(`\n  Project skills directory: ${chalk.bold(dir)}\n  Place SKILL.md files here for project-specific skills.\n`);
  }
  return chalk.red(`\n  ✗ Unknown: ${arg}. Use: /skill list | /skill init | /skill reload | /skill global | /skill project\n`);
}

function showSkills(projectRoot: string): string {
  const registry = loadSkills(projectRoot);
  const { skills } = registry;

  if (!skills.length) {
    return chalk.dim(`\n  No skills loaded.\n\n  Create one:  /skill init\n  Global dir:   ${getGlobalSkillsDir()}\n  Project dir:  ${getProjectSkillsDir(projectRoot)}\n`);
  }

  let out = `\n${chalk.bold.cyan("  Skills")}  ${chalk.dim(`(${skills.length} loaded, ${registry.toolDefs.length} custom tools)`)}\n\n`;

  for (const s of skills) {
    const toolCount = s.tools.length;
    const cmdCount = s.commands.length;
    out += `  ${chalk.bold(s.name)}`;
    if (s.version) out += ` ${chalk.dim(`v${s.version}`)}`;
    if (s.description) out += `\n    ${chalk.dim(s.description)}`;
    const badges: string[] = [];
    if (toolCount) badges.push(chalk.green(`${toolCount} tools`));
    if (cmdCount) badges.push(chalk.yellow(`${cmdCount} commands`));
    if (s.prompts.length) badges.push(chalk.cyan(`${s.prompts.length} prompts`));
    out += `\n    ${badges.join(" · ")}`;
    out += `\n    ${chalk.dim(s.filePath)}\n\n`;
  }

  out += chalk.dim(`  Commands: /skill init  |  /skill reload  |  /skill global  |  /skill project\n`);
  return out;
}

// ── MCP Helpers ──────────────────────────────────────────────────

function handleMcpAdd(name: string, state: SessionState): string {
  const preset = MCP_PRESETS[name];
  if (!preset) {
    const available = Object.keys(MCP_PRESETS).join(", ");
    return chalk.red(`\n  ✗ Unknown preset: "${name}". Available: ${available}\n  Tip: /mcp presets to list all\n`);
  }

  // Check required env vars
  const missing: string[] = [];
  if (preset.requiredEnv) {
    for (const envName of preset.requiredEnv) {
      const val = process.env[envName];
      if (!val || val === `your-${name}-${envName.toLowerCase()}`) {
        missing.push(envName);
      }
    }
  }

  if (missing.length > 0) {
    let out = chalk.yellow(`\n  ⚠ "${name}" needs configuration:\n\n`);
    for (const envName of missing) {
      out += `    ${chalk.bold(envName)} — set via:\n`;
      out += `      /mcp config ${name} ${envName}=<value>\n`;
      out += `      Or: export ${envName}=...\n\n`;
    }
    out += chalk.dim(`  Then run: /mcp add ${name}\n`);
    return out;
  }

  // Apply preset and write to config
  const result = applyMcpPreset(name, {});
  if (!result) {
    return chalk.red(`\n  ✗ Failed to apply preset "${name}"\n`);
  }

  // Write to ~/.arxrc.yaml
  const cfgPath = path.join(os.homedir(), ".arxrc.yaml");
  try {
    let existing: Record<string, any> = {};
    if (fs.existsSync(cfgPath)) {
      const raw = fs.readFileSync(cfgPath, "utf-8");
      existing = YAML.parse(raw) || {};
    }
    if (!existing.mcp_servers) existing.mcp_servers = {};
    // Fill in env vars from process.env
    const env = result.config.env || {};
    if (preset.requiredEnv) {
      for (const envName of preset.requiredEnv) {
        const val = process.env[envName];
        if (val) env[envName] = val;
      }
    }
    existing.mcp_servers[name] = result.config.env ? { ...result.config, env: { ...env } } : result.config;

    // Clean up placeholder values
    const serverCfg = existing.mcp_servers[name];
    if (serverCfg?.env) {
      for (const [k, v] of Object.entries(serverCfg.env)) {
        if (typeof v === "string" && v.startsWith("your-")) {
          delete serverCfg.env[k];
        }
      }
      if (Object.keys(serverCfg.env).length === 0) {
        delete serverCfg.env;
      }
    }

    fs.writeFileSync(cfgPath, YAML.stringify(existing), "utf-8");
  } catch (err) {
    return chalk.red(`\n  ✗ Failed to write config: ${err instanceof Error ? err.message : err}\n`);
  }

  // Queue connect
  state.mcpPending = "connect";

  let out = chalk.green(`\n  ✓ Added MCP server: ${chalk.bold(name)}\n`);
  out += chalk.dim(`    Config saved to ~/.arxrc.yaml\n`);
  if (result.instructions) {
    out += `\n  ${chalk.dim(result.instructions.replace(/\n/g, "\n  "))}\n`;
  }
  out += `\n  ${chalk.dim("Send your next prompt to connect.")}\n`;
  return out;
}

function handleMcpConfig(rest: string, state: SessionState): string {
  // Format: <name> <key>=<value> [<key2>=<value2>]
  const parts = rest.split(/\s+/);
  if (parts.length < 2) {
    return chalk.red("\n  ✗ Usage: /mcp config <name> <key>=<value> [<key2>=<value2>...]\n  Example: /mcp config figma FIGMA_ACCESS_TOKEN=xxx\n");
  }

  const name = parts[0].toLowerCase();
  const kvPairs = parts.slice(1);

  const preset = MCP_PRESETS[name];
  if (!preset) {
    return chalk.red(`\n  ✗ Unknown preset: "${name}". Use /mcp presets to list.\n`);
  }

  let out = chalk.green(`\n  ✓ Configuring ${chalk.bold(name)}:\n\n`);

  for (const pair of kvPairs) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx <= 0) {
      out += chalk.yellow(`    ⚠ Skipped "${pair}" — use key=value format\n`);
      continue;
    }
    const key = pair.slice(0, eqIdx);
    const val = pair.slice(eqIdx + 1);
    // Set in process.env so the next /mcp add picks it up
    process.env[key] = val;
    out += `    ${chalk.green("✓")} ${chalk.bold(key)} = ${chalk.dim(val.slice(0, 4) + "***")}\n`;
  }

  out += `\n  ${chalk.dim(`Now run: /mcp add ${name}`)}\n`;
  return out;
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

// ── Recipe System ────────────────────────────────────────────────────

/**
 * Parse inline key=value pairs from a string.
 * Handles both `key=value` and `key="value with spaces"`.
 */
function parseInlineVars(s: string): { name: string; vars: Record<string, string> } {
  const tokens = s.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  const name = tokens[0] ?? "";
  const vars: Record<string, string> = {};
  for (const tok of tokens.slice(1)) {
    const eq = tok.indexOf("=");
    if (eq === -1) continue;
    const key = tok.slice(0, eq);
    const val = tok.slice(eq + 1).replace(/^"|"$/g, "");
    vars[key] = val;
  }
  return { name, vars };
}

export function handleRecipe(rest: string, state: SessionState): string | null {
  // /recipe (no subcommand) or /recipe list
  if (!rest || rest === "list") {
    return formatRecipeList(loadRecipes());
  }

  // /recipe init
  if (rest === "init") {
    const created = initBuiltinRecipes();
    let out = chalk.green(`\n  ✓ Created ${created.length} built-in recipes in ~/.arx/recipes/\n\n`);
    for (const f of created) {
      out += `  ${chalk.dim(f)}\n`;
    }
    out += `\n  ${chalk.dim("Run /recipe list to see them.")}\n`;
    return out;
  }

  // /recipe show <name>
  if (rest.startsWith("show ")) {
    const name = rest.slice(5).trim();
    const recipe = getRecipe(name);
    if (!recipe) return chalk.red(`\n  ✗ Recipe "${name}" not found. Run /recipe list to see available recipes.\n`);
    return formatRecipeShow(recipe);
  }

  // /recipe delete <name>
  if (rest.startsWith("delete ")) {
    const name = rest.slice(7).trim();
    if (!deleteRecipe(name)) return chalk.red(`\n  ✗ Recipe "${name}" not found.\n`);
    return chalk.green(`\n  ✓ Deleted recipe: ${name}\n`);
  }

  // /recipe create <name> [description]
  if (rest.startsWith("create ")) {
    const parts = rest.slice(7).trim().split(/\s+/);
    const name = parts[0];
    if (!name) return chalk.red("\n  ✗ Usage: /recipe create <name> [description]\n");
    const description = parts.slice(1).join(" ");
    const body = `Describe what you want the agent to do.\n\nYou can use {{variable}} placeholders for dynamic values.`;
    const filePath = createRecipeFile(name, description || `Recipe: ${name}`, body);
    return chalk.green(`\n  ✓ Created recipe: ${chalk.bold(name)}\n  Edit it at: ${chalk.dim(filePath)}\n`);
  }

  // /recipe edit <name>
  if (rest.startsWith("edit ")) {
    const name = rest.slice(5).trim();
    const recipe = getRecipe(name);
    if (!recipe) return chalk.red(`\n  ✗ Recipe "${name}" not found. Use /recipe create ${name} to create it.\n`);
    const editor = process.env.EDITOR || process.env.VISUAL || "nano";
    try {
      cp.spawnSync(editor, [recipe.filePath], { stdio: "inherit" });
    } catch {
      return chalk.yellow(`\n  ⚠ Could not open editor. Edit manually: ${chalk.bold(recipe.filePath)}\n`);
    }
    return chalk.green(`\n  ✓ Saved: ${recipe.filePath}\n`);
  }

  // /recipe run <name> [key=value ...]
  if (rest.startsWith("run ")) {
    const { name, vars: inlineVars } = parseInlineVars(rest.slice(4).trim());
    if (!name) return chalk.red("\n  ✗ Usage: /recipe run <name> [var=value ...]\n");
    const recipe = getRecipe(name);
    if (!recipe) return chalk.red(`\n  ✗ Recipe "${name}" not found. Run /recipe list to see available recipes.\n`);

    const { values, missing } = resolveVars(recipe, inlineVars);

    if (missing.length > 0) {
      state.recipePending = { name, values, missing };
      const varInfo = recipe.variables.find(rv => rv.name === missing[0]);
      const desc = varInfo?.description ? ` (${varInfo.description})` : "";
      return chalk.cyan(`\n  ✎ Recipe "${name}" needs ${missing.length} more variable(s). Enter ${chalk.bold("{{" + missing[0] + "}}")}${chalk.dim(desc)}:\n`);
    }

    // All vars resolved — queue the prompt just like /review does
    state.recipePrompt = substituteVars(recipe.body, values);
    return chalk.cyan(`\n  🍳 Running recipe: ${chalk.bold(name)}\n`);
  }

  return chalk.red(`\n  ✗ Unknown: "${rest}"\n  Usage: /recipe list | show <name> | run <name> [var=val] | create <name> | edit <name> | delete <name> | init\n`);
}
