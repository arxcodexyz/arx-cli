/**
 * Provider-agnostic LLM layer — ported from ArxCode Studio dapp.
 * The agent harness speaks only these normalized types.
 *
 * Most providers use the OpenAI-compatible API, just with different base URLs.
 */

export type Role = "user" | "assistant";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

export interface AgentMessage {
  role: Role;
  content: ContentBlock[];
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  input_schema: Record<string, unknown>;
}

export interface StreamOptions {
  system: string;
  messages: AgentMessage[];
  tools: ToolDef[];
  maxTokens?: number;
  signal?: AbortSignal;
  /** Temperature (0-2). Default: provider default (usually ~0.7) */
  temperature?: number;
}

/** Normalized events a provider streams back to the harness. */
export type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "stop"; reason: string };

export interface LLMProvider {
  readonly id: string;
  readonly model: string;
  streamChat(opts: StreamOptions): AsyncGenerator<ProviderEvent, void, unknown>;
}

// ── Providers ──────────────────────────────────────────────────────
// All known providers. Many share the OpenAI-compatible API.

export type ProviderId =
  | "anthropic"
  | "openai"
  | "groq"
  | "deepseek"
  | "deepseek-anthropic"
  | "openrouter"
  | "xai"
  | "google"
  | "custom"; // custom base URL

export interface ProviderConfig {
  provider: ProviderId;
  apiKey: string;
  model?: string;
  /** For custom / openai-compatible providers, override the base URL */
  baseUrl?: string;
  /** Temperature (0-2). Omit for provider default. */
  temperature?: number;
}

/** Provider metadata — used for CLI display and key resolution */
export interface ProviderMeta {
  id: ProviderId;
  name: string;
  /** The API protocol this provider speaks */
  api: "anthropic-messages" | "openai-completions" | "google-generative-ai";
  baseUrl: string;
  /** Default model if none specified */
  defaultModel: string;
  /** Env var name for API key */
  keyEnv: string;
  /** Description for CLI */
  description: string;
}

/** Registry of all known providers */
export const PROVIDER_REGISTRY: Record<ProviderId, ProviderMeta> = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic (Claude)",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1/messages",
    defaultModel: "claude-sonnet-4-8",
    keyEnv: "ANTHROPIC_API_KEY",
    description: "Claude Opus, Sonnet, Haiku — best for complex coding",
  },
  openai: {
    id: "openai",
    name: "OpenAI (ChatGPT)",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1/chat/completions",
    defaultModel: "gpt-5.1",
    keyEnv: "OPENAI_API_KEY",
    description: "GPT-5.1, GPT-5 — all-around strong",
  },
  groq: {
    id: "groq",
    name: "Groq (LPU)",
    api: "openai-completions",
    baseUrl: "https://api.groq.com/openai/v1/chat/completions",
    defaultModel: "meta-llama/llama-4-scout-17b-16e-instruct",
    keyEnv: "GROQ_API_KEY",
    description: "Llama models at insane speed — free tier available",
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com/v1/chat/completions",
    defaultModel: "deepseek-v4-pro",
    keyEnv: "DEEPSEEK_API_KEY",
    description: "V4 Pro, V4 Flash — cheap & powerful, $0.14/M tokens",
  },
  "deepseek-anthropic": {
    id: "deepseek-anthropic",
    name: "DeepSeek (Anthropic API)",
    api: "anthropic-messages",
    baseUrl: "https://api.deepseek.com/anthropic/v1/messages",
    defaultModel: "deepseek-v4-pro",
    keyEnv: "DEEPSEEK_API_KEY",
    description: "DeepSeek via Anthropic Messages API — Claude Code compatible",
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    defaultModel: "anthropic/claude-sonnet-4",
    keyEnv: "OPENROUTER_API_KEY",
    description: "Access 200+ models through one API — any model, one key",
  },
  xai: {
    id: "xai",
    name: "xAI (Grok)",
    api: "openai-completions",
    baseUrl: "https://api.x.ai/v1/chat/completions",
    defaultModel: "grok-4",
    keyEnv: "XAI_API_KEY",
    description: "Grok-4 — xAI's flagship model",
  },
  google: {
    id: "google",
    name: "Google Gemini",
    api: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    defaultModel: "gemini-2.5-pro",
    keyEnv: "GOOGLE_API_KEY",
    description: "Gemini 2.5 Pro/Flash — 1M token context",
  },
  custom: {
    id: "custom",
    name: "Custom (OpenAI-compatible)",
    api: "openai-completions",
    baseUrl: "",
    defaultModel: "",
    keyEnv: "CUSTOM_API_KEY",
    description: "Any OpenAI-compatible endpoint — set baseUrl in config",
  },
};

export class LLMError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LLMError";
  }
}
