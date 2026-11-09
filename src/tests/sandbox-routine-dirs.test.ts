/**
 * A routine's added directories are checked and kept by their real path when
 * it is defined (#448 round 13), as a session's are when it is created:
 * `~/…` and a link-named dir work at every run instead of being dropped, and
 * one that can't be added refuses the routine up front.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { AUTH, CLIENT, git, sandboxManagerHarness } from "./fixtures/sandbox-manager-harness.js";

const t = sandboxManagerHarness();

describe("a routine's added directories are checked and kept by their real path when it is defined (#448 round 13)", () => {
  it("`~/…` and a link-named dir are kept by their real path; one that can't be added is refused at once", async () => {
    const m = t.newManager();
    const home = process.env.HOME as string;
    const inHome = join(home, "Workspace", "b");
    mkdirSync(inHome, { recursive: true });
    git(["init", "-q"], inHome);
    symlinkSync(join(home, "Workspace"), join(home, "ws"));
    const spec = (addedDirs: string[]) => ({ name: `r-${Math.random().toString(36).slice(2, 7)}`, prompt: "p", workdir: t.workdir, every: "1h", sandbox: { addedDirs } });
    const ok = await m.handle({ type: "routine.create", id: "r", spec: spec(["~/Workspace/b", join(home, "ws", "b")]) } as never, AUTH, CLIENT);
    expect(ok.type).toBe("routine.snapshot");
    const kept = (ok as unknown as { routine?: { spec?: { sandbox?: { addedDirs?: string[] } } } }).routine?.spec?.sandbox?.addedDirs;
    expect(kept).toEqual([inHome]);
    const bad = await m.handle({ type: "routine.create", id: "r", spec: spec([join(t.sibling, ".claude")]) } as never, AUTH, CLIENT);
    expect(bad.type).toBe("response.error");
    expect(JSON.stringify(bad)).toContain(".claude");
  });
});
