import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectZeroTests } from "./parsers";
import { EXCERPT_HEAD_BYTES, EXCERPT_TAIL_BYTES, checkEnv, runCheck, verifierDigest } from "./runner";
import type { CheckSpec } from "./types";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeoid-evidence-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const spec = (command: string, extra: Partial<CheckSpec> = {}): CheckSpec => ({
  id: "c1",
  command,
  timeoutMs: 10_000,
  ...extra,
});
const run = (s: CheckSpec, signal?: AbortSignal) =>
  runCheck(s, { cwd: dir, artifactDir: join(dir, "art"), signal, killGraceMs: 200 });

describe("classification", () => {
  test("exit 0 is a pass; non-zero is a fail with the code", async () => {
    expect((await run(spec("true"))).result).toBe("pass");
    const failed = await run(spec("exit 3"));
    expect(failed.result).toBe("fail");
    expect(failed.exitCode).toBe(3);
  });

  test("a missing command is an error, not a fail and never a pass", async () => {
    const out = await run(spec("definitely-not-a-binary-xyz"));
    expect(out.result).toBe("error");
    expect(out.reason).toContain("not found");
  });

  test("a directory that does not exist is an error", async () => {
    const out = await runCheck(spec("true"), { cwd: join(dir, "missing"), artifactDir: join(dir, "art") });
    expect(out.result).toBe("error");
  });

  test("a test run that selected no tests is inconclusive", async () => {
    const out = await run(spec("echo 'Ran 0 tests across 0 files.'", { expectTests: true }));
    expect(out.result).toBe("inconclusive");
  });

  test("the same output from a non-test check is a pass", async () => {
    expect((await run(spec("echo 'Ran 0 tests across 0 files.'"))).result).toBe("pass");
  });

  test("a check killed by a signal is a fail naming it", async () => {
    const out = await run(spec("kill -TERM $$"));
    expect(out.result).toBe("fail");
    expect(out.signal).toBe("SIGTERM");
  });
});

describe("process ownership", () => {
  test("a timeout kills the whole group and records a timed-out fail", async () => {
    const marker = join(dir, "child-alive");
    // The child would create the marker after 2s if it survived the kill.
    const out = await run(spec(`(sleep 2; touch ${marker}) & sleep 30`, { timeoutMs: 300 }));
    expect(out.result).toBe("fail");
    expect(out.timedOut).toBe(true);
    await Bun.sleep(2_500);
    expect(existsSync(marker)).toBe(false);
  });

  test("a descendant left running after the check exits is killed", async () => {
    const marker = join(dir, "orphan-alive");
    const out = await run(spec(`(sleep 1; touch ${marker}) & exit 0`));
    expect(out.result).toBe("pass");
    await Bun.sleep(1_500);
    expect(existsSync(marker)).toBe(false);
  });

  test("cancelling stops the check and records cancelled", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const out = await run(spec("sleep 30"), ac.signal);
    expect(out.result).toBe("cancelled");
  });

  test("an already-cancelled signal never starts the check", async () => {
    const ac = new AbortController();
    ac.abort();
    const marker = join(dir, "ran");
    const out = await run(spec(`touch ${marker}`), ac.signal);
    expect(out.result).toBe("cancelled");
    expect(existsSync(marker)).toBe(false);
  });
});

describe("output", () => {
  test("excerpts keep the head and tail; the artifact keeps everything", async () => {
    const out = await run(spec("i=0; while [ $i -lt 4000 ]; do echo line-$i; i=$((i+1)); done"));
    expect(out.stdoutExcerpt.startsWith("line-0\n")).toBe(true);
    expect(out.stdoutExcerpt).toContain("line-3999");
    expect(out.stdoutExcerpt).toContain("omitted — full output in the stdout artifact");
    expect(out.stdoutExcerpt.length).toBeLessThan(EXCERPT_HEAD_BYTES + EXCERPT_TAIL_BYTES + 200);
    const stdout = out.artifacts.find((a) => a.name === "stdout")!;
    const full = readFileSync(stdout.path, "utf8");
    expect(full.split("\n").filter(Boolean)).toHaveLength(4000);
    expect(stdout.bytes).toBe(Buffer.byteLength(full));
    expect(stdout.truncated).toBe(false);
  });

  test("an artifact over its cap is truncated and says so", async () => {
    const out = await runCheck(spec("head -c 5000 /dev/zero"), {
      cwd: dir,
      artifactDir: join(dir, "art"),
      maxArtifactBytes: 1000,
    });
    const stdout = out.artifacts.find((a) => a.name === "stdout")!;
    expect(stdout.bytes).toBe(1000);
    expect(stdout.truncated).toBe(true);
  });

  test("stderr is captured separately", async () => {
    const out = await run(spec("echo out; echo err >&2; exit 1"));
    expect(out.stdoutExcerpt.trim()).toBe("out");
    expect(out.stderrExcerpt.trim()).toBe("err");
  });
});

