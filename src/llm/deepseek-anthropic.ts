/**
 * DeepSeek Anthropic-compatible provider.
 *
 * DeepSeek supports the Anthropic Messages API at:
 *   https://api.deepseek.com/anthropic/v1/messages
 *
 * Auth: x-api-key header (same as Anthropic)
 * Model mapping: claude-opus → deepseek-v4-pro, claude-sonnet → deepseek-v4-flash
 * Tools + streaming: fully supported
 */

import { parseSSE } from "./sse.js";
import {
  type AgentMessage,
  type LLMProvider,
  LLMError,
  type ProviderEvent,
  type StreamOptions,
} from "./types.js";

const API_URL = "https://api.deepseek.com/anthropic/v1/messages";

function toAnthropicMessage(m: AgentMessage) {
  return {
    role: m.role,
    content: m.content.map((b: any) => {
      switch (b.type) {
        case "text": return { type: "text", text: b.text };
        case "tool_use": return { type: "tool_use", id: b.id, name: b.name, input: b.input };
        case "tool_result": return {
          type: "tool_result",
          tool_use_id: b.tool_use_id,
          content: b.content,
          is_error: b.is_error ?? false,
        };
      }
    }),
  };
}

export function createDeepSeekAnthropicProvider(apiKey: string, model?: string): LLMProvider {
  const resolved = model || "deepseek-v4-pro";

  return {
    id: "deepseek-anthropic",
    model: resolved,
    async *streamChat(opts: StreamOptions): AsyncGenerator<ProviderEvent> {
      const res = await fetch(API_URL, {
        method: "POST",
        signal: opts.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: resolved,
          max_tokens: opts.maxTokens ?? 8192,
          stream: true,
          system: opts.system,
          tools: opts.tools.map((t: any) => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema,
          })),
          messages: opts.messages.map(toAnthropicMessage),
        }),
      });

      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new LLMError(
          `DeepSeek Anthropic API error (${res.status}): ${detail.slice(0, 400)}`,
          res.status,
        );
      }

      const body = res.body as unknown as ReadableStream<Uint8Array>;
      const toolBlocks = new Map<number, { id: string; name: string; json: string }>();

      for await (const { data } of parseSSE(body, opts.signal)) {
        if (data === "[DONE]") break;
        let evt: any;
        try { evt = JSON.parse(data); } catch { continue; }

        switch (evt.type) {
          case "content_block_start": {
            const cb = evt.content_block;
            if (cb?.type === "tool_use") {
              toolBlocks.set(evt.index, { id: cb.id, name: cb.name, json: "" });
            }
            break;
          }
          case "content_block_delta": {
            const d = evt.delta;
            if (d?.type === "text_delta") {
              yield { type: "text_delta", text: d.text };
            } else if (d?.type === "input_json_delta") {
              const blk = toolBlocks.get(evt.index);
              if (blk) blk.json += d.partial_json ?? "";
            }
            break;
          }
          case "content_block_stop": {
            const blk = toolBlocks.get(evt.index);
            if (blk) {
              let input: Record<string, unknown> = {};
              try { input = blk.json ? JSON.parse(blk.json) : {}; } catch { input = {}; }
              yield { type: "tool_use", id: blk.id, name: blk.name, input };
              toolBlocks.delete(evt.index);
            }
            break;
          }
          case "message_delta": {
            if (evt.usage) {
              yield {
                type: "usage",
                inputTokens: evt.usage.input_tokens ?? 0,
                outputTokens: evt.usage.output_tokens ?? 0,
              };
            }
            break;
          }
        }
      }
    },
  };
}
