#!/usr/bin/env node
/**
 * ArxCode CLI — autonomous coding agent.
 *
 * INTERACTIVE MODE (no args):
 *   arx
 *   > build a REST API
 *   /model          — switch models
 *   /provider groq  — switch provider
 *
 * ONE-SHOT MODE (with prompt):
 *   arx "build a REST API"
 *   arx -p openai "fix the login"
 */

import { Command } from "commander";
import chalk from "chalk";
import ora, { Ora } from "ora";
import * as path from "node:path";
import * as readline from "node:readline";
import * as fs from "node:fs";
import * as os from "node:os";
import * as cp from "node:child_process";
import { createProvider } from "../src/llm/index.js";
import { runAgent, type HarnessEvent } from "../src/harness.js";
import { loadConfig, resolveProviderConfig, configStatus } from "../src/config.js";
import { LLMError, PROVIDER_REGISTRY } from "../src/llm/types.js";
import { handleCommand, type SessionState, MODEL_PRESETS, SLASH_COMMANDS, expandAlias, handleRecipe } from "../src/commands.js"
import { EFFORT_PRESETS, estimateCost, estimatePreCost, formatCostBreakdown } from "../src/pricing.js";
import { loadRecipes, getRecipe, substituteVars, formatRecipeList, formatRecipeShow, initBuiltinRecipes, resolveVars, deleteRecipe } from "../src/recipes.js";
import { loadContextFiles, type ContextFile } from "../src/context.js";
import { compactionPrompt } from "../src/prompts.js";
import { showBanner } from "../src/banner.js";
import { loadHooks, runHooks, hasUncommittedChanges } from "../src/hooks.js";
import { loadSkills, type Skill } from "../src/skills.js";
import { connectAllServers, disconnectAll as mcpDisconnectAll, loadMcpServersFromConfig } from "../src/mcp.js";
import { createHighlighter, highlightChunk, highlightCode } from "../src/highlight.js";
import { detectProject, formatProjectInfo } from "../src/project.js";
import type { ProviderId } from "../src/config.js";
import type { AgentMessage, ContentBlock } from "../src/llm/types.js";

const VERSION = "0.6.0";

// ── Phase Icons ────────────────────────────────────────────────────

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

// ── One-Shot Mode ──────────────────────────────────────────────────

async function runOneShot(prompt: string, opts: Record<string, string>) {
  const cfg = loadConfig(opts.project);
  if (opts.provider) cfg.provider = opts.provider as ProviderId;
  if (opts.model) cfg.model = opts.model;
  if (opts.key) cfg.apiKey = opts.key;
  if (opts.maxSteps) cfg.maxSteps = parseInt(opts.maxSteps, 10);
  if (opts.baseUrl) cfg.baseUrl = opts.baseUrl;

  const providerCfg = resolveProviderConfig(cfg);

  if (!providerCfg.apiKey) {
    console.error(chalk.red(`\n✗ No API key for "${providerCfg.provider}".`));
    console.error(chalk.dim(`  Set ${providerCfg.provider.toUpperCase()}_API_KEY, pass --key, or use /key in interactive mode.\n`));
    process.exit(1);
  }

  const projectRoot = path.resolve(opts.project);

  // Expand aliases in one-shot mode
  const expandedPrompt = expandAlias(prompt);

  console.log(showBanner(VERSION));
  console.log(chalk.dim(`  ${providerCfg.provider}  ·  ${providerCfg.model || "(default)"}  ·  ${projectRoot}`));
  console.log();

  let provider;
  try {
    provider = createProvider(providerCfg);
  } catch (err) {
    console.error(chalk.red(`\n✗ ${err instanceof Error ? err.message : err}\n`));
    process.exit(1);
  }

  await streamAgent(provider, expandedPrompt, projectRoot, cfg.maxSteps ?? 24);
}

// ── TUI Mode ──────────────────────────────────────────────────────

async function runTui(initialOpts: Record<string, string>) {
  // Dynamically import Ink and the TUI app — only when --tui is used
  const { render } = await import("ink");
  const { default: React } = await import("react");
  const { App } = await import("../src/tui/app.js");

  const projectRoot = path.resolve(initialOpts.project || process.cwd());

  const { waitUntilExit } = render(
    React.createElement(App, {
      projectRoot,
      initialProvider: initialOpts.provider,
      initialModel: initialOpts.model,
      initialKey: initialOpts.key,
    })
  );

  await waitUntilExit();
}

// ── Interactive REPL Mode ──────────────────────────────────────────

