# ArxCode CLI

<div align="center">

**Private AI coding agent. Real filesystem. BYOK. Terminal-native.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://typescriptlang.org)

</div>

ArxCode CLI is an autonomous coding agent that runs **locally on your machine** with access to your **real filesystem** and **real shell**. No cloud lock-in, no VFS simulation, no training on your code. You bring your own API keys (BYOK) and we get out of the way.

---

## Features

- 🔒 **100% Private** — runs on your machine. Code never leaves except to your chosen model provider.
- 🔑 **BYOK** — bring your own API keys. Support for 9 providers: Groq (free!), DeepSeek, OpenAI, Anthropic, OpenRouter, xAI, Google Gemini, DeepSeek Anthropic, and any OpenAI-compatible custom endpoint.
- 💬 **Interactive REPL** — slash commands: `/model`, `/provider`, `/temp`, `/save`, `/load`, `/compact`, and more.
- 📎 **@file references** — `@path/to/file.ts` injects file contents into your prompt. Supports line ranges (`@file.ts:10-20`).
- 📊 **Token counter** — `/tokens` shows session token breakdown with cost estimates. Per-exchange token display (↥input ↧output).
- 🔄 **Context compaction** — `/compact` summarizes long conversations to save tokens.
- 🌐 **Web search** — `/search` slash command + `web_search` agent tool via Whoogle. Get up-to-date docs, API refs, package versions.
- 🔍 **Code review** — `/review` analyzes git diffs, staged changes, branches, commits with security & style checks.
- 📝 **AI commit messages** — `/commit` auto-generates conventional commit messages from staged diffs.
- 🎨 **Syntax highlighting** — code blocks in agent responses get keyword/string/comment coloring.
- 📂 **Auto-load context** — scans `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, and more.
- 🎨 **Beautiful terminal** — ASCII banner, colors (Chalk), spinners (Ora), clean output.
- 👥 **Multi-line input** — end a line with `\\` for multi-line prompts.
- 💾 **Session save/load** — `/save mywork` and `/load mywork` to persist conversations.
- 📤 **Session export** — `/export` saves conversation to markdown.
- 🗂️ **Git diff viewer** — `/diff` shows colorized git diffs from the REPL.
- 🌡️ **Temperature control** — `/temp 0.5` for focused, `/temp 1.5` for creative.
- ⚡ **Blazing fast** — Groq LPU free tier gives sub-second responses.
- 🐚 **Shell integration** — `!command` sends output to agent, `!!command` just runs it.
- 🛠️ **15 agent tools** — `replace_in_file`, `search`, `find_files`, `web_search`, `git_diff/log/status`, `run_command`, `run_tests`, `generate_wallet`, `wallet_balance`, and more. Read tools run in parallel for speed.
- 🪙 **Token efficiency** — minified tool definitions, smart output truncation, reduced workspace scan, auto-compaction hints cut token burn ~40%.
- ⚡ **Parallel execution** — read-only tools run simultaneously. Write tools run sequentially to avoid conflicts.
- 📋 **Tab auto-complete** — slash commands, model names, provider IDs, @file paths.
- 🔄 **Streaming toggle** — `/stream off` for one-shot mode, `/stream on` for real-time.`

---

## Installation

### Prerequisites

- **Node.js 22+** (ES modules, native fetch, ReadableStream)
- **npm** or **pnpm**

### Install globally via Git

```bash
# Clone
git clone https://github.com/arxcodexyz/arx-cli.git
cd arx-cli

# Install & build
npm install
npm run build

# Link globally
npm link
```

Now `arx` is available from any directory:

```bash
arx                     # interactive REPL
arx "build a REST API"  # one-shot mode
arx --help              # show options
```

### Uninstall

```bash
npm unlink -g arx-cli
```

---

## Quick Start

### 1. Get an API key (free!)

**Groq (free tier)** — fastest way to start:
```bash
# 1. Get your free key at https://console.groq.com/keys (no credit card)
# 2. Set it:
export GROQ_API_KEY=gsk_yourkeyhere
```

**DeepSeek (cheap, $0.14/M tokens)**:
```bash
export DEEPSEEK_API_KEY=sk-yourkeyhere
```

**Anthropic / OpenAI / OpenRouter / xAI / Google**:
```bash
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
export OPENROUTER_API_KEY=sk-or-...
export XAI_API_KEY=...
export GOOGLE_API_KEY=...
```

### 2. Run it

```bash
arx
```

### 3. Switch provider & model

```
/provider groq
/model llama-4-scout
```

