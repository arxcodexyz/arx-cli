/**
 * Provider factory — the single swap point.
 * Harness never knows which provider it's talking to.
 */

import { createAnthropicProvider } from "./anthropic.js";
import { createOpenAIProvider, createOpenAICompatibleProvider } from "./openai.js";
import { createGroqProvider } from "./groq.js";
import { createDeepSeekProvider } from "./deepseek.js";
import { createDeepSeekAnthropicProvider } from "./deepseek-anthropic.js";
import { createOpenRouterProvider } from "./openrouter.js";
import { createXAIProvider } from "./xai.js";
import { createGoogleProvider } from "./google.js";
import {
  type LLMProvider,
  LLMError,
  type ProviderConfig,
  PROVIDER_REGISTRY,
} from "./types.js";

export * from "./types.js";
export { createOpenAICompatibleProvider } from "./openai.js";

/** Build a provider from config. The single swap point — harness never knows. */
export function createProvider(cfg: ProviderConfig): LLMProvider {
  // Resolve key and base URL from registry
  const meta = PROVIDER_REGISTRY[cfg.provider];
  const apiKey = cfg.apiKey;
  const model = cfg.model || meta?.defaultModel;

  if (!apiKey) {
    const envHint = meta ? meta.keyEnv : "API key";
    throw new LLMError(
      `Missing ${meta?.name || cfg.provider} API key. Set ${envHint} or pass --key.`,
      401,
    );
  }

  switch (cfg.provider) {
    case "anthropic":
      return createAnthropicProvider(apiKey, model);

    case "openai":
      return createOpenAIProvider(apiKey, model);

    case "groq":
      return createGroqProvider(apiKey, model);

    case "deepseek":
      return createDeepSeekProvider(apiKey, model);

    case "deepseek-anthropic":
      return createDeepSeekAnthropicProvider(apiKey, model);

    case "openrouter":
      return createOpenRouterProvider(apiKey, model);

    case "xai":
      return createXAIProvider(apiKey, model);

    case "google":
      return createGoogleProvider(apiKey, model);

    case "custom":
      if (!cfg.baseUrl) {
        throw new LLMError(
          "Custom provider requires --base-url or baseUrl in config.",
          400,
        );
      }
      return createOpenAICompatibleProvider({
        apiKey,
        model,
        baseUrl: cfg.baseUrl,
        providerId: "custom",
      });

    default:
      throw new LLMError(`Unknown provider: ${cfg.provider}`, 400);
  }
}
