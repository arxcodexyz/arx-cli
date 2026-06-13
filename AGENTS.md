# ArxCode CLI

This is the ArxCode CLI project — an autonomous coding agent.

## Conventions
- TypeScript with strict mode
- Use `npx tsc --noEmit` to typecheck before build
- Run `npx tsc` to build
- Node.js 22+, ES modules
- Use `biome` for linting (when available)
- Chalk for terminal colors, Commander for CLI args

## Architecture
- `src/llm/` — Provider layer (8 providers, most OpenAI-compatible)
- `src/harness.ts` — Agent loop (plan → act → observe → verify → settle)
- `src/tools.ts` — Real filesystem tools
- `src/commands.ts` — Slash command registry
- `src/config.ts` — BYOK config
- `bin/arx.ts` — CLI entry point

## Testing
- No test suite yet — test manually with `node dist/bin/arx.js`