### 4. Start coding

```
build a todo app with Express and SQLite
```

---

## Configuration

ArxCode CLI resolves configuration in this order (higher = wins):

1. **Environment variables** (e.g., `GROQ_API_KEY`, `ARX_PROVIDER`)
2. **Project config** — `.arxrc.yaml` in your project root
3. **Global config** — `~/.arxrc.yaml`

### `~/.arxrc.yaml` example

```yaml
provider: groq
model: meta-llama/llama-4-scout-17b-16e-instruct
maxSteps: 24
keys:
  groq: gsk_...
  deepseek: sk-...
  anthropic: sk-ant-...
models:
  groq: llama-4-scout
  deepseek: deepseek-v4-pro
```

### Environment variables

| Variable | Description |
|----------|-------------|
| `ARX_PROVIDER` | Default provider (groq, deepseek, openai, etc.) |
| `ARX_MODEL` | Default model |
| `ARX_BASE_URL` | Custom base URL for openai-compatible |
| `ARX_MAX_STEPS` | Max agent steps (default: 24) |
| Provider keys | `GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, etc. |

---

## Providers

| Provider | API | Free Tier | Best For |
|----------|-----|-----------|----------|
| **Groq** | OpenAI | ✅ Yes | Fastest, free models (Llama 4 Scout) |
| **DeepSeek** | OpenAI | ❌ ($0.14/M) | Cheap & powerful, V4 Pro/Flash |
| **DeepSeek (Anthropic)** | Anthropic | ❌ | Claude Code compatible |
| **OpenAI** | OpenAI | ❌ | GPT-5.1, all-around strong |
| **Anthropic** | Anthropic | ❌ | Claude Sonnet/Opus, complex coding |
| **OpenRouter** | OpenAI | ❌ | 200+ models, one key |
| **xAI** | OpenAI | ❌ | Grok-4 |
| **Google Gemini** | OpenAI | ✅ Yes | 1M context, Gemini 2.5 |
| **Custom** | OpenAI | — | Any OpenAI-compatible endpoint |

Switch providers anytime:
```
/provider groq
/provider deepseek
```

---

## Interactive REPL

Run `arx` without arguments to enter interactive mode:

```
arx
```

### Slash Commands

| Command | Description |
|---------|-------------|
| `/model [name]` | Show or switch model |
| `/provider [name]` | Show or switch provider |
| `/temp [0-2]` | Show or set temperature |
| `/config` | Show current configuration |
| `/tools` | List available tools |
| `/project [dir]` | Show or change project root |
| `/session` | Show session info |
| `/key <***>` | Set API key for current provider |
| `/clear` | Start fresh session |
| `/compact [instr]` | Compress conversation context |
| `/reload` | Re-scan project context files |
| `/save <name>` | Save current session |
| `/load <name>` | Load a saved session |
| `/sessions` | List saved sessions |
| `/review [target]` | Code review — unstaged, staged, branch, commit |
| `/commit [--amend]` | AI generate commit message from staged diff |
| `/export [path]` | Export conversation to markdown |
| `/search <query>` | Search the web via Whoogle |
| `/diff [target]` | View colorized git diff |
| `/status` | Git working tree status |
| `/log [n]` | Recent git commits (default: 10) |
| `/find <pattern>` | Find files by name glob |
| `/stream [on|off]` | Toggle streaming mode |
| `/help` | Show all commands |
| `/quit` | Exit |

### Shell Commands
```
!ls -la        → run command, send output to agent
!!npm test     → run command, just display output
```

### @file References
```
@src/server.ts           → inject entire file
@src/auth.ts:10-20       → inject lines 10-20
@README.md               → inject project docs
```

### Multi-line Input
```
build a REST API with: \
  - Express routes         \
  - SQLite database        \
  - JWT auth middleware
