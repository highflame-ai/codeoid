/**
 * What a spec holds in place and pins (#448 round 14): every path it binds by
 * name (its writable dirs, its temp dir, the paths it holds read-only, the
 * dirs it holds in place) is pinned, the working directory by its identity;
 * the working directory and every dir up to the workspace are held in place.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bwrapArgs } from "../daemon/sandbox/bwrap.js";
import { claudeSandboxSettings } from "../daemon/sandbox/claude-native.js";
import { dockerRunArgs } from "../daemon/sandbox/docker.js";
import { buildSandboxSpec } from "../daemon/sandbox/policy.js";
import { seatbeltProfile } from "../daemon/sandbox/seatbelt.js";

const made: string[] = [];
function scratch(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-pinned-")));
  made.push(d);
  return d;
}
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe("every path a spec binds is pinned; the working directory and its way up held in place (#448 round 14)", () => {
  test("the spec pins its writable dirs, its temp dir, the paths it holds read-only and the dirs it holds in place; the working directory by identity", () => {
    const d = scratch();
    const home = join(d, "home");
    const top = join(home, "W", "mono");
    const pkg = join(top, "packages", "app");
    mkdirSync(pkg, { recursive: true });
    Bun.spawnSync(["git", "init", "-q"], { cwd: top });
    const tmp = join(d, "tmp");
    mkdirSync(tmp);
    const spec = buildSandboxSpec({ sessionId: "s", workspace: top, workdir: pkg, tempDir: tmp, network: { mode: "off" }, hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" }, cache: false });
    const byPath = new Map((spec.pins ?? []).map((p) => [p.path, p]));
    expect(byPath.get(pkg)).toMatchObject({ what: "the working directory", id: expect.stringMatching(/^\d+:\d+$/) });
    expect(byPath.get(tmp)?.what).toBe("the session's temp dir");
    expect(byPath.get(join(top, ".git"))?.what).toBe("a writable directory of the session's");
    expect(byPath.get(join(top, ".git", "config"))).toMatchObject({ what: "a path held read-only", file: true });
    expect(byPath.get(join(pkg, ".claude"))).toMatchObject({ what: "a path held read-only", id: expect.any(String) });
    expect(byPath.get(join(top, "packages"))?.what).toBe("a directory held in place");
    expect(spec.heldInPlace).toEqual(expect.arrayContaining([pkg, join(top, "packages")]));
    // Every path a provider binds by name (but the hidden list, the home's allowlist, sockets) is one of them.
    for (const p of [spec.workspace, spec.tempDir, ...spec.writable, ...(spec.readOnly ?? []), ...(spec.pinned ?? []), ...(spec.heldInPlace ?? [])]) expect(byPath.has(p)).toBe(true);
  });

  test("every provider holds them in place: bubblewrap and Docker bind each at its own path (writable), Seatbelt denies writing the dir itself; Claude's sandbox doesn't deny them (its CLI binds them)", () => {
    const d = scratch();
    const home = join(d, "home");
    const top = join(home, "W", "mono");
    const pkg = join(top, "packages", "app");
    mkdirSync(pkg, { recursive: true });
    Bun.spawnSync(["git", "init", "-q"], { cwd: top });
    const tmp = join(d, "tmp");
    mkdirSync(tmp);
    const spec = buildSandboxSpec({ sessionId: "s", workspace: top, workdir: pkg, tempDir: tmp, network: { mode: "off" }, hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" }, cache: false });
    const held = [pkg, join(top, "packages")];
    expect(spec.heldInPlace).toEqual(expect.arrayContaining(held));
    const bw = bwrapArgs(spec, pkg).join(" ");
    for (const h of held) expect(bw).toContain(`--bind ${h} ${h}`);
    const docker = dockerRunArgs(spec, ["true"], { image: "x", cwd: pkg, envNames: [], uid: 1, gid: 1 }).join(" ");
    for (const h of held) expect(docker).toContain(`source=${h},target=${h}`);
    const sb = seatbeltProfile(spec, { isDir: () => true });
    const names = Object.entries(sb.params);
    for (const h of held) {
      const name = names.find(([, v]) => v === h)?.[0];
      expect(name).toBeDefined();
      expect(sb.profile).toContain(`(deny file-write* (literal (param "${name}")))`);
    }
    const native = claudeSandboxSettings({ spec, config: { bwrapPath: undefined } } as never, { HOME: home });
    for (const h of held) expect(native.filesystem?.denyWrite).not.toContain(h);
  });
});
