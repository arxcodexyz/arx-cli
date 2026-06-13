/**
 * Google Gemini provider — OpenAI-compatible endpoint.
 * Google provides an OpenAI-compatible API at:
 *   https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
 *
 * Models: gemini-2.5-pro, gemini-2.5-flash, etc.
 */

import { createOpenAICompatibleProvider } from "./openai.js";
import type { LLMProvider } from "./types.js";
import { PROVIDER_REGISTRY } from "./types.js";

const meta = PROVIDER_REGISTRY.google;

export function createGoogleProvider(apiKey: string, model?: string): LLMProvider {
  return createOpenAICompatibleProvider({
    apiKey,
    model: model || meta.defaultModel,
    baseUrl: meta.baseUrl,
    providerId: "google",
  });
}
