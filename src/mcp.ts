/**
 * MCP (Model Context Protocol) client for ArxCode CLI.
 * Connects to MCP servers, discovers tools, makes them available to the agent.
 *
 * Supports:
 * - Stdio transport (command + args)
 * - HTTP/StreamableHTTP transport (url)
 * - Multiple servers simultaneously
 * - Tool prefixing: mcp_{server}_{tool}
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as cp from "node:child_process";
import YAML from "yaml";
import chalk from "chalk";
import type { ToolDef } from "./llm/types.js";

// ── Types ──────────────────────────────────────────────────────────

export interface McpServerConfig {
  /** For stdio transport: the command to run */
  command?: string;
  /** For stdio transport: command args */
  args?: string[];
  /** For HTTP transport */
  url?: string;
  /** HTTP headers for URL transport */
  headers?: Record<string, string>;
  /** Environment variables for stdio transport */
  env?: Record<string, string>;
  /** Per-tool timeout in seconds */
  timeout?: number;
  /** Connection timeout in seconds */
  connect_timeout?: number;
}

export interface McpServerConnection {
  /** Server name (from config key) */
  name: string;
  /** MCP Client instance */
  client: Client;
  /** Raw tool definitions from the server */
  tools: ToolDef[];
  /** Original server config */
  config: McpServerConfig;
  /** Connection status */
  connected: boolean;
  /** Error message if connection failed */
  error?: string;
}

export interface McpRegistry {
  /** All configured server connections */
  servers: McpServerConnection[];
  /** All tools from all servers, prefixed */
  toolDefs: ToolDef[];
  /** Map from prefixed tool name to { server, originalName } */
  toolMap: Map<string, { serverName: string; originalName: string }>;
}

// ── Global state ───────────────────────────────────────────────────

let registry: McpRegistry = { servers: [], toolDefs: [], toolMap: new Map() };

/** Get the current MCP registry (for merging with built-in tools) */
export function getMcpRegistry(): McpRegistry {
  return registry;
}

// ── Connection ─────────────────────────────────────────────────────

/** Format a tool name with MCP prefix: mcp_{server}_{tool} */
function fmtToolName(serverName: string, toolName: string): string {
  const safeServer = serverName.replace(/[^a-zA-Z0-9_]/g, "_");
  const safeTool = toolName.replace(/[^a-zA-Z0-9_]/g, "_");
  return `mcp_${safeServer}_${safeTool}`;
}

/**
 * Connect to all MCP servers defined in config.
 * Already-connected servers are skipped.
 */
export async function connectAllServers(servers: Record<string, McpServerConfig>): Promise<McpRegistry> {
  const connections: McpServerConnection[] = [];
  const toolDefs: ToolDef[] = [];
  const toolMap = new Map<string, { serverName: string; originalName: string }>();

  for (const [name, cfg] of Object.entries(servers)) {
    // Skip already connected
    const existing = registry.servers.find(s => s.name === name && s.connected);
    if (existing) {
      connections.push(existing);
      continue;
    }

    const conn = await connectServer(name, cfg);
    connections.push(conn);

    if (conn.connected && conn.tools.length > 0) {
      for (const tool of conn.tools) {
        const prefixed = fmtToolName(name, tool.name);
        toolDefs.push({
          name: prefixed,
          description: `[mcp:${name}] ${tool.description}`,
          input_schema: tool.input_schema,
        });
        toolMap.set(prefixed, { serverName: name, originalName: tool.name });
      }
    }
  }

  registry = { servers: connections, toolDefs, toolMap };
  return registry;
}

/** Connect to a single MCP server */
async function connectServer(name: string, cfg: McpServerConfig): Promise<McpServerConnection> {
  const conn: McpServerConnection = {
    name,
    client: null as unknown as Client,
    tools: [],
    config: cfg,
    connected: false,
  };

  try {
    const client = new Client(
      { name: "arx-cli", version: "0.5.0" },
      { capabilities: {} },
    );

    let transport;

    if (cfg.url) {
      // HTTP transport
      transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
        requestInit: cfg.headers ? { headers: cfg.headers as Record<string, string> } : undefined,
      });
    } else if (cfg.command) {
      // Stdio transport
      const args = cfg.args || [];
      // Filter environment for security
      const safeEnv: Record<string, string> = {};
      for (const key of ["PATH", "HOME", "USER", "LANG", "TERM", "SHELL", "TMPDIR"]) {
        if (process.env[key]) safeEnv[key] = process.env[key]!;
      }
      // Add explicit env vars from config
      if (cfg.env) {
        for (const [k, v] of Object.entries(cfg.env)) {
          safeEnv[k] = v;
        }
      }

      transport = new StdioClientTransport({
        command: cfg.command,
        args,
        env: safeEnv,
      });
    } else {
      conn.error = "Server config must have 'command' (stdio) or 'url' (HTTP)";
      return conn;
    }

    const connectTimeout = (cfg.connect_timeout || 60) * 1000;

    await client.connect(transport);

    // Discover tools
    const result = await client.listTools();
    conn.tools = (result.tools || []).map(t => ({
      name: t.name,
      description: t.description || "",
      input_schema: t.inputSchema || { type: "object", properties: {} },
    }));

    conn.client = client;
    conn.connected = true;
  } catch (err) {
    conn.error = err instanceof Error ? err.message : String(err);
    conn.connected = false;
  }

  return conn;
}