describe("verifier digest", () => {
  test("pins the definition but not env values", () => {
    const a = verifierDigest(spec("bun test", { env: { TOKEN: "one" } }));
    const b = verifierDigest(spec("bun test", { env: { TOKEN: "two" } }));
    const c = verifierDigest(spec("bun test --bail", { env: { TOKEN: "one" } }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  test("env values never reach the outcome", async () => {
    const out = await run(spec("true", { env: { SECRET_TOKEN: "hunter2" } }));
    expect(JSON.stringify(out)).not.toContain("hunter2");
    expect(out.environment.envKeys).toEqual(["SECRET_TOKEN"]);
  });
});

describe("detectZeroTests", () => {
  test.each([
    ["bun", "Ran 0 tests across 0 files. [5.00ms]"],
    ["jest", "No tests found, exiting with code 0"],
    ["vitest", "No test files found, exiting with code 0"],
    ["pytest", "============ no tests ran in 0.01s ============"],
    ["go", "?   \texample.com/pkg\t[no test files]\n?   \texample.com/b\t[no test files]"],
    ["cargo", "running 0 tests\n\ntest result: ok. 0 passed\nrunning 0 tests"],
    ["node", "# tests 0\n# pass 0"],
    ["mocha", "  0 passing (2ms)"],
  ])("%s empty selection", (runner, output) => {
    expect(detectZeroTests(output)).toBe(runner);
  });

  test.each([
    ["bun", "Ran 12 tests across 3 files."],
    ["go", "?   \tpkg/a\t[no test files]\nok  \tpkg/b\t0.01s"],
    ["cargo", "running 0 tests\nrunning 4 tests"],
    ["mocha", "  10 passing (2ms)"],
    ["unknown runner", "all good"],
  ])("%s with tests run is not flagged", (_name, output) => {
    expect(detectZeroTests(output)).toBeNull();
  });
});

describe("audit round 1", () => {
  test("a check never sees the daemon's own credentials", async () => {
    process.env.CODEOID_TEST_ROOT_KEY = "zid_sk_should_not_leak";
    try {
      const out = await run(spec("env"));
      expect(out.stdoutExcerpt).not.toContain("zid_sk_should_not_leak");
      expect(out.stdoutExcerpt).toContain("PATH=");
    } finally {
      delete process.env.CODEOID_TEST_ROOT_KEY;
    }
  });

  test("excerpts are redacted; the private artifact keeps the raw bytes", async () => {
    const out = await run(spec("echo 'Authorization: Bearer abc.def-ghi'; echo 'token=s3cr3t-value'"));
    expect(out.stdoutExcerpt).not.toContain("abc.def-ghi");
    expect(out.stdoutExcerpt).not.toContain("s3cr3t-value");
    const raw = readFileSync(out.artifacts.find((a) => a.name === "stdout")!.path, "utf8");
    expect(raw).toContain("s3cr3t-value");
  });

  test("artifacts are readable only by the daemon's user", async () => {
    const out = await run(spec("echo hi"));
    const file = out.artifacts[0]!.path;
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "art")).mode & 0o777).toBe(0o700);
  });

  test("zero-test detection sees the whole stream, not just the excerpt", async () => {
    // 40 empty test binaries, real tests in the omitted middle, empty doc-tests.
    const cmd = [
      "i=0; while [ $i -lt 400 ]; do echo 'running 0 tests'; echo; i=$((i+1)); done",
      "echo 'running 2000 tests'",
      "i=0; while [ $i -lt 3000 ]; do echo \"test t$i ... ok\"; i=$((i+1)); done",
      "echo 'running 0 tests'",
    ].join("; ");
    const out = await run(spec(cmd, { expectTests: true }));
    expect(out.result).toBe("pass");
  });

  test("an excerpt cut never splits a UTF-8 character", async () => {
    // 4095 ASCII bytes then a 3-byte character straddling the 4 KiB head cut.
    const out = await run(spec("printf '%4095s' '' | tr ' ' a; printf '€'; i=0; while [ $i -lt 2000 ]; do echo line$i; i=$((i+1)); done"));
    expect(out.stdoutExcerpt).not.toContain("\uFFFD");
  });

  test("a missing working directory is named as such", async () => {
    const out = await runCheck(spec("true"), { cwd: join(dir, "nope"), artifactDir: join(dir, "art") });
    expect(out.result).toBe("error");
    expect(out.reason).toContain("working directory does not exist");
  });
});

describe("audit round 2", () => {
  test("an artifact file that cannot be written does not crash, and says it is truncated", async () => {
    const art = join(dir, "art");
    mkdirSync(join(art, "stdout.log"), { recursive: true });
    const out = await runCheck(spec("echo still-classified; exit 3"), { cwd: dir, artifactDir: art });
    expect(out.result).toBe("fail");
    expect(out.stdoutExcerpt).toContain("still-classified");
    expect(out.artifacts.find((a) => a.name === "stdout")!.truncated).toBe(true);
  });

  test("checks keep the toolchain variables builds need, never the daemon's", () => {
    const env = checkEnv({
      PATH: "/bin",
      LC_ALL: "C.UTF-8",
      CI: "1",
      GOPATH: "/go",
      CODEOID_API_KEY: "zid_sk_x",
      CODEOID_CHECK_ENV_ALLOW: "MY_FLAG,CODEOID_API_KEY",
      MY_FLAG: "on",
      RANDOM_SECRET: "nope",
    });
    expect(env.LC_ALL).toBe("C.UTF-8");
    expect(env.CI).toBe("1");
    expect(env.GOPATH).toBe("/go");
    expect(env.MY_FLAG).toBe("on");
    expect(env.CODEOID_API_KEY).toBeUndefined();
    expect(env.RANDOM_SECRET).toBeUndefined();
  });

  test("output between the excerpt sizes loses no character at the seam", async () => {
    const out = await run(spec("printf '%4095s' '' | tr ' ' a; printf 'é'; printf '%2000s' '' | tr ' ' b"));
    expect(out.stdoutExcerpt).toContain("aé");
  });
});