async function runInteractive(initialOpts: Record<string, string>) {
  const projectRoot = path.resolve(initialOpts.project || process.cwd());
  const cfg = loadConfig(projectRoot);

  if (initialOpts.provider) cfg.provider = initialOpts.provider as ProviderId;
  if (initialOpts.model) cfg.model = initialOpts.model;
  if (initialOpts.key) cfg.apiKey = initialOpts.key;

  const providerId = cfg.provider ?? "anthropic";
  const model = cfg.model || cfg.models?.[providerId] || "";
  const apiKey = cfg.apiKey || cfg.keys?.[providerId] || "";

  // Load context files (AGENTS.md, CLAUDE.md, etc.)
  const contextFiles = loadContextFiles(projectRoot);

  // Session state (mutable, shared with command handler)
  const state: SessionState = {
    config: cfg,
    projectRoot,
    providerId,
    model,
    apiKey,
    maxSteps: cfg.maxSteps ?? 24,
    exit: false,
    clearHistory: false,
    contextFiles,
    conversation: [],
  };

  // Apply effort preset if set (overrides default maxSteps/temperature)
  if (state.effort) {
    const ecfg = EFFORT_PRESETS[state.effort];
    state.maxSteps = ecfg.maxSteps;
    state.temperature = ecfg.temperature;
  }

  // Banner
  console.log(showBanner(VERSION));
  console.log(chalk.dim(`  ${providerId}  ·  ${model || "(default)"}  ·  ${projectRoot}`));
  if (contextFiles.length > 0) {
    const names = contextFiles.map(f => f.name).join(", ");
    console.log(chalk.dim(`  context: ${names}`));
  }
  // Project intelligence
  const projInfo = detectProject(projectRoot);
  if (projInfo.type !== "unknown") {
    console.log(chalk.dim(`  project: ${formatProjectInfo(projInfo)}`));
  }
  if (state.effort) {
    const ecfg = EFFORT_PRESETS[state.effort];
    console.log(chalk.dim(`  effort: ${ecfg.icon} ${state.effort}  (${state.maxSteps} steps, temp ${state.temperature ?? "default"})`));
  }
  if (!apiKey) {
    console.log(chalk.yellow(`  ⚠ no API key — use /key <***> or /provider to configure`));
  }

  // ── Session start hooks ───────────────────────────────────────
  const hooks = loadHooks(projectRoot);
  const startResults = await runHooks(hooks, "session_start", { projectRoot });
  for (const r of startResults) {
    if (r.message) console.log(chalk.dim(`  [hook:${r.hook}] ${r.message}`));
  }

  console.log();

  // Auto-connect MCP servers if configured
  const mcpServers = loadMcpServersFromConfig(projectRoot);
  const mcpServerCount = Object.keys(mcpServers).length;
  if (mcpServerCount > 0) {
    await connectAllServers(mcpServers);
  }

  // History file
  const historyFile = path.join(os.homedir(), ".arx_history");
  const history: string[] = loadHistory(historyFile);

  // Create readline interface
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.cyan("  ❯ "),
    terminal: true,
    history,
    historySize: 500,
    removeHistoryDuplicates: true,
    completer: (line: string) => {
      const trimmed = line.trimStart();
      
      // Slash commands
      if (trimmed.startsWith("/")) {
        const hits = SLASH_COMMANDS.filter(c => c.startsWith(trimmed));
        if (hits.length > 0) {
          return [hits, trimmed];
        }
      }

      // /model <partial> — complete model names for current provider
      const modelMatch = trimmed.match(/^\/model\s+(.+)$/i);
      if (modelMatch) {
        const partial = modelMatch[1].toLowerCase();
        const presets = MODEL_PRESETS[state.providerId] ?? [];
        const hits = presets
          .filter(m => m.id.toLowerCase().includes(partial) || m.name.toLowerCase().includes(partial))
          .map(m => m.id);
        if (hits.length > 0) {
          // Return the model ID completion AFTER "/model "
          const prefix = trimmed.slice(0, trimmed.indexOf(partial));
          return [hits.map(h => prefix + h), trimmed];
        }
      }

      // /provider <partial> — complete provider IDs
      const providerMatch = trimmed.match(/^\/provider\s+(.+)$/i);
      if (providerMatch) {
        const partial = providerMatch[1].toLowerCase();
        const hits = Object.keys(PROVIDER_REGISTRY).filter(p => p.startsWith(partial));
        if (hits.length > 0) {
          const prefix = trimmed.slice(0, trimmed.indexOf(partial));
          return [hits.map(h => prefix + h), trimmed];
        }
      }

      // @file references — complete file paths
      const atMatch = trimmed.match(/(?:^|\s)@([^\s]*)$/);
      if (atMatch) {
        const partial = atMatch[1];
        try {
          const dir = partial.includes("/") 
            ? path.dirname(partial)
            : ".";
          const prefix = partial.includes("/") 
            ? partial.substring(0, partial.lastIndexOf("/") + 1)
            : "";
          const base = path.isAbsolute(dir) ? dir : path.resolve(state.projectRoot, dir);
          if (fs.existsSync(base)) {
            const entries = fs.readdirSync(base, { withFileTypes: true });
            const hits = entries
              .filter(e => !e.name.startsWith(".") || e.name === ".env.example")
              .filter(e => e.name.startsWith(partial.replace(prefix, "")) || partial === "")
              .map(e => `@${prefix}${e.name}${e.isDirectory() ? "/" : ""}`);
            if (hits.length > 0) {
              const beforeAt = trimmed.slice(0, atMatch.index! + 1);
              return [hits.map(h => beforeAt + h.slice(1)), trimmed];
            }
          }
        } catch {}
      }

      // No completions — default readline behavior (file paths)
      return [[], trimmed];
    },
  });

  // We track multi-line input ourselves
  let multilineBuffer: string[] = [];
  let inMultiline = false;

  rl.prompt();

  rl.on("line", async (line: string) => {
    const trimmed = line.trim();

    // Empty line in multi-line mode = submit
    if (inMultiline && trimmed === "") {
      inMultiline = false;
      const fullInput = multilineBuffer.join("\n");
      multilineBuffer = [];
      await processInput(fullInput, state, rl);
      if (!state.exit) rl.prompt();
      return;
    }

    // Continue multi-line
    if (inMultiline) {
      multilineBuffer.push(line);
      process.stdout.write("  │ ");
      return;
    }

    // Empty line = ignore
    if (trimmed === "") {
      rl.prompt();
      return;
    }

    // Slash command?
    if (trimmed.startsWith("/")) {
      const output = handleCommand(trimmed, state);
      if (output) console.log(output);
      if (state.exit) {
        saveHistory(historyFile, rl);
        rl.close();
        return;
      }
      // Auto-trigger code review if queued by /review
      if (state.reviewPrompt || state.commitPrompt || state.recipePrompt) {
        await processInput("", state, rl);
      }
      if (!state.exit) rl.prompt();
      return;
    }

    // Bash execution (!command = send to agent, !!command = just run)
    if (trimmed.startsWith("!!")) {
      runBash(trimmed.slice(2).trim(), false);
      rl.prompt();
      return;
    }
    if (trimmed.startsWith("!")) {
      const cmd = trimmed.slice(1).trim();
      const output = runBash(cmd, true);
      // Send as prompt with bash output prefixed
      const prompt = `Command output:\n${output}\n\nContinue based on this output.`;
      await processInput(prompt, state, rl);
      if (!state.exit) rl.prompt();
      return;
    }

    // Multi-line trigger: line ending with \
    if (trimmed.endsWith("\\")) {
      inMultiline = true;
      multilineBuffer = [trimmed.slice(0, -1)];
      process.stdout.write("  │ ");
      return;
    }

    // Normal prompt → send to agent
    saveLine(historyFile, trimmed);

    // Pause readline during agent streaming to prevent input conflicts
    rl.pause();
    await processInput(trimmed, state, rl);
    if (state.exit) {
      rl.close();
      return;
    }
    // Resume and show next prompt
    rl.resume();
    rl.prompt();
  });

  rl.on("close", async () => {
    // ── Session stop hooks ─────────────────────────────────────
    const hooks = loadHooks(state.projectRoot);
    if (hasUncommittedChanges(state.projectRoot)) {
      const stopResults = await runHooks(hooks, "session_stop", { projectRoot: state.projectRoot });
      for (const r of stopResults) {
        if (r.message) console.log(chalk.yellow(`  ${r.message}`));
      }
    }
    saveHistory(historyFile, rl);
    console.log(chalk.dim("\n  see ya!\n"));
    // Let process exit naturally — don't force process.exit()
  });

  // Ctrl+C clears the current line instead of exiting
  rl.on("SIGINT", () => {
    // Clear current line and show fresh prompt
    process.stdout.write("\r\x1b[K");
    const hasInput = (rl as any).line?.length > 0;
    if (hasInput) {
      console.log(chalk.dim("^C (type /quit to exit)"));
    } else {
      // Empty line — exit on second Ctrl+C
      rl.close();
      return;
    }
    rl.prompt();
  });
}

