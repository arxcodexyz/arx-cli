/**
 * DeepSeek provider — OpenAI-compatible API at api.deepseek.com.
 * Models: deepseek-chat (V3), deepseek-reasoner (R1).
 */

import { createOpenAICompatibleProvider } from "./openai.js";
import type { LLMProvider } from "./types.js";
import { PROVIDER_REGISTRY } from "./types.js";

const meta = PROVIDER_REGISTRY.deepseek;

export function createDeepSeekProvider(apiKey: string, model?: string): LLMProvider {
  return createOpenAICompatibleProvider({
    apiKey,
    model: model || meta.defaultModel,
    baseUrl: meta.baseUrl,
    providerId: "deepseek",
  });
}