```
(End with empty line to submit)

---

## How It Works

ArxCode CLI runs a **plan → act → observe → verify → settle** loop:

1. **Plan** — the agent reads your prompt plus workspace context
2. **Act** — it uses real filesystem tools (read, write, delete, search) and shell commands
3. **Observe** — tool outputs feed back into the agent
4. **Verify** — builds run, tests execute, errors get fixed
5. **Settle** — agent stops when the task is done

### Available Tools

| Tool | What it does |
|------|-------------|
| `list_files` | List directory contents |
| `read_file` | Read file with line numbers |
| `write_file` | Create or overwrite a file |
| `delete_file` | Remove a file |
| `search` | Search text across project |
| `run_command` | Execute shell commands |
| `run_tests` | Run project test suite |
| `web_search` | Search the web via Whoogle (up-to-date docs, APIs, versions) |
| `replace_in_file` | Targeted find-and-replace in a file (preferred over write_file) |
| `find_files` | Find files by name pattern (glob) |
| `git_diff` | Show working tree diff |
| `git_log` | Show commit history |
| `git_status` | Working tree status — staged, unstaged, untracked |

All tools operate on your **real filesystem** — no mocking, no simulation.

---

## Architecture

```
arx-cli/
├── bin/arx.ts              # CLI entry: REPL, one-shot, banner, history
├── src/
│   ├── harness.ts          # Agent loop (plan→act→observe→verify→settle)
│   ├── tools.ts            # Real filesystem tools (fs, execSync, grep)
│   ├── prompts.ts          # System prompt + context injection
│   ├── commands.ts         # Slash command registry
│   ├── config.ts           # BYOK config loader (env, YAML)
│   ├── context.ts          # Context file scanner (AGENTS.md, etc.)
│   ├── banner.ts           # ASCII art banner
│   └── llm/
│       ├── types.ts        # Provider-agnostic types
│       ├── index.ts        # Provider factory (single swap point)
│       ├── anthropic.ts    # Anthropic Messages API
│       ├── openai.ts       # Generic OpenAI-compatible (base for 6 providers)
│       ├── deepseek.ts     # DeepSeek (OpenAI endpoint)
│       ├── deepseek-anthropic.ts  # DeepSeek (Anthropic-compatible endpoint)
│       ├── groq.ts         # Groq LPU wrapper
│       ├── openrouter.ts   # OpenRouter wrapper
│       ├── xai.ts          # xAI wrapper
│       ├── google.ts       # Google Gemini wrapper
│       └── sse.ts          # SSE stream parser
├── package.json
├── tsconfig.json
└── README.md
```

---

## Contributing

### Setup

```bash
# Clone & install
git clone https://github.com/arxcodexyz/arx-cli.git
cd arx-cli
npm install

# Build (TypeScript → dist/)
npm run build

# Link for local development
npm link

# Typecheck without building
npx tsc --noEmit

# Run locally
node dist/bin/arx.js "say hello"
```

### Conventions

- **TypeScript** with strict mode
- **ES modules** (import/export)
- Use `npx tsc` to compile
- Chalk for terminal colors, Commander for CLI args
- Provider layer kept generic — most use OpenAI-compatible base

### Adding a new provider

1. Create `src/llm/<new>.ts` — implement `LLMProvider` interface
2. Add provider metadata to `PROVIDER_REGISTRY` in `src/llm/types.ts`
3. Add case in `createProvider()` in `src/llm/index.ts`
4. Add model presets in `src/commands.ts`
5. Add to README provider table

Most providers can simply wrap `createOpenAICompatibleProvider()` with a custom `baseUrl`:

```typescript
import { createOpenAICompatibleProvider } from "./openai.js";
import type { LLMProvider } from "./types.js";

export function createMyProvider(apiKey: string, model?: string): LLMProvider {
  return createOpenAICompatibleProvider({
    apiKey,
    model: model || "my-model",
    baseUrl: "https://api.my-provider.com/v1/chat/completions",
    providerId: "my-provider",
  });
}
```

### Commit style

- `feat:` — new feature
- `fix:` — bug fix
- `chore:` — maintenance, gitignore, deps
- `docs:` — documentation

### Roadmap

- [x] Web search integration (Whoogle)
- [x] Syntax highlighting in responses
- [x] Auto-complete for slash commands
- [x] Tab auto-complete (/model, /provider, @file)
- [x] Code review (/review)
- [x] AI commit messages (/commit)
- [x] Session export (/export)
- [x] Git diff viewer (/diff)
- [x] Git status/log tools
- [x] replace_in_file (targeted edits)
- [x] find_files (glob search)
- [x] Streaming toggle (/stream)
- [x] Parallel tool execution (read tools simultaneous)
- [x] Token efficiency — minified defs, smart truncation, auto-compaction
- [x] `/tokens` command with cost estimates
- [x] `/alias` command shortcuts
- [x] `/setup` provider wizard
- [x] Wallet generation (/wallet) + balance check (/balance)
- [ ] TUI mode (Ink/React terminal UI)
- [ ] Skills/extension system
- [ ] Remote/SSH agent mode

---

## License

MIT © 2026 [ArxCode](https://github.com/arxcodexyz)

---

<div align="center">
  <sub>Built with privacy. Powered by your own keys.</sub>
</div>