async function processInput(input: string, state: SessionState, rl: readline.Interface) {
  // Validate API key
  if (!state.apiKey) {
    console.log(chalk.red("  ✗ No API key. Set one with /key <***> or /provider <name>.\n"));
    return;
  }

  // Handle MCP pending action
  if (state.mcpPending) {
    const action = state.mcpPending;
    state.mcpPending = undefined;
    if (action === "connect") {
      console.log(chalk.dim("  🔌 Connecting to MCP servers...\n"));
      const servers = loadMcpServersFromConfig(state.projectRoot);
      const serverCount = Object.keys(servers).length;
      if (serverCount === 0) {
        console.log(chalk.yellow("  ⚠ No MCP servers configured. Add to .arxrc.yaml under mcp_servers:\n"));
      } else {
        await connectAllServers(servers);
        console.log(chalk.green(`  ✓ MCP: ${serverCount} server(s) configured\n`));
      }
    } else if (action === "disconnect") {
      await mcpDisconnectAll();
      console.log(chalk.yellow("  ✓ MCP servers disconnected\n"));
    }
    return;
  }

  // Handle pending recipe variable collection
  if (state.recipePending) {
    const { name, values, missing } = state.recipePending;
    const varName = missing[0];
    values[varName] = input;
    const remaining = missing.slice(1);

    if (remaining.length > 0) {
      state.recipePending = { name, values, missing: remaining };
      const recipe = getRecipe(name);
      const v = recipe?.variables.find(rv => rv.name === remaining[0]);
      const desc = v?.description ? ` (${v.description})` : "";
      console.log(chalk.cyan(`  Enter ${chalk.bold("{{" + remaining[0] + "}}")}${chalk.dim(desc)}:\n`));
      return;
    }

    // All vars collected — resolve and queue
    state.recipePending = undefined;
    const recipe = getRecipe(name);
    if (!recipe) {
      console.log(chalk.red(`  ✗ Recipe "${name}" not found.\n`));
      return;
    }
    state.recipePrompt = substituteVars(recipe.body, values);
    console.log(chalk.cyan(`  🍳 Running recipe: ${chalk.bold(name)}\n`));
  }

  // Handle code review if pending
  let prompt: string;
  if (state.recipePrompt) {
    prompt = state.recipePrompt;
    state.recipePrompt = undefined;
  } else if (state.reviewPrompt) {
    prompt = state.reviewPrompt;
    state.reviewPrompt = undefined;
    // If user typed additional instructions, append them
    if (input && !input.startsWith("/")) {
      prompt += `\n\nAdditional instructions from user: ${input}`;
    }
    console.log(chalk.cyan("  🔍 Running code review...\n"));
  } else if (state.commitPrompt) {
    prompt = state.commitPrompt;
    state.commitPrompt = undefined;
    // If user typed additional instructions, append them
    if (input && !input.startsWith("/")) {
      prompt += `\n\nAdditional instructions from user: ${input}`;
    }
    console.log(chalk.magenta("  📝 Generating commit message...\n"));
  } else {
    // Handle compaction if pending
    if (state.compactPending) {
      await runCompaction(input, state);
      state.compactPending = undefined;
      return;
    }
    prompt = input;
  }

  // Expand aliases
  const expanded = expandAlias(prompt);
  if (expanded !== prompt) {
    console.log(chalk.dim(`  → ${expanded.slice(0, 80)}...\n`));
    prompt = expanded;
  }

  // Expand @file references before sending to agent
  const expandedInput = expandFileRefs(prompt, state.projectRoot);
  if (expandedInput !== prompt) {
    console.log(chalk.dim(`  📎 Expanded @file references\n`));
  }

  // Auto-compact: suggest compact when context is large
  const msgCount = state.conversation?.length ?? 0;
  if (msgCount > 20) {
    console.log(chalk.yellow(`  💡 ${msgCount} messages — /compact recommended to save tokens\n`));
  }

  // Pre-send cost estimation for paid providers
  const isPaid = estimatePreCost(state.providerId, state.model, expandedInput.length).estimatedCost > 0;
  if (isPaid && state.conversation && state.conversation.length >= 2) {
    // Estimate total context cost (conversation + new prompt)
    const convText = state.conversation
      .map(m => m.content.filter(b => b.type === "text").map(b => (b as any).text || "").join(" "))
      .join(" ");
    const totalChars = convText.length + expandedInput.length;
    const pre = estimatePreCost(state.providerId, state.model, totalChars);
    const convLabel = pre.label !== "free" ? pre.label : "";
    if (convLabel) {
      console.log(chalk.dim(`  ↥ ~${pre.estimatedInputTokens.toLocaleString()} tokens est.  ${convLabel}`));
    }
  }

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
    console.log(chalk.red(`  ✗ ${err instanceof Error ? err.message : err}\n`));
    return;
  }

  // Run agent with context files and conversation history
  try {
    await streamAgent(provider, expandedInput, state.projectRoot, state.maxSteps, state);
  } catch (err) {
    console.log(chalk.red(`\n  ✗ Agent error: ${err instanceof Error ? err.message : err}\n`));
  }

  // Clear history if requested
  if (state.clearHistory) {
    state.conversation = [];
    state.clearHistory = false;
  }
}

