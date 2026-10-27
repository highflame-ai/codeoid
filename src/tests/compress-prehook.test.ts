/**
 * PreToolUse rewrite helper tests — verify that `rewriteBashToolInput`
 * produces the expected wrapped command when enabled + eligible, and
 * returns null on every pass-through path.
 */

import { describe, it, expect } from "bun:test";
import {
  rewriteBashToolInput,
  CompressionRegistry,
  BUILTIN_RULES,
} from "../daemon/compress/index.js";
import type { CodeoidConfig } from "../config.js";

function mkConfig(enabled: boolean, overrides: Partial<CodeoidConfig["compress"]> = {}): CodeoidConfig {
  return {
    daemonUrl: "ws://127.0.0.1:7400",
    dbPath: "/tmp/codeoid.db",
    transcriptDir: "/tmp/transcripts",
    auth: { baseUrl: "http://localhost:8899" },
    zeroidUrl: "http://localhost:8899",
    workspaceIndex: {
      enabled: true,
      episodeThreshold: 5,
      timeThresholdMs: 60_000,
      debounceMs: 15_000,
    },
    compress: {
      enabled,
      excludeCommands: [],
      excludePatterns: [],
      compressPipes: false,
      minBytes: 1024,
      ...overrides,
    },
    labeling: {},
    telemetry: { osc8: "auto" },
    autoRotate: {
      enabled: false,
      warnPct: 0.6,
      rotatePct: 0.8,
      hardRotatePct: 0.9,
      minTurnsBeforeRotate: 3,
      strategy: "task-anchor",
    },
    session: {},
  };
}

function mkRegistry(overrides: {
  excludeCommands?: string[];
  excludePatterns?: RegExp[];
} = {}): CompressionRegistry {
  return new CompressionRegistry({
    rules: BUILTIN_RULES,
    excludeCommands: overrides.excludeCommands,
    excludePatterns: overrides.excludePatterns,
  });
}

describe("rewriteBashToolInput", () => {
  it("wraps an eligible Bash command with base64 transport", () => {
    const out = rewriteBashToolInput({
      toolName: "Bash",
      toolInput: { command: "git diff HEAD~5" },
      config: mkConfig(true),
      registry: mkRegistry(),
      workdir: "/tmp",
      wrapperPath: "/fake/wrapper.ts",
    });
    expect(out).not.toBeNull();
    expect(typeof out!.command).toBe("string");
    const cmd = out!.command as string;
    expect(cmd.startsWith("bun ")).toBe(true);
    expect(cmd).toContain("/fake/wrapper.ts");
    expect(cmd).toContain("--b64");
    expect(cmd).toContain("--cwd /tmp");
    // The original command is base64-encoded somewhere.
    const b64 = Buffer.from("git diff HEAD~5", "utf8").toString("base64");
    expect(cmd).toContain(b64);
  });

  it("returns null when tool is not Bash", () => {
    expect(
      rewriteBashToolInput({
        toolName: "Read",
        toolInput: { file_path: "/foo" },
        config: mkConfig(true),
        registry: mkRegistry(),
        workdir: "/tmp",
      }),
    ).toBeNull();
  });

  it("returns null when compress.enabled is false", () => {
    expect(
      rewriteBashToolInput({
        toolName: "Bash",
        toolInput: { command: "git diff" },
        config: mkConfig(false),
        registry: mkRegistry(),
        workdir: "/tmp",
      }),
    ).toBeNull();
  });

  it("returns null on empty command", () => {
    expect(
      rewriteBashToolInput({
        toolName: "Bash",
        toolInput: { command: "" },
        config: mkConfig(true),
        registry: mkRegistry(),
        workdir: "/tmp",
      }),
    ).toBeNull();
  });

  it("returns null when no rule matches", () => {
    // A command the generic rule still might match; but with an empty rules
    // list nothing fires.
    const reg = new CompressionRegistry({ rules: [] });
    expect(
      rewriteBashToolInput({
        toolName: "Bash",
        toolInput: { command: "echo hello" },
        config: mkConfig(true),
        registry: reg,
        workdir: "/tmp",
      }),
    ).toBeNull();
  });

  it("is idempotent — rewritten commands are not re-wrapped", () => {
    const firstOut = rewriteBashToolInput({
      toolName: "Bash",
      toolInput: { command: "git diff" },
      config: mkConfig(true),
      registry: mkRegistry(),
      workdir: "/tmp",
      wrapperPath: "/path/to/wrapper-cli.ts",
    });
    expect(firstOut).not.toBeNull();
    const second = rewriteBashToolInput({
      toolName: "Bash",
      toolInput: { command: firstOut!.command as string },
      config: mkConfig(true),
      registry: mkRegistry(),
      workdir: "/tmp",
      wrapperPath: "/path/to/wrapper-cli.ts",
    });
    expect(second).toBeNull();
  });

  it("respects exclude list at the registry level", () => {
    const reg = mkRegistry({ excludeCommands: ["git push"] });
    expect(
      rewriteBashToolInput({
        toolName: "Bash",
        toolInput: { command: "git push origin main" },
        config: mkConfig(true),
        registry: reg,
        workdir: "/tmp",
      }),
    ).toBeNull();
  });

  it("shell-quotes wrapper/workdir paths containing spaces", () => {
    const out = rewriteBashToolInput({
      toolName: "Bash",
      toolInput: { command: "git diff" },
      config: mkConfig(true),
      registry: mkRegistry(),
      workdir: "/Users/alice/my repo",
      wrapperPath: "/path with spaces/wrapper.ts",
    });
    expect(out).not.toBeNull();
    const cmd = out!.command as string;
    expect(cmd).toContain("'/path with spaces/wrapper.ts'");
    expect(cmd).toContain("'/Users/alice/my repo'");
  });
});

describe("decodeCompressedCommand (#431)", () => {
  it("sees through codeoid's own wrapper to the command it runs — and only that wrapper", async () => {
    const { decodeCompressedCommand, resolveWrapperPath } = await import("../daemon/compress/prehook.js");
    const b64 = Buffer.from("rm -rf ~", "utf8").toString("base64");
    expect(decodeCompressedCommand(`bun ${resolveWrapperPath()} --b64 ${b64} --cwd /w`)).toBe("rm -rf ~");
    expect(decodeCompressedCommand(`bun /tmp/evil/wrapper-cli.ts --b64 ${b64} --cwd /w`)).toBeNull();
    // A look-alike of the same length, too.
    const lookAlike = resolveWrapperPath().replace("compress", "compresX");
    expect(decodeCompressedCommand(`bun ${lookAlike} --b64 ${b64} --cwd /w`)).toBeNull();
    expect(decodeCompressedCommand("git status")).toBeNull();
  });
});