// ── Tool Execution ─────────────────────────────────────────────────

/** Execute a tool call on the appropriate MCP server */
export async function callMcpTool(
  prefixedName: string,
  input: Record<string, unknown>,
): Promise<{ ok: boolean; output: string }> {
  const entry = registry.toolMap.get(prefixedName);
  if (!entry) {
    return { ok: false, output: `Unknown MCP tool: ${prefixedName}` };
  }

  const server = registry.servers.find(s => s.name === entry.serverName);
  if (!server || !server.connected || !server.client) {
    return { ok: false, output: `MCP server "${entry.serverName}" not connected` };
  }

  try {
    const result = await server.client.callTool({
      name: entry.originalName,
      arguments: input,
    });

    // Handle the result response
    const isError = result.isError === true;

    let output = "";
    if (result.content && Array.isArray(result.content)) {
      output = result.content
        .map((c: any) => {
          if (c.type === "text") return c.text || "";
          if (c.type === "resource") {
            const blob = c.resource as { blob?: string; text?: string } | undefined;
            return blob?.text || blob?.blob || JSON.stringify(c.resource);
          }
          return JSON.stringify(c);
        })
        .filter(Boolean)
        .join("\n");
    }

    return { ok: !isError, output: output || "(empty)" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, output: `MCP tool error: ${msg}` };
  }
}

// ── Disconnect ─────────────────────────────────────────────────────

/** Disconnect from all MCP servers */
export async function disconnectAll(): Promise<void> {
  for (const server of registry.servers) {
    try {
      if (server.client) {
        await server.client.close();
      }
    } catch {
      // ignore
    }
  }
  registry = { servers: [], toolDefs: [], toolMap: new Map() };
}

/** Disconnect a specific server */
export async function disconnectServer(name: string): Promise<boolean> {
  const idx = registry.servers.findIndex(s => s.name === name);
  if (idx === -1) return false;

  const server = registry.servers[idx];
  try {
    if (server.client) {
      await server.client.close();
    }
  } catch {
    // ignore
  }

  // Remove from registry
  registry.servers.splice(idx, 1);
  // Rebuild tool defs and map
  rebuildRegistry();
  return true;
}

function rebuildRegistry(): void {
  const toolDefs: ToolDef[] = [];
  const toolMap = new Map<string, { serverName: string; originalName: string }>();

  for (const server of registry.servers) {
    if (!server.connected) continue;
    for (const tool of server.tools) {
      const prefixed = fmtToolName(server.name, tool.name);
      toolDefs.push({
        name: prefixed,
        description: `[mcp:${server.name}] ${tool.description}`,
        input_schema: tool.input_schema,
      });
      toolMap.set(prefixed, { serverName: server.name, originalName: tool.name });
    }
  }

  registry.toolDefs = toolDefs;
  registry.toolMap = toolMap;
}

// ── Status Display ─────────────────────────────────────────────────

/** Format MCP status for display */
export function formatMcpStatus(): string {
  if (registry.servers.length === 0) {
    return chalk.dim("\n  No MCP servers configured.\n  Add to .arxrc.yaml under mcp_servers: or use /mcp connect\n");
  }

  let out = `\n${chalk.bold.cyan("  MCP Servers")}  ${chalk.dim(`(${registry.toolDefs.length} tools)`)}\n\n`;

  for (const server of registry.servers) {
    const status = server.connected
      ? chalk.green("● connected")
      : chalk.red(`✗ disconnected (${server.error || "unknown"})`);
    const count = server.tools.length;
    const nameStr = chalk.bold(server.name);
    const typeStr = server.config.url
      ? chalk.dim("(HTTP)")
      : chalk.dim("(stdio)");
    out += `  ${nameStr}  ${typeStr}  ${status}\n`;
    if (server.connected && count > 0) {
      out += `    ${chalk.dim(`${count} tool(s) available`)  }\n`;
      for (const tool of server.tools.slice(0, 10)) {
        out += `    ${chalk.green("◇")} ${chalk.dim(`mcp_${server.name}_${tool.name}`)}\n`;
      }
      if (server.tools.length > 10) {
        out += `    ${chalk.dim(`  ... and ${server.tools.length - 10} more`)}\n`;
      }
    }
    out += "\n";
  }

  out += chalk.dim("  Commands: /mcp           — list status\n");
  out += chalk.dim("            /mcp connect   — reload & connect all servers\n");
  out += chalk.dim("            /mcp disconnect — disconnect all\n");
  return out;
}

