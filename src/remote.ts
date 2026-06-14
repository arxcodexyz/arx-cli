/**
 * Remote SSH transport for ArxCode CLI.
 * Routes tool execution through SSH to a remote machine.
 */

import { Client, type ClientChannel } from "ssh2";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import YAML from "yaml";
import chalk from "chalk";
import type { ToolDef } from "./llm/types.js";

// ── Types ──────────────────────────────────────────────────────────

export interface RemoteConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  projectRoot: string;
}

/** A remote connection session (the tether). */
export interface RemoteSession {
  config: RemoteConfig;
  client: Client;
  /** Cached SFTP client for file operations */
  _sftp?: import("ssh2").SFTPWrapper;
}

export interface RemoteTransport {
  /** Execute a shell command on the remote and return stdout+stderr */
  exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Read a file from the remote and return its content */
  readFile(remotePath: string): Promise<string>;
  /** Write content to a file on the remote */
  writeFile(remotePath: string, content: string): Promise<void>;
  /** List files in a remote directory */
  listFiles(remoteDir: string): Promise<string[]>;
  /** Delete a file on the remote */
  deleteFile(remotePath: string): Promise<void>;
  /** Check if a path exists on the remote */
  exists(remotePath: string): Promise<boolean>;
  /** Create directory recursively on remote */
  mkdir(remoteDir: string): Promise<void>;
  /** Close the connection */
  close(): void;
}

// ── Connection ─────────────────────────────────────────────────────

let activeSession: RemoteSession | null = null;

/** Get the current active remote session (if any). */
export function getActiveSession(): RemoteSession | null {
  return activeSession;
}

/** Get the active transport (if connected). */
export function getActiveTransport(): RemoteTransport | null {
  if (!activeSession) return null;
  return createTransport(activeSession);
}

/** Disconnect from remote. */
export function disconnectRemote(): void {
  if (activeSession) {
    try { activeSession.client.end(); } catch { /* ignore */ }
    activeSession = null;
  }
}

/**
 * Connect to a remote machine via SSH.
 * Returns a transport that can be used for tool execution.
 */
export function connectRemote(cfg: RemoteConfig): Promise<RemoteTransport> {
  return new Promise((resolve, reject) => {
    const client = new Client();

    client.on("ready", () => {
      activeSession = { config: cfg, client };
      resolve(createTransport(activeSession));
    });

    client.on("error", (err) => {
      reject(new Error(`SSH connection failed: ${err.message}`));
    });

    const connectOpts: import("ssh2").ConnectConfig = {
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      readyTimeout: 15_000,
    };

    if (cfg.privateKey) {
      connectOpts.privateKey = cfg.privateKey;
      connectOpts.passphrase = cfg.password || undefined;
    } else if (cfg.password) {
      connectOpts.password = cfg.password;
    }

    try {
      client.connect(connectOpts);
    } catch (err) {
      reject(new Error(`SSH connect error: ${err instanceof Error ? err.message : err}`));
    }
  });
}

// ── Transport Implementation ───────────────────────────────────────

