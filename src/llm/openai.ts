/**
 * OpenAI-compatible provider (OpenAI, DeepSeek, Groq, OpenRouter, xAI, custom).
 * Most providers speak this API — just change the base URL and model prefix.
 */

import { parseSSE } from "./sse.js";
import {
  type AgentMessage,
  type LLMProvider,
  LLMError,
  type ProviderEvent,
  type StreamOptions,
} from "./types.js";

/** Standard OpenAI Chat Completions URL */
const OPENAI_BASE = "https://api.openai.com/v1/chat/completions";

function toOpenAIMessages(system: string, messages: AgentMessage[]) {
  const out: any[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("");
      const toolCalls = m.content
        .filter((b) => b.type === "tool_use")
        .map((b) => {
          const t = b as { id: string; name: string; input: unknown };
          return {
            id: t.id,
            type: "function",
            function: { name: t.name, arguments: JSON.stringify(t.input) },
          };
        });
      out.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    } else {
      const texts = m.content.filter((b) => b.type === "text");
      const results = m.content.filter((b) => b.type === "tool_result");
      for (const r of results) {
        const t = r as { tool_use_id: string; content: string };
        out.push({ role: "tool", tool_call_id: t.tool_use_id, content: t.content });
      }
      if (texts.length) {
        out.push({
          role: "user",
          content: texts.map((b) => (b as { text: string }).text).join(""),
        });
      }
    }
  }
  return out;
}

export interface OpenAIOptions {
  apiKey: string;
  model?: string;
  /** Override base URL for OpenAI-compatible providers (DeepSeek, OpenRouter, etc.) */
  baseUrl?: string;
  /** Provider ID for display */
  providerId?: string;
}

/**
 * Create an OpenAI-compatible provider.
 * Works with: OpenAI, DeepSeek, Groq, OpenRouter, xAI, and any custom endpoint.
 */
export function createOpenAICompatibleProvider(opts: OpenAIOptions): LLMProvider {
  const apiUrl = opts.baseUrl || OPENAI_BASE;
  const model = opts.model || "gpt-5.1";

  return {
    id: opts.providerId || "openai",
    model,
    async *streamChat(streamOpts: StreamOptions): AsyncGenerator<ProviderEvent> {
      // Some providers (OpenRouter, DeepSeek) need different header names
      const headers: Record<string, string> = {
        "content-type": "application/json",
        authorization: `Bearer ${opts.apiKey}`,
      };

      // OpenRouter needs these headers for stats
      if (opts.providerId === "openrouter") {
        headers["HTTP-Referer"] = "https://github.com/arxcodexyz/arx-cli";
        headers["X-Title"] = "ArxCode CLI";
      }

      const res = await fetch(apiUrl, {
        method: "POST",
        signal: streamOpts.signal,
        headers,
        body: JSON.stringify({
          model,
          max_tokens: streamOpts.maxTokens ?? 8192,
          stream: true,
          stream_options: { include_usage: true },
          ...(streamOpts.temperature != null ? { temperature: streamOpts.temperature } : {}),
          messages: toOpenAIMessages(streamOpts.system, streamOpts.messages),
          tools: streamOpts.tools.map((t) => ({
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: t.input_schema,
            },
          })),
        }),
      });

      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new LLMError(
          `${opts.providerId || "OpenAI"} API error (${res.status}): ${detail.slice(0, 400)}`,
          res.status,
        );
      }

      const body = res.body as unknown as ReadableStream<Uint8Array>;

      const calls = new Map<number, { id: string; name: string; args: string }>();

      for await (const { data } of parseSSE(body, streamOpts.signal)) {
        if (data === "[DONE]") break;
        let evt: any;
        try {
          evt = JSON.parse(data);
        } catch {
          continue;
        }

        // Usage: standard OpenAI stream_options.include_usage, or provider-specific
        if (evt.usage) {
          yield {
            type: "usage",
            inputTokens: evt.usage.prompt_tokens ?? 0,
            outputTokens: evt.usage.completion_tokens ?? 0,
          };
        }
        // OpenRouter / DeepSeek sometimes wrap usage differently
        if (evt.x_groq?.usage) {
          yield {
            type: "usage",
            inputTokens: evt.x_groq.usage.prompt_tokens ?? 0,
            outputTokens: evt.x_groq.usage.completion_tokens ?? 0,
          };
        }

        const choice = evt.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};

        // Text content
        if (typeof delta.content === "string" && delta.content) {
          yield { type: "text_delta", text: delta.content };
        }

        // Tool calls (streamed across multiple deltas)
        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const cur = calls.get(idx) ?? { id: "", name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(idx, cur);
        }
      }

      // Emit completed tool calls
      for (const c of Array.from(calls.values())) {
        let input: Record<string, unknown> = {};
        try {
          input = c.args ? JSON.parse(c.args) : {};
        } catch {
          input = {};
        }
        yield { type: "tool_use", id: c.id || `call_${c.name}`, name: c.name, input };
      }
      yield { type: "stop", reason: "end_turn" };
    },
  };
}

// ── Convenience exports for backward compat ─────────────────────────

export function createOpenAIProvider(apiKey: string, model?: string): LLMProvider {
  return createOpenAICompatibleProvider({ apiKey, model, providerId: "openai" });
}
