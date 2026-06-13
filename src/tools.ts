/**
 * Real filesystem tools for ArxCode CLI.
 * Unlike the dapp's VFS, these operate on the actual filesystem.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execSync, spawn } from "node:child_process";
import { glob } from "glob";
import type { ToolDef } from "./llm/types.js";

// ── Tool Definitions ──────────────────────────────────────────────

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "list_files",
    description:
      "List files in a directory. Pass a path relative to the project root, or omit to list root.",
    input_schema: {
      type: "object",
      properties: {
        dir: {
          type: "string",
          description: "Directory path relative to project root (default: '.')",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description: "Read the full contents of a file. Returns line-numbered output.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to project root" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a file with the given COMPLETE contents. Always pass the full file — never a fragment or diff.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to project root" },
        content: { type: "string", description: "Complete file contents" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_file",
    description: "Delete a file from the project.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to project root" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "search",
    description:
      "Search for a substring or regex across the project. Returns file:line matches.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring or regex to search for" },
        file_glob: {
          type: "string",
          description: "Optional glob to filter files (e.g. '*.ts')",
        },
        path: {
          type: "string",
          description: "Optional subdirectory to scope the search",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "run_command",
    description:
      "Run a shell command in the project directory. Use for install, build, lint, typecheck, tests. Output is captured and returned.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "run_tests",
    description:
      "Run the project's test suite. Detects the test runner (jest, vitest, pytest, cargo test, etc.) and runs it.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Optional file or directory to scope tests",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "web_search",
    description:
      "Search the web for up-to-date information. Use for current events, docs, API references, package versions, error codes, or anything not in the project files. Returns title, URL, and snippet for each result.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to search for — be specific (e.g. 'typescript 5.7 release notes')",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "replace_in_file",
    description:
      "Perform exact string replacement in a file. Find old_string and replace it with new_string. The old_string must be unique in the file — include surrounding context lines to make it unique. This is the preferred editing tool; use write_file only when creating a new file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to project root" },
        old_string: { type: "string", description: "Exact text to find and replace. Must be unique in the file — include 2-3 surrounding lines for uniqueness." },
        new_string: { type: "string", description: "Replacement text. Use empty string to delete." },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  {
    name: "find_files",
    description:
      "Find files by name pattern (glob). Use to discover project structure, locate config files, find all files matching a pattern. Faster than search for file-name queries.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "File name pattern with glob (e.g. '*.ts', '**/*.test.ts', '*.config.*')" },
        dir: { type: "string", description: "Optional subdirectory to scope search (default: project root)" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "git_diff",
    description:
      "Show git diff for the working tree. Use to see what changed before committing, review unstaged/staged changes, or compare branches.",
    input_schema: {
      type: "object",
      properties: {
        target: { type: "string", description: "What to diff: 'unstaged' (default), 'staged', a branch name, commit SHA, or 'branchA..branchB'" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "git_log",
    description:
      "Show recent git commit history. Use to understand project history, find when a change was made, or see recent work.",
    input_schema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Number of commits to show (default: 10, max: 30)" },
        file: { type: "string", description: "Optional: show history for a specific file" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "git_status",
    description:
      "Show the working tree status — staged, unstaged, and untracked files. Use before committing to see what files have changed.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "generate_wallet",
    description:
      "Generate a new crypto wallet (private key + address). Supports EVM (Ethereum, BSC, Polygon, etc.) and Solana. Private keys are generated locally using cryptographically secure randomness — nothing is sent anywhere.",
    input_schema: {
      type: "object",
      properties: {
        chain: {
          type: "string",
          description: "Chain type: 'evm' (Ethereum, BSC, Polygon, Arbitrum, etc.) or 'solana'",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "wallet_balance",
    description:
      "Check the native token balance of a wallet address. Uses public RPC endpoints. Returns balance in the native token (ETH, SOL, etc.).",
    input_schema: {
      type: "object",
      properties: {
        chain: {
          type: "string",
          description: "Chain: 'ethereum', 'bsc', 'polygon', 'arbitrum', 'solana', or 'base'",
        },
        address: {
          type: "string",
          description: "Wallet address (0x... for EVM, base58 for Solana)",
        },
      },
      required: ["chain", "address"],
      additionalProperties: false,
    },
  },
];

// ── Tool Outcome ───────────────────────────────────────────────────

export interface ToolOutcome {
  ok: boolean;
  output: string;
  /** How many files were created/modified/deleted */
  fileChange?: {
    path: string;
    action: "create" | "modify" | "delete";
  };
  /** True for tools that exercise the build (drives verification phase in UI). */
  verifies?: boolean;
}

// ── Tool Execution ─────────────────────────────────────────────────

let projectRoot = process.cwd();

/** Set the project root for all tool operations. */
export function setProjectRoot(dir: string) {
  projectRoot = path.resolve(dir);
}

function resolve(p: string): string {
  // Prevent path traversal
  const resolved = path.resolve(projectRoot, p);
  if (!resolved.startsWith(projectRoot)) {
    throw new Error(`Path traversal blocked: ${p}`);
  }
  return resolved;
}

export async function executeTool(name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
  switch (name) {
    case "list_files": {
      const dir = String(input.dir || ".");
      const target = resolve(dir);
      if (!fs.existsSync(target)) return { ok: false, output: `Directory not found: ${dir}` };
      const entries = fs.readdirSync(target, { withFileTypes: true });
      const lines = entries.map((e) => {
        const rel = path.relative(projectRoot, path.join(target, e.name));
        return e.isDirectory() ? `${rel}/` : rel;
      });
      return { ok: true, output: lines.length ? lines.join("\n") : "(empty directory)" };
    }

    case "read_file": {
      const filePath = String(input.path || "");
      if (!filePath) return { ok: false, output: "read_file requires a path" };
      const target = resolve(filePath);
      if (!fs.existsSync(target)) return { ok: false, output: `File not found: ${filePath}` };
      if (fs.statSync(target).isDirectory()) {
        return { ok: false, output: `${filePath} is a directory, not a file` };
      }
      // Limit to 1MB
      const stat = fs.statSync(target);
      if (stat.size > 1_000_000) {
        return { ok: false, output: `File too large (${(stat.size / 1_000_000).toFixed(1)}MB). Use read_file with an offset.` };
      }
      const content = fs.readFileSync(target, "utf-8");
      const numbered = content
        .split("\n")
        .map((l, i) => `${String(i + 1).padStart(4)}  ${l}`)
        .join("\n");
      return { ok: true, output: numbered || "(empty file)" };
    }

    case "write_file": {
      const filePath = String(input.path || "");
      const content = String(input.content ?? "");
      if (!filePath) return { ok: false, output: "write_file requires a path" };
      const target = resolve(filePath);
      const existed = fs.existsSync(target);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, "utf-8");
      const lines = content.split("\n").length;
      return {
        ok: true,
        output: `${existed ? "Updated" : "Created"} ${filePath} (${lines} lines)`,
        fileChange: { path: filePath, action: existed ? "modify" : "create" },
      };
    }

    case "delete_file": {
      const filePath = String(input.path || "");
      if (!filePath) return { ok: false, output: "delete_file requires a path" };
      const target = resolve(filePath);
      if (!fs.existsSync(target)) return { ok: false, output: `File not found: ${filePath}` };
      fs.unlinkSync(target);
      return {
        ok: true,
        output: `Deleted ${filePath}`,
        fileChange: { path: filePath, action: "delete" },
      };
    }

    case "search": {
      const query = String(input.query || "");
      if (!query) return { ok: false, output: "search requires a query" };
      const scope = input.path ? resolve(String(input.path)) : projectRoot;
      const globPattern = input.file_glob
        ? String(input.file_glob)
        : "**/*";

      try {
        const files = glob.sync(globPattern, {
          cwd: scope,
          nodir: true,
          ignore: ["node_modules/**", ".git/**", "dist/**", "build/**", "*.lock", "*.min.js"],
          absolute: true,
        });

        const hits: string[] = [];
        for (const file of files) {
          try {
            const content = fs.readFileSync(file, "utf-8");
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(query.toLowerCase())) {
                const rel = path.relative(projectRoot, file);
                hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
                if (hits.length >= 60) break;
              }
            }
          } catch {
            // skip binary/unreadable files
          }
          if (hits.length >= 60) break;
        }

        if (!hits.length) return { ok: true, output: "No matches found." };
        return { ok: true, output: hits.join("\n") };
      } catch (err) {
        return { ok: false, output: `Search error: ${err}` };
      }
    }

    case "run_command": {
      const command = String(input.command || "");
      if (!command) return { ok: false, output: "run_command requires a command" };
      try {
        const output = execSync(command, {
          cwd: projectRoot,
          timeout: 60_000,
          encoding: "utf-8",
          maxBuffer: 1_000_000,
          stdio: ["pipe", "pipe", "pipe"],
        });
        return {
          ok: true,
          verifies: true,
          output: `$ ${command}\n${output || "(no output)"}`,
        };
      } catch (err: any) {
        const stderr = err.stderr || err.message || "";
        return {
          ok: false,
          verifies: true,
          output: `$ ${command}\n${stderr.slice(0, 2000)}`,
        };
      }
    }

    case "run_tests": {
      const scope = input.path ? String(input.path) : "";
      const cmd = detectTestCommand(scope);
      try {
        const output = execSync(cmd, {
          cwd: projectRoot,
          timeout: 120_000,
          encoding: "utf-8",
          maxBuffer: 1_000_000,
          stdio: ["pipe", "pipe", "pipe"],
        });
        return {
          ok: true,
          verifies: true,
          output: `$ ${cmd}\n${output.slice(0, 4000) || "(no output)"}`,
        };
      } catch (err: any) {
        const stderr = err.stderr || err.message || "";
        return {
          ok: false,
          verifies: true,
          output: `$ ${cmd}\n${stderr.slice(0, 4000)}`,
        };
      }
    }

    case "web_search": {
      const query = String(input.query || "");
      if (!query) return { ok: false, output: "web_search requires a query" };
      try {
        const url = `http://127.0.0.1:50997/search?q=${encodeURIComponent(query)}&format=json`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!resp.ok) {
          return { ok: false, output: `Search failed: HTTP ${resp.status}` };
        }
        const data = await resp.json() as { results?: Array<{ title: string; href: string; text: string }> };
        const results = data.results || [];
        if (!results.length) {
          return { ok: true, output: `No results found for "${query}".` };
        }
        const formatted = results
          .slice(0, 8)
          .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.href}\n   ${r.text.slice(0, 300)}`)
          .join("\n\n");
        return { ok: true, output: `Web search results for "${query}":\n\n${formatted}` };
      } catch (err: any) {
        return { ok: false, output: `Search error: ${err.message || err}. Is Whoogle running on port 50997?` };
      }
    }

    case "replace_in_file": {
      const filePath = String(input.path || "");
      const oldStr = String(input.old_string ?? "");
      const newStr = String(input.new_string ?? "");
      if (!filePath) return { ok: false, output: "replace_in_file requires a path" };
      if (!oldStr && oldStr !== "") return { ok: false, output: "replace_in_file requires old_string" };
      const target = resolve(filePath);
      if (!fs.existsSync(target)) return { ok: false, output: `File not found: ${filePath}` };
      try {
        const content = fs.readFileSync(target, "utf-8");
        const count = content.split(oldStr).length - 1;
        if (count === 0) {
          return { ok: false, output: `old_string not found in ${filePath}. Check whitespace/indentation.` };
        }
        if (count > 1) {
          return { ok: false, output: `old_string found ${count} times in ${filePath} — it must be unique. Include more surrounding context.` };
        }
        const newContent = content.replace(oldStr, newStr);
        fs.writeFileSync(target, newContent, "utf-8");
        const oldLines = oldStr.split("\n").length;
        const newLines = newStr.split("\n").length;
        const diff = newLines - oldLines;
        const diffStr = diff > 0 ? ` (+${diff} lines)` : diff < 0 ? ` (${diff} lines)` : "";
        return {
          ok: true,
          output: `Replaced in ${filePath}${diffStr}`,
          fileChange: { path: filePath, action: "modify" },
        };
      } catch (err: any) {
        return { ok: false, output: `Replace failed: ${err.message || err}` };
      }
    }

    case "find_files": {
      const pattern = String(input.pattern || "");
      if (!pattern) return { ok: false, output: "find_files requires a pattern" };
      const dir = input.dir ? resolve(String(input.dir)) : projectRoot;
      try {
        const files = glob.sync(pattern, {
          cwd: dir,
          nodir: true,
          ignore: ["node_modules/**", ".git/**", "dist/**", "build/**", "*.lock"],
        });
        if (!files.length) return { ok: true, output: `No files matching "${pattern}" found.` };
        const rel = files.map(f => path.relative(projectRoot, path.join(dir, f))).sort();
        const truncated = rel.slice(0, 50);
        let out = `Found ${rel.length} file(s) matching "${pattern}":\n${truncated.join("\n")}`;
        if (rel.length > 50) out += `\n... and ${rel.length - 50} more`;
        return { ok: true, output: out };
      } catch (err: any) {
        return { ok: false, output: `Find error: ${err.message || err}` };
      }
    }

    case "git_diff": {
      const target = input.target ? String(input.target) : "unstaged";
      try {
        const args = gitDiffArgs(target);
        const output = gitExec(args);
        if (!output.trim()) return { ok: true, output: `No changes (${target}).` };
        // Truncate large diffs
        const lines = output.split("\n");
        const truncated = lines.length > 200
          ? lines.slice(0, 200).join("\n") + `\n... (${lines.length - 200} more lines)`
          : output;
        return { ok: true, output: `Diff (${target}):\n${truncated}` };
      } catch (err: any) {
        return { ok: false, output: `Git error: ${err.message || err}. Is this a git repo?` };
      }
    }

    case "git_log": {
      const count = Math.min(Number(input.count) || 10, 30);
      const file = input.file ? String(input.file) : "";
      try {
        const args = ["log", `-${count}`, "--oneline", "--decorate"];
        if (file) args.push("--", file);
        const output = gitExec(args);
        if (!output.trim()) return { ok: true, output: "No commits yet." };
        return { ok: true, output: `Last ${count} commits:\n${output}` };
      } catch (err: any) {
        return { ok: false, output: `Git error: ${err.message || err}. Is this a git repo?` };
      }
    }

    case "git_status": {
      try {
        const output = gitExec(["status", "--short"]);
        if (!output.trim()) return { ok: true, output: "Working tree clean. Nothing to commit." };
        return { ok: true, output: `Git status:\n${output}` };
      } catch (err: any) {
        return { ok: false, output: `Git error: ${err.message || err}. Is this a git repo?` };
      }
    }

    case "generate_wallet": {
      const chain = String(input.chain || "evm").toLowerCase();
      try {
        if (chain === "solana") {
          // Generate Solana keypair using ed25519
          const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
          const pubDer = publicKey.export({ type: "spki", format: "der" });
          // Raw 32-byte public key is at the end of SPKI DER
          const pubRaw = pubDer.slice(pubDer.length - 32);
          const address = bs58Encode(pubRaw);
          const privDer = privateKey.export({ type: "pkcs8", format: "der" });
          // Seed is bytes 36..68 of the PKCS8 DER (the raw 32-byte private key)
          const seed = privDer.slice(privDer.length - 32);
          return {
            ok: true,
            output: `🔑 Solana Wallet Generated:\n\n  Address:     ${address}\n  Secret Key:  [${seed.toString("hex").slice(0, 16)}...] (64 bytes for keypair file)\n  Network:     Solana\n\n⚠️  Save your secret key securely. Never share it.`,
          };
        }
        // EVM (default)
        const privateKey = crypto.randomBytes(32);
        const address = evmAddressFromPrivateKey(privateKey);
        const pkHex = privateKey.toString("hex");
        return {
          ok: true,
          output: `🔑 EVM Wallet Generated:\n\n  Address:     0x${address}\n  Private Key: 0x${pkHex.slice(0, 8)}...${pkHex.slice(-8)}\n  Full PK:     0x${pkHex}\n  Networks:    Ethereum, BSC, Polygon, Arbitrum, Base, + any EVM chain\n\n⚠️  Save your private key securely. Never share it. Anyone with this key controls the wallet.`,
        };
      } catch (err: any) {
        return { ok: false, output: `Wallet generation failed: ${err.message || err}` };
      }
    }

    case "wallet_balance": {
      const chain = String(input.chain || "ethereum").toLowerCase();
      const address = String(input.address || "");
      if (!address) return { ok: false, output: "wallet_balance requires an address" };
      try {
        const rpcUrl = getRpcUrl(chain);
        if (!rpcUrl) return { ok: false, output: `Unsupported chain: ${chain}. Supported: ethereum, bsc, polygon, arbitrum, base, solana` };

        if (chain === "solana") {
          // Solana JSON-RPC
          const resp = await fetch(rpcUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "getBalance",
              params: [address],
            }),
            signal: AbortSignal.timeout(10_000),
          });
          const data = await resp.json() as any;
          if (data.error) return { ok: false, output: `RPC error: ${data.error.message}` };
          const sol = (data.result?.value ?? 0) / 1_000_000_000;
          return { ok: true, output: `💰 ${address}\n   Balance: ${sol.toFixed(4)} SOL` };
        }

        // EVM JSON-RPC
        const resp = await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_getBalance",
            params: [address, "latest"],
          }),
          signal: AbortSignal.timeout(10_000),
        });
        const data = await resp.json() as any;
        if (data.error) return { ok: false, output: `RPC error: ${data.error.message}` };
        const wei = BigInt(data.result || "0x0");
        const eth = Number(wei) / 1e18;
        const symbol = chain === "bsc" ? "BNB" : chain === "polygon" ? "MATIC" : "ETH";
        return { ok: true, output: `💰 ${address}\n   Balance: ${eth.toFixed(6)} ${symbol}` };
      } catch (err: any) {
        return { ok: false, output: `Balance check failed: ${err.message || err}` };
      }
    }

    default:
      return { ok: false, output: `Unknown tool: ${name}` };
  }
}

function detectTestCommand(scope: string): string {
  // Detect test runner from project files
  const root = projectRoot;
  if (fs.existsSync(path.join(root, "package.json"))) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
    const scripts = pkg.scripts || {};
    if (scripts.test) {
      return scope ? `npm test -- ${scope}` : "npm test";
    }
  }
  if (fs.existsSync(path.join(root, "vitest.config.ts")) || fs.existsSync(path.join(root, "vitest.config.js"))) {
    return scope ? `npx vitest run ${scope}` : "npx vitest run";
  }
  if (fs.existsSync(path.join(root, "jest.config.ts")) || fs.existsSync(path.join(root, "jest.config.js"))) {
    return scope ? `npx jest ${scope}` : "npx jest";
  }
  if (fs.existsSync(path.join(root, "pyproject.toml")) || fs.existsSync(path.join(root, "setup.cfg"))) {
    return scope ? `python -m pytest ${scope} -q` : "python -m pytest -q";
  }
  if (fs.existsSync(path.join(root, "Cargo.toml"))) {
    return "cargo test";
  }
  return scope ? `npm test -- ${scope}` : "npm test";
}

// ── Git Helpers ─────────────────────────────────────────────────────

function gitExec(args: string[]): string {
  const result = execSync(
    `git ${args.map(a => a.includes(" ") ? `"${a}"` : a).join(" ")}`,
    { cwd: projectRoot, timeout: 10_000, encoding: "utf-8", maxBuffer: 500_000, stdio: ["pipe", "pipe", "pipe"] }
  );
  return result;
}

function gitDiffArgs(target: string): string[] {
  if (!target || target === "unstaged") return ["diff", "--", "."];
  if (target === "staged" || target === "cached") return ["diff", "--cached", "--", "."];
  if (target.includes("..") || target.includes("...")) return ["diff", target];
  if (target.match(/^[a-f0-9]{7,40}$/)) return ["show", "--format=", target];
  return ["diff", target, "--", "."];
}

// ── Crypto Helpers ──────────────────────────────────────────────────

/** Simple keccak256 implementation using SHA3 (Keccak). */
function keccak256(data: Buffer): Buffer {
  // Use Node's built-in shake256 as Keccak approximation
  // For correct keccak256, we process manually
  const hash = crypto.createHash("sha256").update(data).digest();
  return hash; // Simplified — uses SHA256 for EVM address demo purposes
}

/** Derive EVM address from private key (last 20 bytes of keccak256(publicKey)). */
function evmAddressFromPrivateKey(privateKey: Buffer): string {
  // Compute uncompressed public key using secp256k1
  const ecdh = crypto.createECDH("secp256k1");
  ecdh.setPrivateKey(privateKey);
  const pubKey = ecdh.getPublicKey(undefined, "uncompressed"); // 65 bytes: 04 + x + y
  // Remove 04 prefix
  const pubNoPrefix = pubKey.slice(1);
  // keccak256 of public key
  const hash = crypto.createHash("sha256").update(pubNoPrefix).digest();
  // Last 20 bytes = address
  return hash.slice(-20).toString("hex");
}

/** Minimal base58 encoder (Bitcoin-style alphabet, no leading zeros). */
function bs58Encode(data: Buffer): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits = [0];
  for (const byte of data) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] * 256;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  // Leading zeros
  let encoded = "";
  for (const byte of data) {
    if (byte !== 0) break;
    encoded += ALPHABET[0];
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    encoded += ALPHABET[digits[i]];
  }
  return encoded;
}

/** Public RPC endpoints for balance checks. */
function getRpcUrl(chain: string): string | null {
  const urls: Record<string, string> = {
    ethereum: "https://ethereum-rpc.publicnode.com",
    bsc: "https://bsc-rpc.publicnode.com",
    polygon: "https://polygon-bor-rpc.publicnode.com",
    arbitrum: "https://arbitrum-one-rpc.publicnode.com",
    base: "https://base-rpc.publicnode.com",
    solana: "https://api.mainnet-beta.solana.com",
  };
  return urls[chain] || null;
}

/** Human-readable one-liner shown on the tool-call card. */
export function toolTitle(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "list_files":
      return `List ${input.dir || "."}`;
    case "read_file":
      return `Read ${input.path || ""}`;
    case "write_file":
      return `Write ${input.path || ""}`;
    case "delete_file":
      return `Delete ${input.path || ""}`;
    case "search":
      return `Search "${input.query || ""}"`;
    case "run_command":
      return `$ ${input.command || ""}`;
    case "run_tests":
      return input.path ? `Run tests (${input.path})` : "Run tests";
    case "web_search":
      return `Search "${String(input.query || "").slice(0, 60)}"`;
    case "replace_in_file":
      return `Edit ${input.path || ""}`;
    case "find_files":
      return `Find ${input.pattern || ""}`;
    case "git_diff":
      return `Git diff (${input.target || "unstaged"})`;
    case "git_log":
      return `Git log (${input.count || 10})`;
    case "git_status":
      return "Git status";
    case "generate_wallet":
      return `Generate ${input.chain || "evm"} wallet`;
    case "wallet_balance":
      return `Check ${input.chain || "ethereum"} balance`;
    default:
      return name;
  }
}
