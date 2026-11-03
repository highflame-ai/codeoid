/**
 * opencode's shell shim (#448): the program opencode's shared server runs
 * every line with. A session's line runs through the launcher its shell
 * environment names (inside its sandbox), or bash when its sandbox is off;
 * anything else runs nothing. Run here with harmless lines only.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencodeShellShim, SANDBOX_LAUNCHER_VAR, writeOpencodeShellShim } from "../daemon/providers/opencode/policy.js";

const BASH = Bun.which("bash") ?? "/bin/bash";
let root: string;
let shim: string;
let launcherRoot: string;
let launcher: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "codeoid-shim-"));
  launcherRoot = join(root, "codeoid-launch-");
  shim = writeOpencodeShellShim(join(root, "bin"), BASH, launcherRoot);
  const dir = `${launcherRoot}sess-abc`;
  mkdirSync(dir, { recursive: true });
  launcher = join(dir, "launch-1");
  // A stand-in launcher: says it ran, then runs what it was handed.
  writeFileSync(launcher, `#!/bin/sh\necho "LAUNCHER:$1"\nexec "$@"\n`, { mode: 0o700 });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function run(env: Record<string, string>, line: string) {
  const r = Bun.spawnSync([shim, "-c", line], { env: { PATH: "/usr/bin:/bin", ...env } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("opencode's shell shim", () => {
  test("a session whose sandbox is off: bash runs the line", () => {
    const r = run({ [SANDBOX_LAUNCHER_VAR]: "off" }, 'echo "bash=${BASH_VERSION:+yes}"');
    expect(r).toMatchObject({ code: 0, out: "bash=yes\n" });
  });

  test("a sandboxed session: its launcher runs bash with the line", () => {
    const r = run({ [SANDBOX_LAUNCHER_VAR]: launcher }, "echo inside");
    expect(r.code).toBe(0);
    expect(r.out).toBe(`LAUNCHER:${BASH}\ninside\n`);
  });

  test("no launcher named (the server's own environment), a path that isn't a codeoid launcher, `..`, a missing file: nothing runs", () => {
    const outsideLauncher = join(root, "elsewhere");
    writeFileSync(outsideLauncher, "#!/bin/sh\necho RAN\n", { mode: 0o700 });
    for (const value of [undefined, "", outsideLauncher, `${launcherRoot}sess-abc/../../elsewhere`, `${launcherRoot}sess-abc/launch-9`, "OFF", " off"]) {
      const r = run(value === undefined ? {} : { [SANDBOX_LAUNCHER_VAR]: value }, "echo RAN");
      expect([value, r.code, r.out]).toEqual([value, 126, ""]);
      expect(r.err).toContain("no sandbox to run in");
    }
  });

  test("the script quotes its paths", () => {
    const text = opencodeShellShim("/opt/it's/bash", "/tmp/a b/codeoid-launch-");
    expect(text).toContain(`exec '/opt/it'\\''s/bash' "$@"`);
    expect(text).toContain(`'/tmp/a b/codeoid-launch-'*/launch-*)`);
  });
});
