/**
 * How a project root is mounted (#448 round 12, docs/sandbox.md "Working
 * across repositories", Limits): on Claude's own sandbox, never a link in
 * the root shown by where it leads, nor an entry that is itself hidden (the
 * CLI lets a readable path equal to a hidden one win; one strictly inside
 * a readable one stays hidden); on bubblewrap, a hidden path in a dir shown
 * again under the host's /tmp is hidden there too.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import { bwrapArgs, type PathKind } from "../daemon/sandbox/bwrap.js";
import { claudeSandboxSettings, readAround } from "../daemon/sandbox/claude-native.js";
import { buildSandboxSpec, sandboxConfigOf } from "../daemon/sandbox/policy.js";
import type { SandboxRuntime } from "../daemon/sandbox/session-sandbox.js";

let base: string;
beforeEach(() => {
  const parent = process.env.CODEOID_TEST_SANDBOX_DIR ?? join(homedir(), ".cache");
  mkdirSync(parent, { recursive: true });
  base = realpathSync(mkdtempSync(join(parent, "codeoid-root-mounts-")));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("Claude's own sandbox shows nothing hidden of a root", () => {
  test("no link in a root is shown by its target; no hidden entry is shown again; a hidden path deeper stays in denyRead", () => {
    const home = join(base, "home");
    const root = join(home, "Workspace");
    const a = join(root, "a");
    const b = join(root, "b");
    for (const d of [a, b, join(home, ".ssh")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(home, ".ssh", "id_ed25519"), "k");
    symlinkSync(join(home, ".ssh"), join(root, "keys"));
    symlinkSync(home, join(root, "home-link"));
    writeFileSync(join(root, ".env"), "x");
    writeFileSync(join(b, ".env"), "x");
    const priv = join(root, "private");
    mkdirSync(priv);
    const tmp = join(base, "tmp");
    mkdirSync(tmp);
    const spec = buildSandboxSpec({
      sessionId: "s",
      workspace: a,
      tempDir: tmp,
      network: { mode: "off" },
      config: { sandbox: { ...sandboxConfigOf(undefined), hiddenPaths: [priv] } } as unknown as CodeoidConfig,
      hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" },
      projectRoots: [root],
    });
    const rt = { spec, config: sandboxConfigOf(undefined) } as unknown as Pick<SandboxRuntime, "spec" | "config">;
    const fs = claudeSandboxSettings(rt, { HOME: home }, undefined, "linux").filesystem;
    const read = fs?.allowRead ?? [];
    for (const shown of [join(home, ".ssh"), home, join(root, ".env"), priv, join(root, "keys"), join(root, "home-link")]) expect([shown, read.includes(shown)]).toEqual([shown, false]);
    expect(read).toContain(b);
    for (const denied of [join(root, ".env"), join(b, ".env"), priv]) expect(fs?.denyRead).toContain(denied);
    expect(readAround([root], [a], 4000, [join(root, ".env")])).not.toContain(join(root, ".env"));
    expect(readAround([root], [a], 4000, [join(root, ".env")])).not.toContain(join(home, ".ssh"));
    // A root holding nothing writable is shown whole (a link in it dangles in the CLI's sandbox, checked for real).
    expect(readAround([b], [a])).toEqual([b]);
  });
});

describe("bubblewrap: a hidden path in a dir shown again under the host's /tmp", () => {
  test("is hidden there too (the private /tmp covers only what isn't shown)", () => {
    const kinds: Record<string, PathKind> = { "/tmp/r/a": "dir", "/tmp/r/a-worktrees": "dir", "/tmp/r/a-worktrees/o/.env": "other", "/tmp/elsewhere/.env": "other", "/var/tmp/t": "dir" };
    const args = bwrapArgs(
      {
        sessionId: "s",
        workspace: "/tmp/r/a",
        tempDir: "/var/tmp/t",
        writable: [],
        hidden: ["/tmp/r/a-worktrees/o/.env", "/tmp/elsewhere/.env"],
        reexposed: ["/tmp/r/a-worktrees"],
        containerSockets: [],
        network: { mode: "off" },
        unsetEnv: [],
      },
      "",
      (p) => kinds[p] ?? null,
    ).join(" ");
    expect(args).toContain("--ro-bind /tmp/r/a-worktrees /tmp/r/a-worktrees");
    expect(args).toContain("--ro-bind /dev/null /tmp/r/a-worktrees/o/.env");
    expect(args).not.toContain("/tmp/elsewhere/.env");
  });
});