// ── Load MCP Config from .arxrc.yaml ───────────────────────────────

/** Load MCP server configs from arxrc.yaml */
export function loadMcpServersFromConfig(projectRoot?: string): Record<string, McpServerConfig> {
  // Check project-local config first, then global
  const locations = [
    projectRoot ? path.join(projectRoot, ".arxrc.yaml") : "",
    projectRoot ? path.join(projectRoot, ".arxrc.yml") : "",
    path.join(os.homedir(), ".arxrc.yaml"),
    path.join(os.homedir(), ".arxrc.yml"),
    path.join(os.homedir(), ".arxrc.json"),
  ];

  for (const loc of locations) {
    if (!loc) continue;
    try {
      if (!fs.existsSync(loc)) continue;
      const content = fs.readFileSync(loc, "utf-8");
      let parsed: any;
      if (loc.endsWith(".json")) {
        parsed = JSON.parse(content);
      } else {
        parsed = YAML.parse(content);
      }
      if (parsed?.mcp_servers && typeof parsed.mcp_servers === "object") {
        return parsed.mcp_servers as Record<string, McpServerConfig>;
      }
    } catch {
      // try next
    }
  }

  return {};
}

// ── MCP Presets ────────────────────────────────────────────────────

export interface McpPreset {
  name: string;
  description: string;
  /** Server type: stdio or url */
  type: "stdio" | "url";
  config: McpServerConfig;
  /** Keys the user needs to provide (env var names) */
  requiredEnv?: string[];
  /** Instructions for getting keys */
  setupInstructions?: string;
}

/** Built-in popular MCP server presets */
export const MCP_PRESETS: Record<string, McpPreset> = {
  figma: {
    name: "Figma",
    description: "Read & inspect Figma design files — components, frames, styles, exports",
    type: "stdio",
    config: {
      command: "npx",
      args: ["-y", "figma-mcp"],
      env: { FIGMA_ACCESS_TOKEN: "your-figma-personal-access-token" },
    },
    requiredEnv: ["FIGMA_ACCESS_TOKEN"],
    setupInstructions: "Get your Figma Personal Access Token:\n1. Go to Figma > Settings > Account > Personal Access Tokens\n2. Create a new token\n3. Set it as 'figma' in your config via /mcp config figma <token>\n   Or export FIGMA_ACCESS_TOKEN=... in your env\n\nThen: /mcp add figma",
  },
  github: {
    name: "GitHub",
    description: "Manage repos, issues, PRs, reviews, search code — full GitHub API",
    type: "stdio",
    config: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "your-github-token" },
    },
    requiredEnv: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    setupInstructions: "Get a GitHub Personal Access Token:\n1. GitHub > Settings > Developer settings > Personal access tokens > Fine-grained tokens\n2. Give it repo, issues, pull requests scopes\n3. Set via: /mcp config github <token>\n   Or export GITHUB_PERSONAL_ACCESS_TOKEN=...",
  },
  filesystem: {
    name: "Filesystem",
    description: "Read, write, search files in specific directories on the local machine",
    type: "stdio",
    config: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/projects"],
      timeout: 30,
    },
    setupInstructions: "Customize the allowed directory:\n  /mcp config filesystem --dir /path/to/allowed\nThen: /mcp add filesystem",
  },
  playwright: {
    name: "Playwright",
    description: "Browser automation — navigate pages, take screenshots, run JS, scrape",
    type: "stdio",
    config: {
      command: "npx",
      args: ["-y", "@playwright/mcp"],
      timeout: 120,
    },
    setupInstructions: "Run: /mcp add playwright\nRequires Playwright browsers: npx playwright install chromium",
  },
  brave: {
    name: "Brave Search",
    description: "Web search via Brave Search API — get up-to-date results without Whoogle",
    type: "stdio",
    config: {
      command: "npx",
      args: ["-y", "@anthropic/search-mcp"],
      env: { ANTHROPIC_SEARCH_API_KEY: "your-brave-api-key" },
    },
    requiredEnv: ["ANTHROPIC_SEARCH_API_KEY"],
    setupInstructions: "Get a Brave Search API key:\n1. Sign up at https://brave.com/search/api/\n2. Get your API key\n3. Set via: /mcp config brave <key>\n   Or export ANTHROPIC_SEARCH_API_KEY=...",
  },
  supabase: {
    name: "Supabase",
    description: "Query Supabase projects — tables, rows, schemas, SQL queries",
    type: "stdio",
    config: {
      command: "npx",
      args: ["-y", "@anthropic/supabase-mcp"],
      env: { SUPABASE_URL: "https://your-project.supabase.co", SUPABASE_ANON_KEY: "your-anon-key" },
    },
    requiredEnv: ["SUPABASE_URL", "SUPABASE_ANON_KEY"],
    setupInstructions: "Get your Supabase credentials:\n1. Project > Settings > API\n2. Copy Project URL and anon/public key\n3. Set via: /mcp config supabase --url <url> --key <anon-key>\n   Or export SUPABASE_URL=... and SUPABASE_ANON_KEY=...",
  },
  docker: {
    name: "Docker",
    description: "Manage Docker containers, images, volumes, networks — full Docker API",
    type: "stdio",
    config: {
      command: "npx",
      args: ["-y", "@anthropic/docker-mcp"],
      timeout: 60,
    },
    setupInstructions: "Requires Docker running locally.\nRun: /mcp add docker\nAccess to Docker socket (docker.sock) is needed.",
  },
  linear: {
    name: "Linear",
    description: "Manage Linear issues, projects, teams — full Linear API",
    type: "stdio",
    config: {
      command: "npx",
      args: ["-y", "@anthropic/linear-mcp"],
      env: { LINEAR_API_KEY: "your-linear-api-key" },
    },
    requiredEnv: ["LINEAR_API_KEY"],
    setupInstructions: "Get your Linear API key:\n1. Linear > Settings > API > Personal API Keys\n2. Create a new key\n3. Set via: /mcp config linear <key>\n   Or export LINEAR_API_KEY=...",
  },
  sqlite: {
    name: "SQLite",
    description: "Query and manage SQLite databases — read schema, run queries, transactions",
    type: "stdio",
    config: {
      command: "uvx",
      args: ["mcp-server-sqlite", "--db-path", "./data.db"],
      timeout: 30,
    },
    setupInstructions: "Customize the database path:\n  /mcp config sqlite --db-path /path/to/database.db\nThen: /mcp add sqlite\nRequires uv: pip install uvx",
  },
  sequential: {
    name: "Sequential Thinking",
    description: "Break down complex problems step-by-step with structured thinking",
    type: "stdio",
    config: {
      command: "npx",
      args: ["-y", "@anthropic/sequential-thinking-mcp"],
    },
    setupInstructions: "Run: /mcp add sequential\nNo API key required — pure reasoning tool.",
  },
};

