/**
 * Pricing data for all LLM providers.
 * Prices in USD per 1M tokens (input / output).
 * Last updated: 2026-06-15
 */

import type { ProviderId } from "./config.js";

export interface Pricing {
  /** Price per 1M input tokens (USD) */
  input: number;
  /** Price per 1M output tokens (USD) */
  output: number;
  /** Cache write price per 1M tokens (USD) — only some providers */
  cacheWrite?: number;
  /** Cache read price per 1M tokens (USD) */
  cacheRead?: number;
}

/** All known provider pricing. Prices are per 1M tokens. */
export const PROVIDER_PRICING: Record<ProviderId, Record<string, Pricing>> = {
  anthropic: {
    "claude-opus-4-8": { input: 15.0, output: 75.0, cacheWrite: 18.75, cacheRead: 1.5 },
    "claude-opus-4": { input: 15.0, output: 75.0, cacheWrite: 18.75, cacheRead: 1.5 },
    "claude-sonnet-4-8": { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.3 },
    "claude-sonnet-4": { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.3 },
    "claude-haiku-4-8": { input: 0.8, output: 4.0, cacheWrite: 1.0, cacheRead: 0.08 },
    "claude-haiku-4": { input: 0.8, output: 4.0, cacheWrite: 1.0, cacheRead: 0.08 },
    __default: { input: 3.0, output: 15.0 },
  },

  openai: {
    "gpt-5.1": { input: 1.25, output: 10.0 },
    "gpt-5": { input: 1.25, output: 10.0 },
    "gpt-5-mini": { input: 0.15, output: 0.6 },
    "gpt-4.1": { input: 1.0, output: 8.0 },
    __default: { input: 1.25, output: 10.0 },
  },

  groq: {
    "meta-llama/llama-4-scout-17b-16e-instruct": { input: 0.0, output: 0.0 },
    "meta-llama/llama-4-maverick-17b-128e-instruct": { input: 0.0, output: 0.0 },
    "deepseek-ai/deepseek-r1-distill-llama-70b": { input: 0.0, output: 0.0 },
    "qwen-qwq-32b": { input: 0.0, output: 0.0 },
    __default: { input: 0.0, output: 0.0 },
  },

  deepseek: {
    "deepseek-v4-pro": { input: 0.14, output: 0.56 },
    "deepseek-v4-flash": { input: 0.06, output: 0.24 },
    "deepseek-chat": { input: 0.14, output: 0.56 },
    "deepseek-reasoner": { input: 0.55, output: 2.19 },
    __default: { input: 0.14, output: 0.56 },
  },

  "deepseek-anthropic": {
    "deepseek-v4-pro": { input: 0.14, output: 0.56 },
    "deepseek-v4-flash": { input: 0.06, output: 0.24 },
    __default: { input: 0.14, output: 0.56 },
  },

  openrouter: {
    "anthropic/claude-sonnet-4": { input: 3.0, output: 15.0 },
    "anthropic/claude-opus-4": { input: 15.0, output: 75.0 },
    "openai/gpt-5.1": { input: 1.25, output: 10.0 },
    "deepseek/deepseek-chat": { input: 0.14, output: 0.56 },
    "google/gemini-2.5-pro": { input: 1.25, output: 5.0 },
    __default: { input: 1.0, output: 5.0 },
  },

  xai: {
    "grok-4": { input: 2.0, output: 10.0 },
    "grok-4-mini": { input: 0.5, output: 2.5 },
    "grok-3": { input: 3.0, output: 15.0 },
    __default: { input: 2.0, output: 10.0 },
  },

  google: {
    "gemini-2.5-pro": { input: 1.25, output: 5.0 },
    "gemini-2.5-flash": { input: 0.15, output: 0.6 },
    "gemini-2.0-flash": { input: 0.0, output: 0.0 },
    __default: { input: 1.25, output: 5.0 },
  },

  custom: {
    __default: { input: 0.0, output: 0.0 },
  },
};

/**
 * Estimate cost from token counts.
 * Returns formatted string like "$0.0142" or "free".
 */
