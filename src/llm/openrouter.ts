/**
 * OpenRouter provider — unified API for 200+ models.
 * OpenAI-compatible API at openrouter.ai.
 * Models: "anthropic/claude-sonnet-4", "openai/gpt-5.1", "deepseek/deepseek-chat", etc.
 *
 * Format: <provider>/<model>
 */

import { createOpenAICompatibleProvider } from "./openai.js";
import type { LLMProvider } from "./types.js";
import { PROVIDER_REGISTRY } from "./types.js";

const meta = PROVIDER_REGISTRY.openrouter;

export function createOpenRouterProvider(apiKey: string, model?: string): LLMProvider {
  return createOpenAICompatibleProvider({
    apiKey,
    model: model || meta.defaultModel,
    baseUrl: meta.baseUrl,
    providerId: "openrouter",
  });
}