function createTransport(session: RemoteSession): RemoteTransport {
  const { client, config } = session;

  function getSftp(): Promise<import("ssh2").SFTPWrapper> {
    return new Promise((resolve, reject) => {
      if (session._sftp) {
        return resolve(session._sftp);
      }
      client.sftp((err, sftp) => {
        if (err) return reject(new Error(`SFTP error: ${err.message}`));
        session._sftp = sftp;
        resolve(sftp);
      });
    });
  }

  function toRemote(localPath: string): string {
    if (path.isAbsolute(localPath)) {
      // If local path is absolute and under projectRoot, map it
      // Otherwise treat relative paths as relative to remote projectRoot
      return localPath;
    }
    return path.posix.join(config.projectRoot, localPath);
  }

  const transport: RemoteTransport = {
    async exec(command: string) {
      return new Promise((resolve, reject) => {
        client.exec(`cd ${escapeShell(config.projectRoot)} && ${command}`, (err, channel) => {
          if (err) return reject(new Error(`exec error: ${err.message}`));
          let stdout = "";
          let stderr = "";
          channel.on("data", (data: Buffer) => { stdout += data.toString(); });
          channel.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
          channel.on("close", (exitCode: number) => {
            resolve({ stdout, stderr, exitCode: exitCode ?? -1 });
          });
        });
      });
    },

    async readFile(remotePath: string) {
      const target = toRemote(remotePath);
      const sftp = await getSftp();
      return new Promise((resolve, reject) => {
        let buf = "";
        const stream = sftp.createReadStream(target);
        stream.on("data", (data: Buffer) => { buf += data.toString(); });
        stream.on("end", () => resolve(buf));
        stream.on("error", (err: Error) => reject(new Error(`Read error: ${err.message}`)));
      });
    },

    async writeFile(remotePath: string, content: string) {
      const target = toRemote(remotePath);
      // Ensure parent directory exists
      const dir = path.posix.dirname(target);
      try {
        await transport.mkdir(dir);
      } catch { /* dir may already exist */ }
      const sftp = await getSftp();
      return new Promise((resolve, reject) => {
        const stream = sftp.createWriteStream(target);
        stream.on("close", () => resolve());
        stream.on("error", (err: Error) => reject(new Error(`Write error: ${err.message}`)));
        stream.end(content);
      });
    },

    async listFiles(remoteDir: string) {
      const target = toRemote(remoteDir);
      const sftp = await getSftp();
      return new Promise((resolve, reject) => {
        sftp.readdir(target, (err, entries) => {
          if (err) return reject(new Error(`List error: ${err.message}`));
          const names = entries.map((e) => {
            const attrs = e.attrs;
            return attrs.isDirectory() ? `${e.filename}/` : e.filename;
          });
          resolve(names);
        });
      });
    },

    async deleteFile(remotePath: string) {
      const target = toRemote(remotePath);
      const sftp = await getSftp();
      return new Promise((resolve, reject) => {
        sftp.unlink(target, (err) => {
          if (err) return reject(new Error(`Delete error: ${err.message}`));
          resolve();
        });
      });
    },

    async exists(remotePath: string) {
      const target = toRemote(remotePath);
      const sftp = await getSftp();
      return new Promise((resolve) => {
        sftp.stat(target, (err) => {
          resolve(!err);
        });
      });
    },

    async mkdir(remoteDir: string) {
      const target = toRemote(remoteDir);
      const sftp = await getSftp();
      return new Promise((resolve, reject) => {
        // Recursive mkdir via exec is more reliable across SFTP implementations
        client.exec(`mkdir -p ${escapeShell(target)}`, (err, channel) => {
          if (err) return reject(new Error(`mkdir error: ${err.message}`));
          channel.on("close", (exitCode: number) => {
            if (exitCode === 0) resolve();
            else reject(new Error(`mkdir failed with exit code ${exitCode}`));
          });
        });
      });
    },

    close() {
      try { client.end(); } catch { /* ignore */ }
      activeSession = null;
    },
  };

  return transport;
}

// ── SSH Host Key Verification ──────────────────────────────────────

const knownHostsPath = path.join(os.homedir(), ".arx", "known_hosts");

/** Load known hosts from ~/.arx/known_hosts */
function loadKnownHosts(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    if (fs.existsSync(knownHostsPath)) {
      const content = fs.readFileSync(knownHostsPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 2) {
          map.set(parts[0], parts[1]);
        }
      }
    }
  } catch { /* ignore */ }
  return map;
}

/** Save a host key to ~/.arx/known_hosts */
function saveKnownHost(host: string, key: string): void {
  try {
    fs.mkdirSync(path.dirname(knownHostsPath), { recursive: true });
    fs.appendFileSync(knownHostsPath, `${host} ${key}\n`);
  } catch { /* ignore */ }
}