export function estimateCost(
  providerId: ProviderId,
  model: string,
  inputTokens: number,
  outputTokens: number,
): { cost: number; label: string } {
  const providerPricing = PROVIDER_PRICING[providerId];
  if (!providerPricing) {
    return { cost: 0, label: "unknown" };
  }

  // Match exact model first, then prefix match, then fallback to __default
  let pricing: Pricing | undefined = providerPricing[model];
  if (!pricing) {
    // Try prefix match (e.g. "gpt-5.1-2024-..." matches "gpt-5.1")
    const prefixMatch = Object.keys(providerPricing)
      .filter(k => k !== "__default")
      .find(k => model.startsWith(k));
    pricing = prefixMatch ? providerPricing[prefixMatch]! : undefined;
  }
  pricing = pricing ?? providerPricing.__default;
  if (!pricing) return { cost: 0, label: "unknown" };

  const cost = (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output;

  if (cost === 0) {
    return { cost: 0, label: "free" };
  }

  if (cost < 0.01) {
    return { cost, label: `$${cost.toFixed(4)}` };
  }

  return { cost, label: `$${cost.toFixed(4)}` };
}

/**
 * Estimate cost BEFORE sending to provider.
 * Uses the system prompt + conversation history to estimate input tokens.
 * Output is estimated based on input ratio.
 */
export function estimatePreCost(
  providerId: ProviderId,
  model: string,
  inputCharCount: number,
): { estimatedInputTokens: number; estimatedOutputTokens: number; estimatedCost: number; label: string } {
  // Rough heuristic: ~4 chars per token
  const estimatedInputTokens = Math.ceil(inputCharCount / 3.5);
  // Typical coding output is 20-50% of input
  const estimatedOutputTokens = Math.ceil(estimatedInputTokens * 0.3);

  const { cost, label } = estimateCost(
    providerId,
    model,
    estimatedInputTokens,
    estimatedOutputTokens,
  );

  return { estimatedInputTokens, estimatedOutputTokens, estimatedCost: cost, label };
}

/**
 * Format a cost breakdown for display.
 */
export function formatCostBreakdown(
  providerId: ProviderId,
  model: string,
  inputTokens: number,
  outputTokens: number,
): string {
  const { cost, label } = estimateCost(providerId, model, inputTokens, outputTokens);

  return [
    `↥ ${inputTokens.toLocaleString()} tokens in`,
    `↧ ${outputTokens.toLocaleString()} tokens out`,
    cost > 0 ? `💰 ${label}` : `💰 free`,
  ].join("  ·  ");
}

/**
 * Get pricing info string for a provider/model combo.
 */
export function getPricingInfo(providerId: ProviderId, model?: string): string {
  const providerPricing = PROVIDER_PRICING[providerId];
  if (!providerPricing) return "unknown";

  let pricing: Pricing | undefined;
  if (model) {
    pricing = providerPricing[model];
    if (!pricing) {
      const prefix = Object.keys(providerPricing)
        .filter(k => k !== "__default")
        .find(k => model.startsWith(k));
      pricing = prefix ? providerPricing[prefix] : undefined;
    }
  }
  pricing = pricing ?? providerPricing.__default;
  if (!pricing) return "unknown";

  if (pricing.input === 0 && pricing.output === 0) return "free";

  return `$${pricing.input}/M in  ·  $${pricing.output}/M out`;
}

/**
 * All possible effort levels.
 */
export type EffortLevel = "min" | "normal" | "max";

export interface EffortConfig {
  maxSteps: number;
  temperature: number | undefined;
  label: string;
  icon: string;
}

/**
 * Effort presets — tune how hard the agent works.
 */
export const EFFORT_PRESETS: Record<EffortLevel, EffortConfig> = {
  min: {
    maxSteps: 8,
    temperature: 0,
    label: "minimal — quick fixes only",
    icon: "⚡",
  },
  normal: {
    maxSteps: 24,
    temperature: undefined, // provider default
    label: "normal — balanced",
    icon: "•",
  },
  max: {
    maxSteps: 48,
    temperature: 0.2,
    label: "maximum — deep reasoning",
    icon: "🧠",
  },
};
