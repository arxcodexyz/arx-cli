/**
 * ArxCode CLI config — BYOK (Bring Your Own Key).
 *
 * API keys are resolved in this order:
 * 1. Environment variables (ARX_* or provider-standard vars)
 * 2. .arxrc.yaml in project root
 * 3. ~/.arxrc.yaml (global)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import YAML from "yaml";
import type { ProviderConfig, ProviderId } from "./llm/types.js";
import { PROVIDER_REGISTRY } from "./llm/types.js";

export type { ProviderId };

export interface ArxConfig {
  provider?: ProviderId;
  model?: string;
  apiKey?: string;
  /** Custom base URL for openai-compatible endpoints */
  baseUrl?: string;

  /** Provider-specific keys */
  keys?: Partial<Record<ProviderId, string>>;

  /** Model overrides per provider */
  models?: Partial<Record<ProviderId, string>>;

  /** Max agent steps */
  maxSteps?: number;

  /** Project root override */
  project?: string;
}

// ── Load Config ────────────────────────────────────────────────────

export function loadConfig(projectRoot?: string): ArxConfig {
  let config: ArxConfig = {};

  // 1. Global config ~/.arxrc.yaml
  const globalPaths = [
    path.join(os.homedir(), ".arxrc.yaml"),
    path.join(os.homedir(), ".arxrc.yml"),
    path.join(os.homedir(), ".arxrc.json"),
  ];
  for (const p of globalPaths) {
    const c = readConfigFile(p);
    if (c) { config = merge(config, c); break; }
  }

  // 2. Project config <root>/.arxrc.yaml
  if (projectRoot) {
    const projectPaths = [
      path.join(projectRoot, ".arxrc.yaml"),
      path.join(projectRoot, ".arxrc.yml"),
      path.join(projectRoot, ".arxrc.json"),
    ];
    for (const p of projectPaths) {
      const c = readConfigFile(p);
      if (c) { config = merge(config, c); break; }
    }
  }

  // 3. Environment variables (highest priority)
  const env = readEnvConfig();
  config = merge(config, env);

  return config;
}

function readConfigFile(filePath: string): ArxConfig | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, "utf-8");
    if (filePath.endsWith(".json")) {
      return JSON.parse(content);
    }
    return YAML.parse(content) ?? {};
  } catch {
    return null;
  }
}

function readEnvConfig(): ArxConfig {
  const cfg: ArxConfig = {};

  // Provider from env
  if (process.env.ARX_PROVIDER) cfg.provider = process.env.ARX_PROVIDER as ProviderId;

  // API keys — auto-detect from all known providers' env vars
  cfg.keys = cfg.keys ?? {};
  for (const [id, meta] of Object.entries(PROVIDER_REGISTRY)) {
    const val = process.env[meta.keyEnv];
    if (val) {
      cfg.keys[id as ProviderId] = val;
      // Auto-detect provider if not set
      if (!cfg.provider) cfg.provider = id as ProviderId;
    }
  }
  // Also check ARX_ prefixed vars
  for (const [id] of Object.entries(PROVIDER_REGISTRY)) {
    const arxVar = `ARX_${id.toUpperCase()}_KEY`;
    const val = process.env[arxVar];
    if (val) {
      cfg.keys[id as ProviderId] = val;
      if (!cfg.provider) cfg.provider = id as ProviderId;
    }
  }

  // Model
  if (process.env.ARX_MODEL) cfg.model = process.env.ARX_MODEL;

  // Custom base URL
  if (process.env.ARX_BASE_URL) cfg.baseUrl = process.env.ARX_BASE_URL;

  // Max steps
  if (process.env.ARX_MAX_STEPS) {
    const n = parseInt(process.env.ARX_MAX_STEPS, 10);
    if (!isNaN(n)) cfg.maxSteps = n;
  }

  return cfg;
}

function merge(base: ArxConfig, overlay: ArxConfig): ArxConfig {
  return {
    ...base,
    ...overlay,
    keys: { ...(base.keys ?? {}), ...(overlay.keys ?? {}) },
    models: { ...(base.models ?? {}), ...(overlay.models ?? {}) },
  };
}

// ── Resolve Provider Config ────────────────────────────────────────

export function resolveProviderConfig(cfg: ArxConfig): ProviderConfig {
  const provider = cfg.provider ?? "anthropic";

  // Resolve API key
  let apiKey = cfg.apiKey ?? "";
  if (!apiKey && cfg.keys) {
    apiKey = (cfg.keys as Record<string, string | undefined>)[provider] ?? "";
  }

  // Resolve model
  let model = cfg.model;
  if (!model && cfg.models) {
    model = (cfg.models as Record<string, string | undefined>)[provider];
  }

  return {
    provider,
    apiKey,
    model,
    baseUrl: cfg.baseUrl,
  };
}

// ── Helpers ────────────────────────────────────────────────────────

/** Save config to ~/.arxrc.yaml so keys persist across sessions. */
export function saveConfig(cfg: ArxConfig): void {
  const filePath = path.join(os.homedir(), ".arxrc.yaml");
  const toWrite: Record<string, unknown> = {};
  if (cfg.provider) toWrite.provider = cfg.provider;
  if (cfg.model) toWrite.model = cfg.model;
  if (cfg.keys && Object.keys(cfg.keys).length > 0) {
    // Only save non-empty keys
    const cleanKeys: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg.keys)) {
      if (v) cleanKeys[k] = v;
    }
    if (Object.keys(cleanKeys).length > 0) toWrite.keys = cleanKeys;
  }
  if (cfg.models && Object.keys(cfg.models).length > 0) toWrite.models = cfg.models;
  if (cfg.maxSteps) toWrite.maxSteps = cfg.maxSteps;
  if (cfg.baseUrl) toWrite.baseUrl = cfg.baseUrl;

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, YAML.stringify(toWrite), "utf-8");
  } catch {
    // Silently fail — user can still use keys in-session
  }
}

export function configStatus(cfg: ArxConfig): string {
  const provider = cfg.provider ?? "anthropic";
  const meta = PROVIDER_REGISTRY[provider];
  const hasKey = (cfg.keys as Record<string, string | undefined>)?.[provider] || cfg.apiKey;
  const model = cfg.model || (cfg.models as Record<string, string | undefined>)?.[provider] || meta?.defaultModel || "(default)";
  const baseUrl = cfg.baseUrl || meta?.baseUrl || "";

  const lines = [
    `Provider : ${provider} ${meta ? `(${meta.name})` : ""}`,
    `Model    : ${model}`,
    `API Key  : ${hasKey ? "✓ configured" : "✗ MISSING"}`,
    `Base URL : ${baseUrl || "(default)"}`,
    `Max steps: ${cfg.maxSteps ?? 24}`,
    ``,
    `All configured keys:`,
  ];

  if (cfg.keys) {
    for (const [id, key] of Object.entries(cfg.keys)) {
      if (key) lines.push(`  ${id}: ✓`);
    }
  }

  lines.push(
    ``,
    `Configure via:`,
    `  export ARX_PROVIDER=deepseek`,
    `  export DEEPSEEK_API_KEY=***OR export ARX_MODEL=deepseek-chatOr create ~/.arxrc.yaml:`,
    `  provider: deepseek`,
    `  keys:`,
    `    deepseek: sk-...`,
  );

  return lines.join("\n");
}
