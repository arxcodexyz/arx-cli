import { parseSSE } from "./sse.js";
import {
  type AgentMessage,
  type LLMProvider,
  LLMError,
  type ProviderEvent,
  type StreamOptions,
} from "./types.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-4-8";

function toAnthropicMessage(m: AgentMessage) {
  return {
    role: m.role,
    content: m.content.map((b) => {
      switch (b.type) {
        case "text":
          return { type: "text", text: b.text };
        case "tool_use":
          return { type: "tool_use", id: b.id, name: b.name, input: b.input };
        case "tool_result":
          return {
            type: "tool_result",
            tool_use_id: b.tool_use_id,
            content: b.content,
            is_error: b.is_error ?? false,
          };
      }
    }),
  };
}

function toAnthropicTools(tools: StreamOptions["tools"]) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

export function createAnthropicProvider(apiKey: string, model?: string): LLMProvider {
  const resolved = model || DEFAULT_MODEL;
  return {
    id: "anthropic",
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
          ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
          system: opts.system,
          tools: toAnthropicTools(opts.tools),
          messages: opts.messages.map(toAnthropicMessage),
        }),
      });

      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new LLMError(
          `Anthropic API error (${res.status}): ${detail.slice(0, 400)}`,
          res.status,
        );
      }

      const toolBlocks = new Map<number, { id: string; name: string; json: string }>();

      // Node.js fetch returns a web ReadableStream
      const body = res.body as unknown as ReadableStream<Uint8Array>;

      for await (const { data } of parseSSE(body, opts.signal)) {
        if (data === "[DONE]") break;
        let evt: any;
        try {
          evt = JSON.parse(data);
        } catch {
          continue;
        }

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
              try {
                input = blk.json ? JSON.parse(blk.json) : {};
              } catch {
                input = {};
              }
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
            if (evt.delta?.stop_reason) {
              yield { type: "stop", reason: evt.delta.stop_reason };
            }
            break;
          }
        }
      }
    },
  };
}
