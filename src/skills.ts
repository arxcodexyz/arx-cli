/**
 * Skills/extension system for ArxCode CLI.
 * Loads SKILL.md files from ~/.arx/skills/ and <project>/.arx/skills/.
 *
 * Skills can:
 * - Add context to the system prompt (the markdown body)
 * - Define custom tools (YAML frontmatter)
 * - Define custom slash commands (YAML frontmatter)
 *
 * Format: YAML frontmatter + markdown body, same as Hermes Agent skills.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as cp from "node:child_process";
import YAML from "yaml";
import type { ToolDef } from "./llm/types.js";

// ── Types ──────────────────────────────────────────────────────────

export interface SkillTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
    additionalProperties?: boolean;
  };
  /** How to execute: "builtin" or path to a script (relative to skill dir) */
  implementation?: string;
}

export interface SkillCommand {
  name: string;
  description: string;
  /** Shell command to run. {input} is replaced with user input after the command. */
  handler: string;
}

export interface Skill {
  /** Skill name (from frontmatter or filename) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Version string */
  version?: string;
  /** Custom tools defined by this skill */
  tools: SkillTool[];
  /** Custom slash commands */
  commands: SkillCommand[];
  /** System prompt fragments (each is a paragraph to inject) */
  prompts: string[];
  /** The markdown body (injected as context) */
  body: string;
  /** Directory where the skill file lives */
  dir: string;
  /** Source file path */
  filePath: string;
}

export interface SkillRegistry {
  skills: Skill[];
  /** Tools from all skills merged together */
  toolDefs: ToolDef[];
  /** All commands from all skills */
  commands: SkillCommand[];
}

// ── YAML Frontmatter Parser ───────────────────────────────────────

interface SkillFrontmatter {
  name?: string;
  description?: string;
  version?: string;
  tools?: SkillTool[];
  commands?: SkillCommand[];
  prompts?: string[];
}

function parseFrontmatter(content: string): { fm: SkillFrontmatter; body: string } {
  // Match YAML frontmatter between --- delimiters
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { fm: {}, body: content };
  }

  try {
    const fm = YAML.parse(match[1]) as SkillFrontmatter ?? {};
    return { fm, body: match[2].trim() };
  } catch {
    return { fm: {}, body: content };
  }
}

// ── Skill Loader ───────────────────────────────────────────────────

/** Load a single SKILL.md file */
function loadSkillFile(filePath: string): Skill | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const { fm, body } = parseFrontmatter(content);

    const name = fm.name || path.basename(path.dirname(filePath));

    return {
      name,
      description: fm.description || "",
      version: fm.version,
      tools: fm.tools || [],
      commands: fm.commands || [],
      prompts: fm.prompts || [],
      body,
      dir: path.dirname(filePath),
      filePath,
    };
  } catch {
    return null;
  }
}

/** Load all skills from a directory (recursively, one level deep) */
function loadSkillsFromDir(dir: string): Skill[] {
  const skills: Skill[] = [];
  try {
    if (!fs.existsSync(dir)) return skills;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Look for SKILL.md inside the directory
        const skillFile = path.join(dir, entry.name, "SKILL.md");
        if (fs.existsSync(skillFile)) {
          const skill = loadSkillFile(skillFile);
          if (skill) skills.push(skill);
        }
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        // Also support loose .md files as skills (for quick ones)
        const skill = loadSkillFile(path.join(dir, entry.name));
        if (skill && !skill.name.endsWith(".md")) {
          skills.push(skill);
        }
      }
    }
  } catch {
    // ignore
  }
  return skills;
}

/** Load ALL skills: global (~/.arx/skills/) merged with project local */
export function loadSkills(projectRoot?: string): SkillRegistry {
  const allSkills: Skill[] = [];

  // Global skills (~/.arx/skills/)
  const globalDir = path.join(os.homedir(), ".arx", "skills");
  allSkills.push(...loadSkillsFromDir(globalDir));

  // Project-local skills
  if (projectRoot) {
    const projectDir = path.join(projectRoot, ".arx", "skills");
    allSkills.push(...loadSkillsFromDir(projectDir));
  }

  // Build tool definitions from skills
  const toolDefs: ToolDef[] = [];
  for (const skill of allSkills) {
    for (const tool of skill.tools) {
      toolDefs.push({
        name: tool.name,
        description: `[skill:${skill.name}] ${tool.description}`,
        input_schema: {
          type: "object",
          properties: tool.input_schema.properties,
          required: tool.input_schema.required,
          additionalProperties: tool.input_schema.additionalProperties ?? false,
        },
      });
    }
  }

  // Collect all commands
  const commands: SkillCommand[] = [];
  for (const skill of allSkills) {
    commands.push(...skill.commands);
  }

  return { skills: allSkills, toolDefs, commands };
}

