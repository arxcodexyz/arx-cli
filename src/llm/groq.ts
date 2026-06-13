/**
 * Groq provider — wraps OpenAI-compatible provider with Groq's base URL.
 * Groq speaks OpenAI Chat Completions API at api.groq.com.
 */

import { createOpenAICompatibleProvider } from "./openai.js";
import type { LLMProvider } from "./types.js";
import { PROVIDER_REGISTRY } from "./types.js";

const meta = PROVIDER_REGISTRY.groq;

export function createGroqProvider(apiKey: string, model?: string): LLMProvider {
  return createOpenAICompatibleProvider({
    apiKey,
    model: model || meta.defaultModel,
    baseUrl: meta.baseUrl,
    providerId: "groq",
  });
}
