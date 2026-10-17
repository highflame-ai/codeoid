/**
 * The secret-path gate (secret-paths.ts): the daemon's credential files and a
 * process's environment are never read by an agent tool, and a search rooted
 * above them never runs unprompted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

const verdict = (input: unknown) => secretPathVerdict(input, { workdir, configDir });

describe("secretPathVerdict", () => {
  test("denies the credential files, on every backend's input key", () => {
    for (const name of ["claude-accounts.json", "config.json", ".env", "local-token-7400", "claude-accounts.json.123.ab.tmp"]) {
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

  test("denies a process environment or memory", () => {
    for (const p of ["/proc/self/environ", "/proc/1234/environ", "/proc/self/mem", "/proc/self/fd/3", "/proc/self/task/9/environ"]) {
      expect(verdict({ file_path: p })?.action).toBe("deny");
    }
  });

  test("asks — never auto-runs — a search rooted above the credential files", () => {
    expect(verdict({ pattern: "sk-ant", path: join(root, "home") })?.action).toBe("ask");
    expect(verdict({ pattern: "sk-ant", path: configDir })?.action).toBe("ask");
    expect(verdict({ pattern: `${configDir}/*.json` })?.action).toBe("ask");
    expect(verdict({ pattern: "*", path: "/proc" })?.action).toBe("ask");
  });

  test("leaves everything else alone — including the rest of the config dir", () => {
    expect(verdict({ file_path: join(workdir, "src", "index.ts") })).toBeNull();
    expect(verdict({ pattern: "TODO", path: workdir })).toBeNull();
    expect(verdict({ pattern: "**/*.ts" })).toBeNull();
    expect(verdict({ file_path: join(configDir, "packs", "skills", "SKILL.md") })).toBeNull();
    expect(verdict({ file_path: join(configDir, "transcripts", "x.jsonl") })).toBeNull();
    expect(verdict({ file_path: "/proc/cpuinfo" })).toBeNull();
    expect(verdict({ command: "ls" })).toBeNull();
  });
});