// ── Skill Tool Execution ──────────────────────────────────────────

/** Execute a skill-defined tool. Returns { ok, output } */
export async function executeSkillTool(
  skill: Skill,
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ ok: boolean; output: string }> {
  const tool = skill.tools.find(t => t.name === toolName);
  if (!tool) return { ok: false, output: `Tool "${toolName}" not found in skill "${skill.name}"` };

  const impl = tool.implementation || "builtin";

  if (impl === "builtin") {
    // Builtin skills are simple data-return tools
    return { ok: true, output: JSON.stringify(input, null, 2) };
  }

  // Script-based implementation
  const scriptPath = path.resolve(skill.dir, impl);
  try {
    if (!fs.existsSync(scriptPath)) {
      return { ok: false, output: `Skill script not found: ${scriptPath}` };
    }

    // Make executable if needed
    try { fs.chmodSync(scriptPath, 0o755); } catch { /* ok */ }

    const inputJson = JSON.stringify(input);
    const result = cp.execSync(scriptPath, {
      input: inputJson,
      timeout: 30_000,
      maxBuffer: 100_000,
      encoding: "utf-8",
    });
    return { ok: true, output: result.trim() || "(empty)" };
  } catch (err: any) {
    const msg = err.stderr || err.message || "Unknown error";
    return { ok: false, output: `Skill tool error: ${msg.slice(0, 2000)}` };
  }
}

// ── Prompt Injection ───────────────────────────────────────────────

/** Format all skill content for injection into the system prompt */
export function formatSkillContext(skills: Skill[]): string {
  if (!skills.length) return "";

  let out = "\n## Active Skills\n";
  out += "These skills extend the agent's capabilities with additional context and tools.\n\n";

  for (const skill of skills) {
    out += `### Skill: ${skill.name}\n`;
    if (skill.description) out += `${skill.description}\n\n`;

    // Custom prompts
    for (const p of skill.prompts) {
      out += `${p}\n\n`;
    }

    // Body content (trimmed to 2KB per skill to save tokens)
    if (skill.body) {
      const trimmed = skill.body.length > 2000
        ? skill.body.slice(0, 2000) + "\n\n... (truncated)"
        : skill.body;
      out += `${trimmed}\n\n`;
    }

    // Available custom commands
    if (skill.commands.length > 0) {
      out += "**Custom commands:** ";
      out += skill.commands.map(c => `\`${c.name}\` — ${c.description}`).join(", ");
      out += "\n\n";
    }
  }

  return out;
}

// ── Helpers ────────────────────────────────────────────────────────

/** Get the recommended skills directory for a project */
export function getProjectSkillsDir(projectRoot: string): string {
  return path.join(projectRoot, ".arx", "skills");
}

/** Get the global skills directory */
export function getGlobalSkillsDir(): string {
  return path.join(os.homedir(), ".arx", "skills");
}

/** Create an example skill file */
export function createExampleSkill(dir: string): string {
  const skillDir = path.join(dir, "example-skill");
  fs.mkdirSync(skillDir, { recursive: true });

  const content = `---
name: example-skill
description: An example skill showing the format
version: 1.0.0
tools:
  - name: greet
    description: Greet someone by name
    input_schema:
      type: object
      properties:
        name:
          type: string
          description: Who to greet
      required: [name]
  - name: count_files
    description: Count files in a directory
    input_schema:
      type: object
      properties:
        dir:
          type: string
          description: Directory to count (relative to project root)
      required: [dir]
    implementation: count_files.sh
prompts:
  - "When asked to greet someone, use the greet tool."
commands:
  - name: /hello
    description: Say hello
    handler: echo "Hello from ArxCode skill!"
---

# Example Skill

This is an example skill for ArxCode CLI. Skills extend the agent with:

- **Custom tools** — new capabilities the agent can use
- **Custom commands** — slash commands you can type in the REPL
- **Context** — additional knowledge injected into the system prompt

## Usage

When this skill is active, the agent can use the \`greet\` and \`count_files\` tools.
Type \`/hello\` in the REPL to see the custom command.
`;

  const skillPath = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(skillPath, content, "utf-8");

  // Create the script
  const scriptPath = path.join(skillDir, "count_files.sh");
  fs.writeFileSync(scriptPath, `#!/bin/bash\n# Count files in a directory\nDIR="$1"\nif [ -z "$DIR" ]; then\n  echo '{"error": "dir is required"}'\n  exit 1\nfi\nfind "$DIR" -type f 2>/dev/null | wc -l\n`, "utf-8");
  fs.chmodSync(scriptPath, 0o755);

  return skillDir;
}
