/**
 * Which Claude Code CLI the Claude backend runs (providers/claude/executable.ts):
 * the bundled one unless `providers.claude.command` names one no older than it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledClaudeVersion, cliVersion, compareVersions, resolveClaudeExecutable } from "../daemon/providers/claude/executable.js";
import { isBackendCommandKey } from "../daemon/settings/manifest.js";

const dir = mkdtempSync(join(tmpdir(), "codeoid-claude-exe-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in CLI whose `--version` prints `out`. */
function fakeCli(name: string, out: string, status = 0): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n[ "$1" = "--version" ] && { printf '%s\\n' '${out}'; exit ${status}; }\nexit 3\n`);
  chmodSync(p, 0o755);
  return p;
}

const deps = (version: string | null, which: string | null = "/usr/local/bin/claude") => ({
  bundledVersion: () => "2.1.322",
  version: () => version,
  which: () => which,
});

describe("resolveClaudeExecutable", () => {
  test("unset or blank: the bundled CLI, nothing to say", () => {
    for (const command of [undefined, "", "   "]) {
      expect(resolveClaudeExecutable(command, deps("9.9.9"))).toEqual({ path: null, version: "2.1.322", bundledVersion: "2.1.322", note: null });
    }
  });

  test("the same version as the bundled one: used, nothing to say", () => {
    expect(resolveClaudeExecutable("claude", deps("2.1.322"))).toEqual({ path: "/usr/local/bin/claude", version: "2.1.322", bundledVersion: "2.1.322", note: null });
  });

  test("a newer one: used, and the session is told its sandbox behaviour is untested", () => {
    const r = resolveClaudeExecutable("claude", deps("2.1.330"));
    expect(r.path).toBe("/usr/local/bin/claude");
    expect(r.note).toContain("2.1.330");
    expect(r.note).toContain("tested with 2.1.322");
    expect(r.note).toContain("untested");
  });

  test("an older one: the bundled CLI, saying why", () => {
    const r = resolveClaudeExecutable("claude", deps("2.1.316"));
    expect(r.path).toBeNull();
    expect(r.note).toContain("2.1.316, older than the 2.1.322");
    expect(r.note).toContain("bundled CLI (2.1.322)");
  });

  test("not on PATH, a relative path, or no version: the bundled CLI, saying why", () => {
    expect(resolveClaudeExecutable("claude", deps("2.1.330", null)).note).toContain("isn't on the daemon's PATH");
    expect(resolveClaudeExecutable("bin/claude", deps("2.1.330")).note).toContain("relative path");
    const none = resolveClaudeExecutable("/opt/claude", deps(null));
    expect(none.path).toBeNull();
    expect(none.note).toContain("didn't report a version");
  });

  test("an absolute path is checked as given; a bare name is looked up on PATH", () => {
    const seen: string[] = [];
    const r = resolveClaudeExecutable("/opt/cc/claude", { bundledVersion: () => "2.1.322", version: (p) => {
        seen.push(p);
        return "2.1.322";
      },
      which: () => null });
    expect(r.path).toBe("/opt/cc/claude");
    expect(seen).toEqual(["/opt/cc/claude"]);
  });

  test("with the real CLIs: a stand-in reporting a newer version is used, one reporting garbage or failing is not", () => {
    const bundled = bundledClaudeVersion();
    expect(bundled).toMatch(/^\d+\.\d+\.\d+$/);
    const newer = fakeCli("newer", "99.0.0 (Claude Code)");
    expect(resolveClaudeExecutable(newer).path).toBe(newer);
    expect(resolveClaudeExecutable(fakeCli("garbage", "not a version")).path).toBeNull();
    expect(resolveClaudeExecutable(fakeCli("fails", "99.0.0", 1)).path).toBeNull();
    expect(resolveClaudeExecutable(fakeCli("older", "0.0.1 (Claude Code)")).path).toBeNull();
  });
});

describe("cliVersion", () => {
  test("reads `--version`, and sees a reinstall (the file changed)", () => {
    const p = fakeCli("reinstalled", "2.1.300 (Claude Code)");
    expect(cliVersion(p)).toBe("2.1.300");
    writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' '2.1.400 (Claude Code)'\n`);
    utimesSync(p, new Date(), new Date(Date.now() + 5000));
    expect(cliVersion(p)).toBe("2.1.400");
  });

  test("a missing file or a directory has no version", () => {
    expect(cliVersion(join(dir, "missing"))).toBeNull();
    expect(cliVersion(dir)).toBeNull();
  });
});

test("compareVersions orders dotted numbers numerically", () => {
  expect(compareVersions("2.1.330", "2.1.322")).toBeGreaterThan(0);
  expect(compareVersions("2.1.99", "2.1.322")).toBeLessThan(0);
  expect(compareVersions("2.10.0", "2.9.9")).toBeGreaterThan(0);
  expect(compareVersions("2.1.322", "2.1.322")).toBe(0);
});

test("isBackendCommandKey: providers.<backend>.command only", () => {
  for (const k of ["providers.claude.command", "providers.codex.command", "providers.geminiCli.command"]) expect(isBackendCommandKey(k)).toBe(true);
  for (const k of ["providers.claude.commandx", "providers.codex.enabled", "mcpServers.x.command", "fork.setup", "providers..command"]) expect(isBackendCommandKey(k)).toBe(false);
});
