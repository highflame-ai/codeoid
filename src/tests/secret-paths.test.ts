/**
 * The secret-path gate (secret-paths.ts): the daemon's credential files and a
 * process's environment are never read by an agent tool, and a search rooted
 * above them never runs unprompted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { secretPathVerdict } from "../daemon/secret-paths.js";

let root: string;
let configDir: string;
let workdir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codeoid-secret-paths-"));
  configDir = join(root, "home", ".codeoid");
  workdir = join(root, "home", "code", "app");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(workdir, { recursive: true });
  writeFileSync(join(configDir, "claude-accounts.json"), "{}");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const verdict = (input: unknown, tool = "Read") => secretPathVerdict(tool, input, { workdir, configDir });

describe("secretPathVerdict", () => {
  test("denies the credential files, on every backend's input key", () => {
    for (const name of ["claude-accounts.json", "endpoints.json", "config.json", ".env", "local-token-7400", "claude-accounts.json.123.ab.tmp", "codeoid.db", "codeoid.db-wal"]) {
      expect(verdict({ file_path: join(configDir, name) })?.action).toBe("deny");
    }
    expect(verdict({ absolute_path: join(configDir, ".env") })?.action).toBe("deny"); // gemini / qwen read_file
    expect(verdict({ paths: ["README.md", join(configDir, "config.json")] })?.action).toBe("deny");
  });

  test("denies a relative path or a symlink that lands on one", () => {
    expect(verdict({ file_path: "../../.codeoid/claude-accounts.json" })?.action).toBe("deny");
    symlinkSync(join(configDir, "claude-accounts.json"), join(workdir, "innocent.json"));
    expect(verdict({ file_path: "innocent.json" })?.action).toBe("deny");
  });

  test("denies the agent CLIs' stored logins, a running login's dir, and an MCP move/copy source", () => {
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(root, "home", ".claude");
    try {
      expect(verdict({ file_path: join(root, "home", ".claude", ".credentials.json") })?.action).toBe("deny");
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
    }
    expect(verdict({ file_path: join(tmpdir(), "codeoid-claude-login-abc", ".credentials.json") })?.action).toBe("deny");
    expect(verdict({ source: join(configDir, ".env"), destination: join(workdir, "x") }, "move_file")?.action).toBe("deny");
  });

  test("denies pi's logins where pi reads them, a ~ in PI_CODING_AGENT_DIR included (#417)", () => {
    const saved = { dir: process.env.PI_CODING_AGENT_DIR, home: process.env.HOME };
    process.env.HOME = join(root, "home");
    process.env.PI_CODING_AGENT_DIR = "~/pi-agent";
    try {
      expect(verdict({ file_path: join(root, "home", "pi-agent", "auth.json") })?.action).toBe("deny");
    } finally {
      for (const [k, v] of [["PI_CODING_AGENT_DIR", saved.dir], ["HOME", saved.home]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("denies a multi-file edit when any of its files is a secret, not only the first (opencode's patch)", () => {
    const harmless = join(root, "home", "code", "notes.txt");
    expect(verdict({ file_path: harmless, files: [harmless, join(configDir, "config.json")] }, "Edit")?.action).toBe("deny");
    expect(verdict({ file_path: harmless, files: [harmless] }, "Edit")).toBeNull();
  });

  test("denies a process environment or memory", () => {
    for (const p of ["/proc/self/environ", "/proc/1234/environ", "/proc/self/mem", "/proc/self/fd/3", "/proc/self/task/9/environ"]) {
      expect(verdict({ file_path: p })?.action).toBe("deny");
    }
  });

  test("denies one reached through a process's root link, and a credential file through it, for a pid that isn't running too (#447 round-18 audit)", () => {
    for (const p of ["/proc/4242/root/proc/4242/environ", "/proc/self/root/proc/4242/environ", "/proc/4242/task/1/root/proc/1/environ", "/proc/4242/root/proc/4242/root/proc/1/fd/3", `/proc/4242/root${configDir}/config.json`]) {
      expect([p, verdict({ file_path: p })?.action]).toEqual([p, "deny"]);
    }
    expect(verdict({ file_path: "/proc/4242/status" })).toBeNull();
    expect(verdict({ file_path: "/proc/4242/root/etc/hostname" })).toBeNull();
  });

  test("asks — never auto-runs — a search rooted above the credential files", () => {
    expect(verdict({ pattern: "sk-ant", path: join(root, "home") }, "Grep")?.action).toBe("ask");
    expect(verdict({ pattern: "sk-ant", path: configDir }, "Grep")?.action).toBe("ask");
    expect(verdict({ pattern: `${configDir}/*.json` }, "Glob")?.action).toBe("ask");
    expect(verdict({ pattern: "*", path: "/proc" }, "Glob")?.action).toBe("ask");
    // No root = the workdir: a session whose workdir holds the config dir asks too.
    expect(secretPathVerdict("Grep", { pattern: "sk-ant-" }, { workdir: join(root, "home"), configDir })?.action).toBe("ask");
    // opencode's card for reaching outside the workdir names directories.
    expect(verdict({ directories: [configDir], tool: "grep" }, "opencode_external_directory")?.action).toBe("ask");
    expect(verdict({ directories: [join(root, "home", "code")], tool: "grep" }, "opencode_external_directory")).toBeNull();
  });

  test("asks before any tool touches ~/.claude.json — its tokens, and where MCP approvals live (#395)", () => {
    const file = join(homedir(), ".claude.json");
    expect(verdict({ file_path: file })?.action).toBe("ask");
    expect(verdict({ file_path: file, content: "{}" }, "Write")?.action).toBe("ask");
    expect(verdict({ file_path: join(homedir(), ".claude.jsonx") })).toBeNull();
  });

  test("leaves everything else alone — including the rest of the config dir", () => {
    expect(verdict({ file_path: join(workdir, "src", "index.ts") })).toBeNull();
    expect(verdict({ pattern: "TODO", path: workdir }, "Grep")).toBeNull();
    expect(verdict({ pattern: "TODO" }, "Grep")).toBeNull(); // the workdir, which holds no secrets
    expect(verdict({ pattern: "**/*.ts" }, "Glob")).toBeNull();
    // Grep's pattern is a regex, not a path: searching code for the string is fine.
    expect(verdict({ pattern: "/proc/self/environ", path: "src" }, "Grep")).toBeNull();
    expect(verdict({ file_path: join(configDir, "packs", "skills", "SKILL.md") })).toBeNull();
    expect(verdict({ file_path: join(configDir, "transcripts", "x.jsonl") })).toBeNull();
    expect(verdict({ file_path: "/proc/cpuinfo" })).toBeNull();
    expect(verdict({ command: "ls" })).toBeNull();
  });
});