// ── Shared Streaming Logic ─────────────────────────────────────────

/**
 * Run context compaction — summarizes conversation history using the LLM,
 * then replaces it with the compacted version to save tokens.
 */
async function runCompaction(nextPrompt: string, state: SessionState) {
  if (!state.conversation?.length) {
    console.log(chalk.yellow("  ⚠ Nothing to compact — conversation is empty.\n"));
    return;
  }

  console.log(chalk.cyan(`  ⚡ Compacting ${state.conversation.length} messages...`));

  // Build a provider just for the compaction call
  let provider;
  try {
    provider = createProvider({
      provider: state.providerId,
      apiKey: state.apiKey,
      model: state.model || undefined,
      baseUrl: state.config.baseUrl,
      temperature: 0, // deterministic for compaction
    });
  } catch (err) {
    console.log(chalk.red(`  ✗ ${err instanceof Error ? err.message : err}\n`));
    return;
  }

  // Format conversation for the compaction prompt
  const convText = state.conversation.map(m => {
    const role = m.role === "assistant" ? "Assistant" : "User";
    const texts = m.content
      .filter(b => b.type === "text")
      .map(b => (b as { text: string }).text)
      .join("\n");
    const toolCount = m.content.filter(b => b.type === "tool_use").length;
    const toolInfo = toolCount > 0 ? ` [used ${toolCount} tools]` : "";
    return `[${role}]${toolInfo} ${texts.slice(0, 2000)}`;
  }).join("\n\n");

  const compactPrompt = compactionPrompt(state.compactPending?.instructions);
  const fullPrompt = `${compactPrompt}\n\n## Conversation to summarize\n\n${convText}\n\n## Next user prompt (after compaction)\n${nextPrompt}\n\nProvide ONLY the summary. Do not include the next prompt in the summary.`;

  // Stream the compaction (non-interactive, just capture text)
  let summary = "";
  try {
    for await (const ev of provider.streamChat({
      system: "You are a context compaction tool. Output only the requested summary.",
      messages: [{ role: "user", content: [{ type: "text", text: fullPrompt }] }],
      tools: [],
      maxTokens: 2000,
    })) {
      if (ev.type === "text_delta") {
        summary += ev.text;
        process.stdout.write(chalk.dim(ev.text));
      }
    }
  } catch (err) {
    console.log(chalk.red(`\n  ✗ Compaction failed: ${err instanceof Error ? err.message : err}\n`));
    return;
  }

  // Replace conversation with compacted summary
  state.conversation = [{
    role: "user",
    content: [{ type: "text", text: `[Compacted context]\n${summary.trim()}` }],
  }];

  // Now process the actual prompt with compacted context
  const compactPrompt2 = `${summary.trim()}\n\n---\n\nUser: ${nextPrompt}`;
  console.log(chalk.green(`\n  ✓ Compacted to ~${summary.length} chars. Processing prompt...\n`));

  // Create fresh provider for the actual run
  let provider2;
  try {
    provider2 = createProvider({
      provider: state.providerId,
      apiKey: state.apiKey,
      model: state.model || undefined,
      baseUrl: state.config.baseUrl,
      temperature: state.temperature,
    });
  } catch (err) {
    console.log(chalk.red(`  ✗ ${err instanceof Error ? err.message : err}\n`));
    return;
  }

  await streamAgent(provider2, compactPrompt2, state.projectRoot, state.maxSteps, state);
}

