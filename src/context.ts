/**
 * Context file loader — scans project root for AGENTS.md, CLAUDE.md, etc.
 * Injects project rules into the system prompt so the agent follows conventions.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Files we scan for (in priority order — first match wins for each) */
const CONTEXT_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".cursorrules",
  "ARX.md",
  ".arxrules",
  "README.md", // last resort — only first 300 lines
];

export interface ContextFile {
  path: string;
  name: string;
  content: string;
}

/**
 * Scan a directory for context files.
 * Returns all found files with their contents.
 */
export function loadContextFiles(projectRoot: string): ContextFile[] {
  const files: ContextFile[] = [];

  for (const name of CONTEXT_FILES) {
    const filePath = path.join(projectRoot, name);
    try {
      if (!fs.existsSync(filePath)) continue;
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;

      let content = fs.readFileSync(filePath, "utf-8");

      // README gets trimmed — full README is too long for system prompt
      if (name === "README.md") {
        const lines = content.split("\n").slice(0, 300);
        content = lines.join("\n");
        if (lines.length >= 300) content += "\n\n... (README truncated, use read_file for full content)";
      }

      // Cap at 40KB per file
      if (content.length > 40_000) {
        content = content.slice(0, 40_000) + "\n\n... (truncated)";
      }

      files.push({ path: filePath, name, content });
    } catch {
      // skip unreadable files
    }
  }

  return files;
}

/**
 * Format loaded context files for injection into the system prompt.
 */
export function formatContextFiles(files: ContextFile[]): string {
  if (!files.length) return "";

  let out = "\n## Project Context\n";
  out += "These files define project conventions, rules, and structure. Follow them strictly.\n\n";

  for (const f of files) {
    const label = f.name;
    out += `### ${label}\n`;
    out += "```markdown\n";
    out += f.content;
    out += "\n```\n\n";
  }

  return out;
}