/** Get a preset config with user-provided values filled in */
export function applyMcpPreset(
  presetName: string,
  values: Record<string, string>,
): { config: McpServerConfig; instructions?: string } | null {
  const preset = MCP_PRESETS[presetName];
  if (!preset) return null;

  // Deep clone the config
  const config: McpServerConfig = {
    command: preset.config.command,
    args: preset.config.args ? [...preset.config.args] : [],
    env: preset.config.env ? { ...preset.config.env } : undefined,
    timeout: preset.config.timeout,
    connect_timeout: preset.config.connect_timeout,
  };

  // Fill in values (env vars, args)
  if (config.env && preset.requiredEnv) {
    for (const envName of preset.requiredEnv) {
      if (values[envName]) {
        config.env[envName] = values[envName];
      }
    }
  }

  // Handle special args substitutions
  if (presetName === "filesystem" && values["dir"]) {
    config.args = ["-y", "@modelcontextprotocol/server-filesystem", values["dir"]];
  }
  if (presetName === "sqlite" && values["db-path"]) {
    config.args = ["mcp-server-sqlite", "--db-path", values["db-path"]];
  }

  return { config, instructions: preset.setupInstructions };
}

/** List available presets as formatted string */
export function formatMcpPresets(): string {
  let out = `\n${chalk.bold.cyan("  MCP Presets")}  ${chalk.dim(`(${Object.keys(MCP_PRESETS).length} available)`)}\n\n`;

  for (const [key, preset] of Object.entries(MCP_PRESETS)) {
    const tags: string[] = [];
    if (preset.requiredEnv?.length) tags.push(chalk.yellow("needs key"));
    else tags.push(chalk.green("ready"));
    out += `  ${chalk.bold(key.padEnd(15))} ${preset.description}\n`;
    out += `    ${chalk.dim(preset.type)}  ${tags.join(" · ")}\n`;
  }

  out += `\n${chalk.dim("  Install: /mcp add <name>")}\n`;
  out += `${chalk.dim("  Config:  /mcp config <name> <key>=<value>")}\n`;
  return out;
}
