/**
 * Prompt Recipes system for ArxCode CLI.
 * Stores reusable prompt templates with variable substitution.
 *
 * Format: YAML frontmatter + markdown body in ~/.arx/recipes/<name>.md
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import YAML from "yaml";
import chalk from "chalk";

// ── Types ──────────────────────────────────────────────────────────

export interface RecipeVar {
  name: string;
  description: string;
  required?: boolean;
}

export interface Recipe {
  name: string;
  description: string;
  variables: RecipeVar[];
  body: string;
  filePath: string;
}

interface RecipeFrontmatter {
  name?: string;
  description?: string;
  variables?: RecipeVar[];
}

// ── Directory ─────────────────────────────────────────────────────

export function getRecipesDir(): string {
  return path.join(os.homedir(), ".arx", "recipes");
}

function ensureRecipesDir(): void {
  const dir = getRecipesDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ── Parsing ───────────────────────────────────────────────────────

function parseRecipeFile(filePath: string): Recipe | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const filename = path.basename(filePath, ".md");
  let frontmatter: RecipeFrontmatter = {};
  let body = raw;

  if (raw.startsWith("---")) {
    const end = raw.indexOf("---", 3);
    if (end !== -1) {
      try {
        frontmatter = YAML.parse(raw.slice(3, end).trim()) as RecipeFrontmatter;
      } catch {
        // malformed frontmatter — ignore
      }
      body = raw.slice(end + 3).trim();
    }
  }

  const variables: RecipeVar[] = [];
  if (Array.isArray(frontmatter.variables)) {
    for (const v of frontmatter.variables) {
      if (v && typeof v.name === "string") {
        variables.push({
          name: v.name,
          description: v.description ?? "",
          required: v.required === true,
        });
      }
    }
  }

  return {
    name: typeof frontmatter.name === "string" ? frontmatter.name : filename,
    description: typeof frontmatter.description === "string" ? frontmatter.description : "",
    variables,
    body,
    filePath,
  };
}

// ── Load ──────────────────────────────────────────────────────────

export function loadRecipes(): Recipe[] {
  const dir = getRecipesDir();
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter(f => f.endsWith(".md")).sort();
  const recipes: Recipe[] = [];
  for (const file of files) {
    const recipe = parseRecipeFile(path.join(dir, file));
    if (recipe) recipes.push(recipe);
  }
  return recipes;
}

export function getRecipe(name: string): Recipe | null {
  const filePath = path.join(getRecipesDir(), `${name}.md`);
  if (!fs.existsSync(filePath)) return null;
  return parseRecipeFile(filePath);
}

// ── Variable Substitution ─────────────────────────────────────────

export function substituteVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}

export function resolveVars(
  recipe: Recipe,
  inlineVars: Record<string, string>
): { values: Record<string, string>; missing: string[] } {
  const values: Record<string, string> = { ...inlineVars };
  const missing: string[] = [];

  for (const v of recipe.variables) {
    if (!(v.name in values) || values[v.name] === "") {
      if (v.required) {
        missing.push(v.name);
      } else {
        values[v.name] = "";
      }
    }
  }

  return { values, missing };
}

// ── Formatting ────────────────────────────────────────────────────

export function formatRecipeList(recipes: Recipe[]): string {
  if (!recipes.length) {
    return chalk.dim("\n  No recipes. Run /recipe init to create built-in recipes.\n");
  }

  let out = `\n${chalk.bold.cyan("  Recipes")}\n\n`;
  for (const r of recipes) {
    out += `  ${chalk.bold(r.name.padEnd(20))}  ${chalk.dim(r.description)}\n`;
  }
  out += `\n  ${chalk.dim("Run: /recipe run <name> [var=value ...]  |  Show: /recipe show <name>")}\n`;
  return out;
}

export function formatRecipeShow(recipe: Recipe): string {
  let out = `\n${chalk.bold.cyan(`  Recipe: ${recipe.name}`)}\n`;
  if (recipe.description) out += `  ${chalk.dim(recipe.description)}\n`;
  out += "\n";

  if (recipe.variables.length) {
    out += `${chalk.yellow("  Variables")}\n`;
    for (const v of recipe.variables) {
      const req = v.required ? chalk.red(" *required") : chalk.dim(" optional");
      out += `  ${chalk.bold(("{{" + v.name + "}}").padEnd(22))}${req}  ${chalk.dim(v.description)}\n`;
    }
    out += "\n";
  }

  out += `${chalk.yellow("  Prompt")}\n`;
  out += recipe.body
    .split("\n")
    .map(l => `  ${chalk.dim(l)}`)
    .join("\n");
  out += "\n";
  return out;
}

// ── Write / Delete ────────────────────────────────────────────────

export function createRecipeFile(
  name: string,
  description: string,
  body: string,
  variables?: RecipeVar[]
): string {
  ensureRecipesDir();
  const frontmatter: RecipeFrontmatter = { name, description };
  if (variables && variables.length > 0) {
    frontmatter.variables = variables;
  }
  const content = `---\n${YAML.stringify(frontmatter).trim()}\n---\n${body}\n`;
  const filePath = path.join(getRecipesDir(), `${name}.md`);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

export function deleteRecipe(name: string): boolean {
  const filePath = path.join(getRecipesDir(), `${name}.md`);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

// ── Built-in Recipes ──────────────────────────────────────────────

export const BUILTIN_RECIPES: Array<{
  name: string;
  description: string;
  variables: RecipeVar[];
  body: string;
}> = [
  {
    name: "fix-bug",
    description: "Fix a bug in a specific file",
    variables: [
      { name: "file", description: "Path to the buggy file", required: true },
      { name: "symptom", description: "What is going wrong (error message, wrong behavior, etc.)", required: true },
    ],
    body: `Fix the bug in \`{{file}}\`.

Symptom: {{symptom}}

Steps:
1. Read \`{{file}}\` in full to understand the current code
2. Identify the root cause of the symptom — do not guess; trace the data flow
3. Write the minimal targeted fix (do not refactor unrelated code)
4. Check for other callers or files that may be affected by the same bug
5. Run typecheck/lint/tests if available to verify the fix compiles and passes
6. Report: what was wrong, why it happened, and what you changed`,
  },
  {
    name: "add-test",
    description: "Add tests for a file or function",
    variables: [
      { name: "file", description: "Path to the file to test", required: true },
      { name: "focus", description: "Specific function or behavior to focus on (optional)", required: false },
    ],
    body: `Add comprehensive tests for \`{{file}}\`.

Steps:
1. Read \`{{file}}\` to understand the exports, functions, and edge cases
2. Check if a test file already exists (e.g. \`{{file}}.test.ts\` or in \`__tests__/\`)
3. Identify what test framework is in use (jest, vitest, mocha, etc.)
4. Write tests covering:
   - Happy path (typical usage)
   - Edge cases (empty input, boundary values, nulls)
   - Error paths (throws, rejects, invalid input)
5. Run the tests to verify they all pass
6. Report: how many tests added, coverage areas, any issues found

Focus area: {{focus}}`,
  },
  {
    name: "refactor",
    description: "Refactor a file or module toward a specific goal",
    variables: [
      { name: "target", description: "File or module to refactor", required: true },
      { name: "goal", description: "What to improve (readability, performance, split into modules, etc.)", required: true },
    ],
    body: `Refactor \`{{target}}\` to achieve the following goal: {{goal}}

Rules:
- Do NOT change external behavior or public API unless the goal explicitly requires it
- Do NOT add new features — this is pure structural improvement
- Prefer incremental changes over big rewrites
- Keep diff minimal: only touch what is needed for the goal

Steps:
1. Read \`{{target}}\` in full
2. Identify the specific sections that need to change to meet the goal
3. Apply the refactor in focused, coherent hunks
4. Run typecheck/build/tests to confirm nothing broke
5. Report: what changed, why, and any trade-offs`,
  },
  {
    name: "add-feature",
    description: "Add a new feature to the codebase",
    variables: [
      { name: "name", description: "Feature name (short, e.g. 'dark mode', 'rate limiting')", required: true },
      { name: "description", description: "What the feature should do and how it should work", required: true },
    ],
    body: `Implement the feature: {{name}}

Description:
{{description}}

Steps:
1. Read the relevant existing code to understand the architecture and conventions
2. Plan the implementation: which files to create or modify, what interfaces to add
3. Implement the feature following the existing patterns and style
4. Add or update tests for the new functionality
5. Run typecheck/build/tests to verify everything compiles and passes
6. Report: what was implemented, files changed, any open questions or caveats`,
  },
  {
    name: "code-review",
    description: "Perform a thorough code review of a scope",
    variables: [
      { name: "scope", description: "What to review: a file path, directory, or 'staged changes'", required: true },
    ],
    body: `Perform a thorough code review of: {{scope}}

Review dimensions:
1. **Correctness** — bugs, off-by-one errors, race conditions, unchecked errors
2. **Security** — injection vulnerabilities, auth bypass, unsafe deserialization, secrets in code
3. **Performance** — N+1 queries, unnecessary allocations, blocking I/O in hot paths
4. **Maintainability** — naming, complexity, dead code, missing abstraction, duplication
5. **Tests** — missing coverage, weak assertions, brittle mocks

For each finding:
- Quote the specific line(s)
- Explain why it is a problem
- Suggest a concrete fix

After the findings, give an overall summary and a risk rating (low / medium / high).`,
  },
  {
    name: "docs",
    description: "Generate documentation for a file or module",
    variables: [
      { name: "target", description: "File or module to document", required: true },
    ],
    body: `Generate clear, accurate documentation for \`{{target}}\`.

Steps:
1. Read \`{{target}}\` in full to understand every export, type, and function
2. Identify what already has documentation (JSDoc, comments, README sections)
3. Write documentation covering:
   - Module overview: what it does, when to use it
   - All public exports: functions, classes, types, constants
   - Parameters and return values with types
   - Usage examples for non-obvious APIs
   - Any important caveats, error conditions, or side effects
4. Place the docs in the appropriate location (in-file JSDoc, companion .md, or README section)
5. Report: what was documented and where it was placed`,
  },
  {
    name: "add-command",
    description: "Add a new slash command to ArxCode CLI",
    variables: [
      { name: "name", description: "Command name without slash (e.g. 'deploy', 'lint')", required: true },
      { name: "description", description: "What the command should do", required: true },
    ],
    body: `Add a new slash command \`/{{name}}\` to ArxCode CLI.

Description: {{description}}

Steps:
1. Read \`src/commands.ts\` to understand the command handler pattern and SessionState interface
2. Add \`"/{{name}}"\` to the SLASH_COMMANDS array (for autocomplete)
3. Add the command handler in the \`handleCommand()\` switch block following existing patterns
4. Implement the handler function at the bottom of the file, after the existing handlers
5. If the command needs state across turns, add a field to SessionState
6. Update \`/help\` output if there is one to include the new command
7. Run \`npx tsc --noEmit\` to verify no TypeScript errors
8. Report: what the command does, its syntax, and any state it uses`,
  },
];

export function initBuiltinRecipes(): string[] {
  ensureRecipesDir();
  const created: string[] = [];
  for (const r of BUILTIN_RECIPES) {
    const filePath = createRecipeFile(r.name, r.description, r.body, r.variables);
    created.push(filePath);
  }
  return created;
}
