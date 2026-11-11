/**
 * The workstream fence in the sandbox spec (workstreams §7.3): another
 * workstream's folder under a shown root is hidden, and a root inside one
 * isn't shown, even when the session's own setting names it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildSandboxSpec } from "../daemon/sandbox/policy.js";

let base: string;
beforeEach(() => {
  const parent = process.env.CODEOID_TEST_SANDBOX_DIR ?? join(homedir(), ".cache");
  mkdirSync(parent, { recursive: true });
  base = realpathSync(mkdtempSync(join(parent, "codeoid-ws-fence-")));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("extraHidden", () => {
  test("another workstream's folder under a shown root is hidden; a root inside one is dropped", () => {
    const home = join(base, "home");
    const root = join(home, "Workspace");
    const mine = join(root, "mine");
    const theirs = join(root, "theirs");
    const inside = join(theirs, "pkg");
    for (const d of [mine, inside]) mkdirSync(d, { recursive: true });
    const tmp = join(base, "tmp");
    mkdirSync(tmp);
    const spec = buildSandboxSpec({
      sessionId: "s",
      workspace: mine,
      tempDir: tmp,
      network: { mode: "off" },
      hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" },
      projectRoots: [root, inside],
      extraHidden: [theirs],
    });
    expect(spec.hidden).toContain(theirs);
    expect(spec.reexposed).toContain(root);
    expect(spec.reexposed).not.toContain(inside);
    // Without the fence, as before.
    const open = buildSandboxSpec({
      sessionId: "s",
      workspace: mine,
      tempDir: tmp,
      network: { mode: "off" },
      hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" },
      projectRoots: [root, inside],
    });
    expect(open.hidden).not.toContain(theirs);
    expect(open.reexposed).toContain(inside);
  });

  test("an added dir inside another workstream's folder isn't kept: adding it can't open the fence", () => {
    const home = join(base, "home");
    const mine = join(home, "mine");
    const theirs = join(home, "theirs");
    for (const d of [mine, join(theirs, "sub")]) mkdirSync(d, { recursive: true });
    const tmp = join(base, "tmp");
    mkdirSync(tmp);
    const spec = buildSandboxSpec({
      sessionId: "s",
      workspace: mine,
      tempDir: tmp,
      network: { mode: "off" },
      hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" },
      addedDirs: [{ dir: join(theirs, "sub") }],
      extraHidden: [theirs],
    });
    expect(spec.addedDirs ?? []).not.toContain(join(theirs, "sub"));
    expect(spec.writable).not.toContain(join(theirs, "sub"));
  });
});