// ── Streaming Logic ─────────────────────────────────────────────────

async function streamAgent(
  provider: ReturnType<typeof createProvider>,
  prompt: string,
  projectRoot: string,
  maxSteps: number,
  state?: SessionState,
) {
  // Load skills (reload each call so /skill reload works)
  const skills = loadSkills(projectRoot).skills;
  let spinner: Ora | null = null;
  const startTime = Date.now();

  // Collect conversation messages for history tracking
  const collectedMessages: AgentMessage[] = [];

  // Token tracking
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // Track current assistant turn
  let currentText = "";
  let currentToolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

  // Per-tool timing tracking
  const toolTimings = new Map<string, number>();

  // Syntax highlighter state
  const hstate = createHighlighter();
  let currentToolResults: ContentBlock[] = [];

  try {
    for await (const ev of runAgent(provider, {
      prompt,
      projectRoot,
      maxSteps,
      contextFiles: state?.contextFiles,
      history: state?.conversation?.length ? state.conversation : undefined,
      temperature: state?.temperature,
      skills,
    })) {
      switch (ev.type) {
        case "status": {
          const label = ev.label || ev.phase || "";
          const icon = phaseIcon(ev.phase || "");
          // Smoother spinner — only for plan/act phases
          if (ev.phase === "plan") {
            if (spinner) spinner.text = chalk.blue(`${icon} ${label}`);
            else spinner = ora({ text: chalk.blue(`${icon} ${label}`), color: "blue" }).start();
          } else if (ev.phase === "act") {
            const liveTokens = totalInputTokens > 0 ? chalk.dim(`  ↥${totalInputTokens.toLocaleString()} tokens`) : "";
            if (spinner) spinner.text = chalk.blue(`${icon} ${label} ${liveTokens}`);
            else spinner = ora({ text: chalk.blue(`${icon} ${label} ${liveTokens}`), color: "blue" }).start();
          } else {
            if (spinner) { spinner.stop(); spinner = null; }
            if (ev.phase === "settle") {
              // done is handled separately
            } else {
              console.log(chalk.dim(`  ${icon} ${label}`));
            }
          }
          break;
        }

        case "assistant_delta":
          if (spinner) { spinner.stop(); spinner = null; }
          // First text chunk — clean prefix
          if (!currentText) process.stdout.write(chalk.dim("  ┃ "));
          process.stdout.write(highlightChunk(hstate, ev.text!));
          currentText += ev.text!;
          break;

        case "assistant_stop":
          if (currentText) process.stdout.write("\n");
          break;

        case "tool_call": {
          if (spinner) { spinner.stop(); spinner = null; }
          // Show tool call with cleaner icon
          const title = ev.toolTitle || ev.toolName || "";
          console.log(`  ${chalk.cyan("◇")} ${chalk.cyan(title)}`);
          currentToolCalls.push({ id: ev.toolId!, name: ev.toolName!, input: ev.toolInput! });
          // Track when this tool started for duration display
          toolTimings.set(ev.toolId!, Date.now());
          break;
        }

        case "tool_result": {
          // Compute elapsed time for this tool
          const toolStart = toolTimings.get(ev.toolId ?? "");
          const elapsedStr = toolStart ? chalk.dim(`[${((Date.now() - toolStart) / 1000).toFixed(1)}s]`) : "";
          toolTimings.delete(ev.toolId ?? "");

          if (ev.toolOk) {
            const out = shorten(ev.toolOutput || "", 100);
            console.log(`  ${chalk.dim("┆")} ${chalk.green("✓")} ${chalk.dim(out)} ${elapsedStr}`);
          } else {
            const out = shorten(ev.toolOutput || "", 100);
            console.log(`  ${chalk.dim("┆")} ${chalk.red("✗")} ${chalk.red(out)} ${elapsedStr}`);
          }
          currentToolResults.push({
            type: "tool_result",
            tool_use_id: ev.toolId!,
            content: ev.toolOutput || "",
            is_error: !ev.toolOk,
          });
          break;
        }

        case "usage":
          totalInputTokens += ev.inputTokens ?? 0;
          totalOutputTokens += ev.outputTokens ?? 0;
          // Track in session state for /tokens command
          if (state) {
            state.totalInputTokens = (state.totalInputTokens ?? 0) + (ev.inputTokens ?? 0);
            state.totalOutputTokens = (state.totalOutputTokens ?? 0) + (ev.outputTokens ?? 0);
          }
          break;

        case "error":
          if (spinner) spinner.stop();
          console.log(chalk.red(`\n  ✗ ${ev.message}`));
          break;

        case "done":
          if (spinner) { spinner.stop(); spinner = null; }
          // Flush any remaining highlighted buffer
          if (hstate.buffer) {
            process.stdout.write(hstate.inBlock ? highlightCode(hstate.buffer, hstate.lang) : hstate.buffer);
            hstate.buffer = "";
          }
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const stepStr = `${ev.steps} step${ev.steps !== 1 ? "s" : ""}`;

          // Build compact summary line with tokens + cost estimate
          const usageParts: string[] = [];
          if (totalInputTokens > 0 || totalOutputTokens > 0) {
            usageParts.push(`↥${totalInputTokens.toLocaleString()} ↧${totalOutputTokens.toLocaleString()}`);
            // Cost estimate
            if (state) {
              const { label } = estimateCost(state.providerId, state.model, totalInputTokens, totalOutputTokens);
              if (label !== "free" && label !== "unknown") usageParts.push(label);
            }
          }
          const summaryStr = usageParts.length > 0 ? `  ${chalk.dim(usageParts.join("  "))}` : "";

          // Clean boxed summary
          const left = chalk.green("✓");
          const time = chalk.dim(`${elapsed}s`);
          console.log(`  ${chalk.dim("┌─")} ${left} ${chalk.bold.white(stepStr)} ${time}${summaryStr}`);

          // Hint: next steps
          if (state) {
            const msgCount = (state.conversation?.length ?? 0) + 2;
            if (msgCount > 15) {
              const estCtx = ((msgCount * 2000) / 1000).toFixed(0);
              console.log(`  ${chalk.dim("│")} ${chalk.dim(`💡 ${msgCount} msgs (~${estCtx}K ctx) — /compact to save tokens`)}`);
            }
          }
          console.log(`  ${chalk.dim("└─")}`);
          console.log();
          // Terminal bell notification
          process.stdout.write("\x07");
          break;
      }
    }
  } catch (err) {
    if (spinner) spinner.stop();
    if (err instanceof LLMError) {
      console.error(chalk.red(`\n  ✗ LLM Error: ${err.message}\n`));
    } else {
      console.error(chalk.red(`\n  ✗ ${err instanceof Error ? err.message : err}\n`));
    }
    // Don't save partial state on error
    return;
  }

  // Save conversation to session state
  if (state) {
    try {
      // Push user prompt
      state.conversation = state.conversation ?? [];
      state.conversation.push({
        role: "user",
        content: [{ type: "text", text: prompt }],
      });
      // Push assistant response
      const assistantBlocks: ContentBlock[] = [];
      if (currentText) assistantBlocks.push({ type: "text", text: currentText });
      for (const tc of currentToolCalls) {
        assistantBlocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
      }
      if (assistantBlocks.length > 0) {
        state.conversation.push({ role: "assistant", content: assistantBlocks });
      }
      // Push tool results as a user message (so agent sees them)
      if (currentToolResults.length > 0) {
        state.conversation.push({ role: "user", content: currentToolResults });
      }
    } catch {
      // Non-fatal: conversation tracking failed but agent completed
    }
  }
}

