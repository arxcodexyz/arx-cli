/**
 * Stream-friendly syntax highlighter for ArxCode CLI.
 * Extracted from bin/arx.ts so both the readline REPL and TUI can use it.
 */

import chalk from "chalk";

// ── Keywords ─────────────────────────────────────────────────────

const JS_KEYWORDS = new Set([
  "import", "export", "default", "from", "const", "let", "var", "function",
  "return", "if", "else", "for", "while", "do", "switch", "case", "break",
  "continue", "new", "this", "super", "class", "extends", "implements",
  "interface", "type", "enum", "namespace", "module", "declare", "as",
  "async", "await", "yield", "try", "catch", "finally", "throw", "typeof",
  "instanceof", "in", "of", "void", "null", "undefined", "true", "false",
  "public", "private", "protected", "readonly", "static", "abstract",
  "get", "set", "keyof", "infer", "never", "unknown", "any", "string",
  "number", "boolean", "object", "symbol", "bigint",
]);

// ── State ─────────────────────────────────────────────────────────

export interface HighlightState {
  inBlock: boolean;
  lang: string;
  buffer: string;
}

export function createHighlighter(): HighlightState {
  return { inBlock: false, lang: "", buffer: "" };
}

// ── Streaming Highlighter ─────────────────────────────────────────

/**
 * Stream-friendly highlighter: fed text character-by-character (or chunk-by-chunk),
 * outputs chalk-colorized text. Detects ```code blocks and applies basic syntax coloring.
 */
export function highlightChunk(state: HighlightState, chunk: string): string {
  let out = "";
  for (const ch of chunk) {
    state.buffer += ch;

    // Detect ``` code block start/end
    if (!state.inBlock && state.buffer.endsWith("```")) {
      // Opening fence — extract language if any
      const lines = state.buffer.split("\n");
      const lastLine = lines[lines.length - 1];
      const fenceMatch = lastLine.match(/^```(\w*)/);
      if (fenceMatch) {
        const beforeFence = state.buffer.slice(0, state.buffer.length - lastLine.length);
        out += beforeFence;
        state.lang = fenceMatch[1] || "";
        state.inBlock = true;
        state.buffer = "";
        out += chalk.dim("```" + state.lang) + "\n";
      }
      continue;
    }

    if (state.inBlock && state.buffer.endsWith("\n```")) {
      // Closing fence
      const codeOnly = state.buffer.slice(0, state.buffer.length - 4);
      out += highlightCode(codeOnly, state.lang);
      out += chalk.dim("\n```");
      state.inBlock = false;
      state.lang = "";
      state.buffer = "";
      continue;
    }

    // Flush buffer periodically to avoid unbounded growth
    if (state.buffer.length > 200) {
      if (state.inBlock) {
        out += highlightCode(state.buffer, state.lang);
      } else {
        out += state.buffer;
      }
      state.buffer = "";
    }
  }
  return out;
}

// ── Code Highlighter ──────────────────────────────────────────────

export function highlightCode(code: string, lang: string): string {
  if (!code) return "";

  // Only highlight known code languages
  const codeLangs = new Set(["ts", "tsx", "js", "jsx", "py", "rs", "go", "sh", "bash",
    "json", "yaml", "yml", "toml", "html", "css", "scss", "sql", "graphql",
    "typescript", "javascript", "python", "rust", "shell", ""]);
  if (!codeLangs.has(lang.toLowerCase())) return code;

  const lines = code.split("\n");
  let out = "";

  for (const line of lines) {
    // Comments
    const isComment = /^\s*\/\//.test(line) || /^\s*#/.test(line) || /^\s*--/.test(line);
    if (isComment) {
      out += chalk.dim(line) + "\n";
      continue;
    }

    // Token-level highlighting
    let highlighted = "";
    let i = 0;
    while (i < line.length) {
      // String literals
      if (line[i] === '"' || line[i] === "'" || line[i] === "`") {
        const quote = line[i];
        let j = i + 1;
        while (j < line.length && line[j] !== quote) {
          if (line[j] === "\\") j++; // skip escape
          j++;
        }
        if (j < line.length) j++; // include closing quote
        highlighted += chalk.green(line.slice(i, j));
        i = j;
        continue;
      }

      // Numbers
      if (/\d/.test(line[i]) && (i === 0 || /[\s,({\[<>!=+\-*/%&|^~?:]/.test(line[i - 1]))) {
        let j = i;
        while (j < line.length && /[\d.x_fFaAbBcCdDeEpP]/.test(line[j])) j++;
        if (j > i) {
          highlighted += chalk.yellow(line.slice(i, j));
          i = j;
          continue;
        }
      }

      // Words (potential keywords)
      if (/[a-zA-Z_$]/.test(line[i])) {
        let j = i;
        while (j < line.length && /[a-zA-Z0-9_$]/.test(line[j])) j++;
        const word = line.slice(i, j);
        if (JS_KEYWORDS.has(word)) {
          highlighted += chalk.cyan(word);
        } else {
          highlighted += word;
        }
        i = j;
        continue;
      }

      highlighted += line[i];
      i++;
    }
    out += highlighted + "\n";
  }

  return out;
}