/** Check if a host key is known */
function isKnownHost(host: string, key: string): boolean {
  const known = loadKnownHosts();
  const saved = known.get(host);
  return saved === key;
}

// ── Remote Tools ────────────────────────────────────────────────────

/**
 * Create modified TOOL_DEFS that incorporate remote transport.
 * Filesystem tools are augmented with remote execution info.
 * The actual routing happens in harness.ts via the transport.
 */
export function createRemoteTools(_transport: RemoteTransport): ToolDef[] {
  // For now, we keep the same tool definitions since the transport
  // routing is handled at the execution layer in harness.ts.
  // We import TOOL_DEFS dynamically to avoid circular deps.
  return [];
}

// ── Config Persistence ─────────────────────────────────────────────

const remoteConfigDir = path.join(os.homedir(), ".arx");
const remoteConfigPath = path.join(remoteConfigDir, "remote.yaml");

/** Load remote config from ~/.arx/remote.yaml or project .arx/remote.yaml */
export function loadRemoteConfig(projectRoot?: string): RemoteConfig | null {
  // Check project-local first
  if (projectRoot) {
    const localPath = path.join(projectRoot, ".arx", "remote.yaml");
    const local = readRemoteConfigFile(localPath);
    if (local) return local;
  }

  // Check global
  const global = readRemoteConfigFile(remoteConfigPath);
  return global;
}

function readRemoteConfigFile(filePath: string): RemoteConfig | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, "utf-8");
    const raw = YAML.parse(content) as Record<string, unknown>;

    if (!raw || typeof raw !== "object") return null;

    return {
      host: String(raw.host || "localhost"),
      port: Number(raw.port) || 22,
      username: String(raw.username || ""),
      password: raw.password ? String(raw.password) : undefined,
      privateKey: raw.privateKey ? String(raw.privateKey) : undefined,
      projectRoot: String(raw.projectRoot || `~`),
    };
  } catch {
    return null;
  }
}

/** Save remote config (password is stripped out for security). */
export function saveRemoteConfig(cfg: RemoteConfig, projectRoot?: string): void {
  const targetPath = projectRoot
    ? path.join(projectRoot, ".arx", "remote.yaml")
    : remoteConfigPath;

  // Strip password from saved config — it should be prompted each time
  const toSave: Record<string, unknown> = {
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    projectRoot: cfg.projectRoot,
  };
  if (cfg.privateKey) toSave.privateKey = cfg.privateKey;
  // Never save password to disk

  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, YAML.stringify(toSave), "utf-8");
  } catch {
    // Silently fail
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function escapeShell(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Generate a connection status string for display */
export function remoteStatus(session: RemoteSession | null): string {
  if (!session) {
    return chalk.dim("  remote: not connected");
  }
  const { host, port, username } = session.config;
  const addr = port === 22 ? host : `${host}:${port}`;
  return chalk.green(`  🌐 remote: ${username}@${addr}`);
}

/** Parse a connection string like "user@host[:port]" */
export function parseConnectionString(conn: string): { username: string; host: string; port: number } | null {
  // Remove "ssh " prefix if present
  let cleaned = conn.trim();
  if (cleaned.startsWith("ssh ")) cleaned = cleaned.slice(4).trim();

  const atIdx = cleaned.lastIndexOf("@");
  if (atIdx <= 0) return null;

  const username = cleaned.slice(0, atIdx);
  const hostPart = cleaned.slice(atIdx + 1);
  const colonIdx = hostPart.lastIndexOf(":");
  const host = colonIdx > 0 ? hostPart.slice(0, colonIdx) : hostPart;
  const port = colonIdx > 0 ? parseInt(hostPart.slice(colonIdx + 1), 10) : 22;

  if (!username || !host) return null;
  if (isNaN(port) || port < 1 || port > 65535) return null;

  return { username, host, port };
}
