/**
 * SSE (Server-Sent Events) stream parser.
 * Yields lines as { data, event } objects. Handles multi-line data chunks.
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array> | NodeJS.ReadableStream,
  signal?: AbortSignal,
): AsyncGenerator<{ data: string; event?: string }, void, unknown> {
  const reader = "getReader" in body
    ? (body as ReadableStream<Uint8Array>).getReader()
    : null;

  let buffer = "";

  const decoder = new TextDecoder();
  const onAbort = () => { /* noop in node, signal handled by fetch */ };

  if (reader) {
    // Web Streams API (browser / fetch)
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const ev = parseLine(line);
          if (ev) yield ev;
        }
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      reader.releaseLock();
    }
  } else {
    // Node.js Readable stream
    const stream = body as NodeJS.ReadableStream;
    for await (const chunk of stream) {
      const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const ev = parseLine(line);
        if (ev) yield ev;
      }
    }
  }

  // Flush remaining buffer
  if (buffer.trim()) {
    const ev = parseLine(buffer);
    if (ev) yield ev;
  }
}

function parseLine(line: string): { data: string; event?: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("data:")) {
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") return { data: "[DONE]" };
    return { data };
  }
  if (trimmed.startsWith("event:")) {
    return { data: "", event: trimmed.slice(6).trim() };
  }
  // Some APIs put JSON directly as lines
  if (trimmed.startsWith("{")) {
    return { data: trimmed };
  }
  return null;
}