// ── Bash Execution ─────────────────────────────────────────────────

function runBash(command: string, returnOutput: boolean): string {
  try {
    const output = cp.execSync(command, {
      cwd: process.cwd(),
      timeout: 30_000,
      encoding: "utf-8",
      maxBuffer: 500_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const text = output.trim();
    if (!returnOutput) {
      console.log(chalk.dim(text || "(no output)"));
    }
    return text;
  } catch (err: any) {
    const text = err.stderr || err.message || String(err);
    console.log(chalk.red(text.slice(0, 500)));
    return text;
  }
}

// ── History ────────────────────────────────────────────────────────

function loadHistory(file: string): string[] {
  try {
    if (fs.existsSync(file)) {
      return fs.readFileSync(file, "utf-8").split("\n").filter(Boolean).slice(-500);
    }
  } catch {}
  return [];
}

function saveLine(file: string, line: string) {
  try {
    fs.appendFileSync(file, line + "\n");
  } catch {}
}

function saveHistory(file: string, rl: readline.Interface) {
  try {
    const lines = (rl as any).history as string[] | undefined;
    if (lines?.length) {
      fs.writeFileSync(file, [...new Set(lines)].slice(-500).join("\n") + "\n");
    }
  } catch {}
}

// ── Helpers ────────────────────────────────────────────────────────

function shorten(text: string, max: number): string {
  const lines = text.split("\n");
  const first = lines[0].trim();
  if (first.length <= max) return first;
  return first.slice(0, max - 3) + "...";
}

// ── Syntax Highlighting ─────────────────────────────────────────────
// See src/highlight.ts for the implementation (createHighlighter, highlightChunk, highlightCode)

/**
 * Expand @file references in the prompt.
 *   @path/to/file.ts → injects file content as a markdown code block
 *   @path/to/file.ts:10-20 → injects lines 10-20 only
 * Only works for existing files. Non-existent paths stay as-is.
 */
function expandFileRefs(input: string, projectRoot: string): string {
  // Match @<path> — files with or without extension, optional :line-range
  const re = /(?:^|\s)@([^\s:]+(?:\.[a-zA-Z]{1,10})?(?::\d+(?:-\d+)?)?)(?=\s|$)/g;
  
  let result = input;
  let match: RegExpExecArray | null;
  let expanded = false;

  while ((match = re.exec(input)) !== null) {
    const ref = match[1];
    let filePath = ref;
    let lineRange: string | undefined;
    
    // Parse :line-range syntax
    const colonIdx = ref.lastIndexOf(":");
    if (colonIdx > 0) {
      const after = ref.slice(colonIdx + 1);
      if (/^\d+(-\d+)?$/.test(after)) {
        filePath = ref.slice(0, colonIdx);
        lineRange = after;
      }
    }

    // Resolve path relative to project root
    const absPath = path.isAbsolute(filePath) 
      ? filePath 
      : path.resolve(projectRoot, filePath);

    if (!fs.existsSync(absPath)) continue;
    
    try {
      const stat = fs.statSync(absPath);
      if (stat.isDirectory()) continue; // skip directories
      
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
        // Limit large files to 500 lines
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
      expanded = true;
    } catch {
      // skip unreadable files
    }
  }

  return expanded ? result : input;
}

// ── CLI Entry ──────────────────────────────────────────────────────

const program = new Command();

program
  .name("arx")
  .description("ArxCode CLI — autonomous coding agent. Private AI builder. BYOK.")
  .version(VERSION)
  .argument("[prompt]", "What do you want to build? (omit for interactive mode)")
  .option("-p, --provider <provider>", "Model provider: anthropic, openai, groq, deepseek, openrouter, xai, google, custom")
  .option("-m, --model <model>", "Model name (e.g. claude-sonnet-4-8)")
  .option("-k, --key <key>", "API key for the provider")
  .option("-d, --project <dir>", "Project directory", process.cwd())
  .option("--max-steps <n>", "Maximum agent steps", "24")
  .option("--base-url <url>", "Custom base URL for OpenAI-compatible providers")
  .option("--tui", "Launch terminal user interface (Ink/React mode)")
  .action(async (prompt: string | undefined, opts: Record<string, string>) => {
    if (prompt) {
      // One-shot mode
      await runOneShot(prompt, opts);
    } else if (opts.tui) {
      // TUI mode
      await runTui(opts);
    } else {
      // Interactive REPL mode
      await runInteractive(opts);
    }
  });

// ── Recipe subcommand ────────────────────────────────────────────────

const recipeCmd = program
  .command("recipe")
  .description("Manage and run prompt recipes");

recipeCmd
  .command("list")
  .description("List all available recipes")
  .action(() => {
    console.log(formatRecipeList(loadRecipes()));
  });

recipeCmd
  .command("init")
  .description("Create built-in recipes")
  .action(() => {
    const created = initBuiltinRecipes();
    console.log(chalk.green(`  ✓ Created ${created.length} built-in recipes in ~/.arx/recipes/\n`));
    for (const f of created) console.log(chalk.dim(`  ${f}`));
    console.log(`\n  ${chalk.dim("Run: arx recipe list")}`);
  });

recipeCmd
  .command("show")
  .description("Show a recipe's full content")
  .argument("<name>", "Recipe name")
  .action((name: string) => {
    const recipe = getRecipe(name);
    if (!recipe) {
      console.log(chalk.red(`  ✗ Recipe "${name}" not found.`));
      process.exit(1);
    }
    console.log(formatRecipeShow(recipe));
  });

recipeCmd
  .command("run")
  .description("Run a recipe as a one-shot agent prompt (REPL only)")
  .argument("<name>", "Recipe name")
  .argument("[vars...]", "key=value variable values")
  .action((name: string, vars: string[]) => {
    console.log(chalk.yellow(`  ⚠ "arx recipe run" works best in interactive mode (/recipe run)`));
    console.log(chalk.dim(`  Recipe: ${name}`));
    console.log(chalk.dim(`  Run: arx "recipe run ${name} ${vars.join(" ")}" from interactive mode\n`));
    const recipe = getRecipe(name);
    if (!recipe) {
      console.log(chalk.red(`  ✗ Recipe "${name}" not found.`));
      process.exit(1);
    }
    const inlineVars: Record<string, string> = {};
    for (const v of vars) {
      const eq = v.indexOf("=");
      if (eq !== -1) inlineVars[v.slice(0, eq)] = v.slice(eq + 1).replace(/^"|"$/g, "");
    }
    const { values, missing } = resolveVars(recipe, inlineVars);
    if (missing.length > 0) {
      console.log(chalk.red(`  ✗ Missing required variables: ${missing.join(", ")}\n`));
      console.log(chalk.dim(`  Usage: arx recipe run ${name} ${recipe.variables.map(v => `${v.name}=<value>`).join(" ")}`));
      process.exit(1);
    }
    console.log(chalk.cyan(`  ${substituteVars(recipe.body, values)}\n`));
  });

recipeCmd
  .command("delete")
  .description("Delete a recipe")
  .argument("<name>", "Recipe name")
  .action((name: string) => {
    if (!deleteRecipe(name)) {
      console.log(chalk.red(`  ✗ Recipe "${name}" not found.`));
      process.exit(1);
    }
    console.log(chalk.green(`  ✓ Deleted recipe: ${name}`));
  });

program.parse();
