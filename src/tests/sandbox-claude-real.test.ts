/**
 * Claude Code's own sandbox with codeoid's policy (#448), for real: the
 * Agent SDK's bundled CLI runs one Bash call against a localhost stand-in for
 * the Messages API (fixtures/claude-sandbox-probe.ts; no model, no vendor).
 * Skipped unless the CLI can sandbox here (Linux with bubblewrap and socat).
 * What the call does is aimed only at files this test planted in its own
 * scratch dir, outside the host's /tmp; nothing runs outside a sandbox but
 * the one call the gate refuses, which therefore never runs.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BwrapSandboxProvider } from "../daemon/sandbox/bwrap.js";

const PROBE = join(import.meta.dir, "fixtures", "claude-sandbox-probe.ts");
const cli = (() => {
  try {
    const dir = join(import.meta.dir, "..", "..", "node_modules", "@anthropic-ai", `claude-agent-sdk-${process.platform}-${process.arch}`, "claude");
    return existsSync(dir) ? dir : null;
  } catch {
    return null;
  }
})();
const bwrap = process.platform === "linux" ? await new BwrapSandboxProvider().probe() : { available: false };
const ready = process.env.CODEOID_TEST_CLAUDE_SANDBOX !== "0" && cli !== null && bwrap.available && Bun.which("socat") !== null;

function scratchParent(): string {
  for (const dir of [process.env.CODEOID_TEST_SANDBOX_DIR, "/var/tmp", join(homedir(), ".cache")]) {
    if (!dir) continue;
    try {
      mkdirSync(dir, { recursive: true });
      rmSync(mkdtempSync(join(dir, "codeoid-probe-")), { recursive: true, force: true });
      return dir;
    } catch {
      /* next */
    }
  }
  return tmpdir();
}

describe.skipIf(!ready)("Claude Code's sandbox with codeoid's policy, for real", () => {
  let root: string;
  let outside: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(scratchParent(), "codeoid-sbx-claude-")));
    outside = join(root, "outside-target");
    for (const d of ["ws", "tmp", "secrets", "home", "outside-target"]) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, "secrets", "id_secret"), "PLANTED-SECRET\n");
    writeFileSync(join(outside, "keep.txt"), "keep\n");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  async function probe(network: string, command: string, extra: string[] = []): Promise<{ result: string; asked: string[]; toolResult: string | null }> {
    const file = join(root, `cmd-${Math.random().toString(36).slice(2)}.txt`);
    writeFileSync(file, command);
    const p = Bun.spawn([process.execPath, PROBE, root, network, file, ...extra], { stdout: "pipe", stderr: "pipe", timeout: 90_000 });
    const out = await new Response(p.stdout).text();
    await p.exited;
    const line = out.trim().split("\n").at(-1) ?? "{}";
    return JSON.parse(line);
  }

  const read = () => `cat ${join(root, "secrets", "id_secret")} 2>&1 || echo READ-FAILED`;

  test("hidden is unreadable, outside the workspace is read-only, the workspace and temp dir are writable, the CLI's key isn't in the command's env", async () => {
    const r = await probe("off", `${read()}; rm -rf ${outside} 2>&1; echo rm-exit=$?; echo hi > ${join(root, "ws", "made.txt")} && echo WROTE-WS; echo t > ${join(root, "tmp", "t.txt")} && echo WROTE-TMP; echo "key=[$ANTHROPIC_API_KEY]"`);
    expect(r.result).toBe("success");
    expect(r.asked).toEqual(["Bash"]);
    expect(r.toolResult).not.toContain("PLANTED-SECRET");
    expect(r.toolResult).toContain("READ-FAILED");
    expect(r.toolResult).toContain("Read-only file system");
    expect(r.toolResult).toContain("rm-exit=1");
    expect(r.toolResult).toContain("WROTE-WS");
    expect(r.toolResult).toContain("WROTE-TMP");
    expect(r.toolResult).toContain("key=[]");
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep\n");
  }, 120_000);

  test("network off: a host is refused by the sandbox's proxy, and the command is told", async () => {
    const r = await probe("off", `curl -s -m 5 -o /dev/null -w "http=%{http_code}" http://example.invalid.codeoid.test 2>&1; echo; echo done`);
    expect(r.toolResult).not.toContain("http=200");
    expect(r.toolResult).toContain("sandbox_violations");
  }, 120_000);

  test("a command asking to run outside the sandbox reaches the gate, and a denial means it never runs", async () => {
    const r = await probe("off", `rm -rf ${outside}; echo RAN`, ["unsandboxed"]);
    expect(r.asked).toEqual(["Bash"]);
    expect(r.toolResult ?? "").not.toContain("RAN");
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
  }, 120_000);
});
