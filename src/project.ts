/**
 * Project Intelligence for ArxCode CLI.
 * Auto-detects project type, framework, test runner, and build tool.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface ProjectInfo {
  /** Detected project type */
  type: ProjectType;
  /** Human-readable label */
  label: string;
  /** Emoji icon */
  icon: string;
  /** Test framework (if detected) */
  testFramework?: string;
  /** Build/run tool */
  buildTool?: string;
  /** Package manager */
  packageManager?: string;
  /** Language */
  language: string;
  /** Whether TypeScript is used */
  hasTypeScript: boolean;
  /** Relevant config files found */
  configFiles: string[];
}

export type ProjectType = "node" | "react" | "next" | "python" | "rust" | "go" | "unknown";

const PROJECT_DETECTORS: Array<{
  check: (files: string[]) => boolean;
  type: ProjectType;
  label: string;
  icon: string;
  language: string;
}> = [
  { check: f => f.includes("next.config") || f.includes("next.config.js") || f.includes("next.config.ts"), type: "next", label: "Next.js", icon: "▲", language: "TypeScript" },
  { check: f => f.includes("vite.config") || (f.includes("package.json") && !f.includes("next.config")), type: "react", label: "React (Vite)", icon: "⚛", language: "TypeScript" },
  { check: f => f.includes("package.json"), type: "node", label: "Node.js", icon: "●", language: "JavaScript/TypeScript" },
  { check: f => f.includes("pyproject.toml") || f.includes("requirements.txt") || f.includes("setup.py"), type: "python", label: "Python", icon: "🐍", language: "Python" },
  { check: f => f.includes("Cargo.toml"), type: "rust", label: "Rust", icon: "🦀", language: "Rust" },
  { check: f => f.includes("go.mod"), type: "go", label: "Go", icon: "🔷", language: "Go" },
];

const TEST_FRAMEWORKS: Record<string, string[]> = {
  jest: ["jest.config", "jest.config.js", "jest.config.ts", "jest.config.json"],
  vitest: ["vitest.config", "vitest.config.js", "vitest.config.ts"],
  mocha: [".mocharc", ".mocharc.js", ".mocharc.yml"],
  pytest: ["pytest.ini", "pyproject.toml"],
};

export function detectProject(projectRoot: string): ProjectInfo {
  const files: string[] = [];
  try {
    const entries = fs.readdirSync(projectRoot, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile()) files.push(e.name);
    }
  } catch { /* ignore */ }

  // Detect project type
  let type: ProjectType = "unknown";
  let label = "Unknown";
  let icon = "📁";
  let language = "Unknown";

  for (const d of PROJECT_DETECTORS) {
    if (d.check(files)) {
      type = d.type;
      label = d.label;
      icon = d.icon;
      language = d.language;
      break;
    }
  }

  // Detect TypeScript
  const hasTypeScript = files.some(f => f === "tsconfig.json");

  // Detect package manager (Node)
  const hasPnpm = files.includes("pnpm-lock.yaml");
  const hasYarn1 = files.includes("yarn.lock");
  const hasBun = files.includes("bun.lockb") || files.includes("bun.lock");
  const hasNpm = files.includes("package-lock.json") || files.includes("package.json");

  let packageManager: string | undefined;
  if (hasPnpm) packageManager = "pnpm";
  else if (hasBun) packageManager = "bun";
  else if (hasYarn1) packageManager = "yarn";
  else if (hasNpm) packageManager = "npm";

  // Detect build tool (Node)
  let buildTool: string | undefined;
  if (files.some(f => f.startsWith("next.config"))) buildTool = "next";
  else if (files.some(f => f.startsWith("vite.config"))) buildTool = "vite";
  else if (hasTypeScript) buildTool = "tsc";
  else if (files.includes("tsconfig.json")) buildTool = "tsc";

  // Detect test framework
  let testFramework: string | undefined;
  for (const [name, patterns] of Object.entries(TEST_FRAMEWORKS)) {
    if (patterns.some(p => files.some(f => f.startsWith(p) || f.includes(p)))) {
      testFramework = name;
      break;
    }
  }
  if (!testFramework) {
    // Check package.json for test script
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"));
      const testScript = pkg.scripts?.test || "";
      if (testScript.includes("jest")) testFramework = "jest";
      else if (testScript.includes("vitest")) testFramework = "vitest";
      else if (testScript.includes("mocha")) testFramework = "mocha";
    } catch { /* no package.json */ }
  }

  return {
    type, label, icon, language,
    hasTypeScript,
    testFramework,
    buildTool,
    packageManager,
    configFiles: files.filter(f => f.startsWith(".") || f.endsWith(".json") || f.endsWith(".yaml") || f.endsWith(".yml") || f.endsWith(".toml")),
  };
}

/**
 * Format project info for display in the startup banner.
 */
export function formatProjectInfo(info: ProjectInfo): string {
  const parts: string[] = [info.icon, info.label];
  if (info.packageManager) parts.push(info.packageManager);
  if (info.buildTool) parts.push(info.buildTool);
  if (info.testFramework) parts.push(`🧪${info.testFramework}`);
  return parts.join("  ·  ");
}
