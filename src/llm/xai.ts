/**
 * xAI (Grok) provider — OpenAI-compatible API at api.x.ai.
 * Models: grok-4, grok-4-mini, grok-3, etc.
 */

import { createOpenAICompatibleProvider } from "./openai.js";
import type { LLMProvider } from "./types.js";
import { PROVIDER_REGISTRY } from "./types.js";

const meta = PROVIDER_REGISTRY.xai;

export function createXAIProvider(apiKey: string, model?: string): LLMProvider {
  return createOpenAICompatibleProvider({
    apiKey,
    model: model || meta.defaultModel,
    baseUrl: meta.baseUrl,
    providerId: "xai",
  });
}
