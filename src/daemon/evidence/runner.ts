/**
 * Run one check and capture what it did (docs/loop-engineering-design.md §7).
 *
 * The runner owns the process it starts: the check runs as the leader of its
 * own process group, so a timeout, a cancel, or the check's own exit can kill
 * everything it spawned — a test server left behind by `sh -c` included. Output
 * is kept twice: bounded, redacted excerpts for display and worker feedback,
 * and the full streams as owner-only artifact files (up to a cap) so nothing a
 * reviewer needs is lost.
 *
 * A check gets the same stripped environment as an agent's own subprocesses
 * (providers/env.ts): its command and output can be shaped by the agent being
 * judged, and its output is shown back to that agent, so the daemon's own
 * credentials must never be in reach.
 *
 * Classification is the runner's job, not the caller's: exit 0 is `pass` only
 * when it actually established something (see parsers.ts), a timeout is
 * `fail`, and anything that stopped the check from running is `error`.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, statSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { buildSubprocessEnv } from "../providers/env.js";
import { LineSplitter, ZeroTestScan } from "./parsers";
import { redactOutput } from "./redact";
import type { CheckOutcome, CheckSpec, EvidenceArtifact, EvidenceEnvironment, EvidenceResult } from "./types";

/** Excerpt kept from each end of a stream for display and worker feedback. */
export const EXCERPT_HEAD_BYTES = 4 * 1024;
export const EXCERPT_TAIL_BYTES = 12 * 1024;
/** Default cap on one stream's artifact file. */
export const DEFAULT_MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
/** Between SIGTERM and SIGKILL when the runner stops a check. */
export const DEFAULT_KILL_GRACE_MS = 2_000;
/** How long to wait for output pipes to drain after the check exits, before
 *  giving up on a descendant that escaped the process group and still holds them. */
const DRAIN_WAIT_MS = 2_000;

export interface RunCheckOptions {
  /** Directory the check runs in. */
  cwd: string;
  /** Directory the full output streams are written to (created if missing, 0700). */
  artifactDir: string;
  /** Aborting stops the check and records `cancelled`. */
  signal?: AbortSignal;
  killGraceMs?: number;
  maxArtifactBytes?: number;
}

/** sha256 of a check's definition. Two runs with the same digest ran the same
 *  check; env values are excluded so a rotated secret doesn't look like a new
 *  verifier, and never reaches a stored record. */
export function verifierDigest(spec: CheckSpec): string {
  const def = {
    command: spec.command,
    timeoutMs: spec.timeoutMs,
    envKeys: Object.keys(spec.env ?? {}).sort(),
    expectTests: spec.expectTests === true,
  };
  return createHash("sha256").update(JSON.stringify(def)).digest("hex");
}

function environmentOf(spec: CheckSpec): EvidenceEnvironment {
  return {
    platform: process.platform,
    arch: process.arch,
    runtime: typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.version}`,
    envKeys: Object.keys(spec.env ?? {}).sort(),
  };
}

/**
 * The environment a check runs with: the agent subprocess basics plus the
 * toolchain variables builds and test runners commonly need, and anything the
 * operator lists in CODEOID_CHECK_ENV_ALLOW (comma-separated). Never the
 * daemon's own credentials (CODEOID_ / ZEROID_ / TELEGRAM_ stay denied).
 */
const CHECK_ENV_EXACT = [
  "CI",
  "NODE_ENV",
  "TERM",
  "GOPATH",
  "GOFLAGS",
  "GOPRIVATE",
  "GOPROXY",
  "GOCACHE",
  "GOMODCACHE",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "JAVA_HOME",
  "VIRTUAL_ENV",
  "CONDA_PREFIX",
  "PYTHONPATH",
  "DOCKER_HOST",
];

export function checkEnv(base: Record<string, string | undefined> = process.env): Record<string, string> {
  const extra = (base.CODEOID_CHECK_ENV_ALLOW ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n.length > 0 && !/^(CODEOID_|ZEROID_|TELEGRAM_)/.test(n));
  return buildSubprocessEnv({ exact: [...CHECK_ENV_EXACT, ...extra], prefixes: ["LC_", "XDG_"] }, base);
}

/** Bytes [start, end) of `buf` adjusted inward to whole UTF-8 characters, so a
 *  cut never leaves a replacement character at either edge. */
function utf8Whole(buf: Buffer): Buffer {
  let start = 0;
  while (start < buf.length && start < 4 && (buf[start]! & 0xc0) === 0x80) start++;
  let end = buf.length;
  // Find the last lead byte; drop it if its sequence is incomplete.
  for (let i = end - 1; i >= Math.max(start, end - 4); i--) {
    const b = buf[i]!;
    if ((b & 0xc0) === 0x80) continue;
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    if (end - i < need) end = i;
    break;
  }
  return buf.subarray(start, end);
}

/** One output stream: written to its artifact file up to a cap, hashed, fed
 *  line by line to the zero-test scan, and kept as a head + rolling tail. */
class CapturedStream {
  readonly #name: "stdout" | "stderr";
  readonly #path: string;
  readonly #file: WriteStream;
  readonly #hash = createHash("sha256");
  readonly #max: number;
  readonly #lines: LineSplitter;
  #bytes = 0;
  #written = 0;
  #head: Buffer[] = [];
  #headBytes = 0;
  #tail: Buffer[] = [];
  #tailBytes = 0;
  /** The artifact file failed (disk full, too many open files): stop writing
   *  it, keep building excerpts. An unhandled stream error would take the
   *  whole daemon down. */
  #writeFailed = false;

  constructor(name: "stdout" | "stderr", dir: string, max: number, scan: ZeroTestScan) {
    this.#name = name;
    this.#path = join(dir, `${name}.log`);
    this.#file = createWriteStream(this.#path, { mode: 0o600 });
    this.#file.on("error", () => {
      this.#writeFailed = true;
    });
    this.#max = max;
    this.#lines = new LineSplitter((l) => scan.line(l));
  }

  push(chunk: Buffer): void {
    this.#bytes += chunk.length;
    this.#lines.push(chunk.toString("utf8"));
    if (!this.#writeFailed && this.#written < this.#max) {
      const room = this.#max - this.#written;
      const part = chunk.length <= room ? chunk : chunk.subarray(0, room);
      this.#file.write(part);
      this.#hash.update(part);
      this.#written += part.length;
    }
    let rest = chunk;
    if (this.#headBytes < EXCERPT_HEAD_BYTES) {
      const take = rest.subarray(0, EXCERPT_HEAD_BYTES - this.#headBytes);
      this.#head.push(take);
      this.#headBytes += take.length;
      rest = rest.subarray(take.length);
      if (rest.length === 0) return;
    }
    this.#tail.push(rest);
    this.#tailBytes += rest.length;
    while (this.#tailBytes - (this.#tail[0]?.length ?? 0) >= EXCERPT_TAIL_BYTES) {
      this.#tailBytes -= this.#tail.shift()!.length;
    }
  }

  /** The excerpt, redacted: the head, then — if output was longer — a marker
   *  and the tail. */
  excerpt(): string {
    let tail = Buffer.concat(this.#tail);
    let skipped = this.#bytes - this.#headBytes - tail.length;
    if (tail.length > EXCERPT_TAIL_BYTES) {
      skipped += tail.length - EXCERPT_TAIL_BYTES;
      tail = tail.subarray(tail.length - EXCERPT_TAIL_BYTES);
    }
    const headBuf = Buffer.concat(this.#head);
    // Nothing omitted: one contiguous text, decoded as one so no character is
    // lost at the head/tail seam.
    if (skipped <= 0) return redactOutput(Buffer.concat([headBuf, tail]).toString("utf8"));
    // Cut at line boundaries, so redaction never sees half a token at an edge.
    let head = utf8Whole(headBuf).toString("utf8");
    const headCut = head.lastIndexOf("\n");
    if (headCut > 0) head = head.slice(0, headCut + 1);
    let rest = utf8Whole(tail).toString("utf8");
    const tailCut = rest.indexOf("\n");
    if (tailCut >= 0 && tailCut < rest.length - 1) rest = rest.slice(tailCut + 1);
    const marker = `\n… [${skipped} bytes or more omitted — full output in the ${this.#name} artifact] …\n`;
    return redactOutput(head + marker + rest);
  }

  /** Flush the artifact file and describe it. Resolves even when the file
   *  failed; the artifact then says it is truncated. */
  async close(): Promise<EvidenceArtifact> {
    this.#lines.end();
    if (!this.#writeFailed) {
      await new Promise<void>((res) => {
        this.#file.once("error", () => res());
        this.#file.end(() => res());
      });
    } else {
      this.#file.destroy();
    }
    return {
      name: this.#name,
      path: this.#path,
      sha256: this.#hash.digest("hex"),
      bytes: this.#written,
      truncated: this.#writeFailed || this.#bytes > this.#written,
    };
  }
}

/** Signal the check's whole process group; a group that is already gone is fine. */
function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: every member already exited.
  }
}

/**
 * Run `spec` in `opts.cwd` and classify the result. Never throws for a check
 * that failed to run — that is `error` evidence — so a caller always gets a
 * record to store.
 */
export async function runCheck(spec: CheckSpec, opts: RunCheckOptions): Promise<CheckOutcome> {
  const startedAt = Date.now();
  const base = {
    criterionId: spec.id,
    verifierDigest: verifierDigest(spec),
    environment: environmentOf(spec),
    isolation: "process" as const,
    command: spec.command,
  };
  const finish = (
    fields: Pick<CheckOutcome, "result" | "reason" | "exitCode" | "signal" | "timedOut"> &
      Partial<Pick<CheckOutcome, "stdoutExcerpt" | "stderrExcerpt" | "artifacts">>,
  ): CheckOutcome => ({
    ...base,
    stdoutExcerpt: "",
    stderrExcerpt: "",
    artifacts: [],
    startedAt,
    endedAt: Date.now(),
    ...fields,
  });
  const notRun = (result: EvidenceResult, reason: string): CheckOutcome =>
    finish({ result, reason, exitCode: null, signal: null, timedOut: false });

  if (opts.signal?.aborted) return notRun("cancelled", "cancelled before it started");
  if (!existsSync(opts.cwd) || !statSync(opts.cwd).isDirectory()) {
    return notRun("error", `the working directory does not exist: ${opts.cwd}`);
  }
  try {
    mkdirSync(opts.artifactDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    return notRun("error", `could not create the artifact directory: ${errText(err)}`);
  }

  const max = opts.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  const scan = new ZeroTestScan();
  const out = new CapturedStream("stdout", opts.artifactDir, max, scan);
  const err = new CapturedStream("stderr", opts.artifactDir, max, scan);
  const grace = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  const child = spawn("sh", ["-c", spec.command], {
    cwd: opts.cwd,
    env: { ...checkEnv(), ...(spec.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so killGroup reaches everything it spawns.
    detached: true,
  });
  child.stdout?.on("data", (c: Buffer) => out.push(c));
  child.stderr?.on("data", (c: Buffer) => err.push(c));
  // Listened for from the start: `close` can fire in the same tick as `exit`.
  const closed = new Promise<void>((res) => child.once("close", () => res()));

  let stoppedBy: "timeout" | "cancel" | null = null;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (why: "timeout" | "cancel"): void => {
    if (stoppedBy || child.pid === undefined) return;
    stoppedBy = why;
    const pid = child.pid;
    killGroup(pid, "SIGTERM");
    killTimer = setTimeout(() => killGroup(pid, "SIGKILL"), grace);
  };
  const timer = setTimeout(() => stop("timeout"), spec.timeoutMs);
  const onAbort = (): void => stop("cancel");
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError?: Error }>(
    (res) => {
      child.once("error", (e) => res({ code: null, signal: null, spawnError: e }));
      child.once("exit", (code, signal) => res({ code, signal }));
    },
  );
  clearTimeout(timer);
  opts.signal?.removeEventListener("abort", onAbort);

  // The check is over; anything it left running in its group goes too. The
  // group id is still held by those stragglers, so this cannot reach another
  // process group. The delayed SIGKILL is no longer needed — and once every
  // member is gone the id may be reused, so it must not fire.
  if (child.pid !== undefined) killGroup(child.pid, "SIGKILL");
  clearTimeout(killTimer);
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const drained = new Promise<void>((res) => {
    drainTimer = setTimeout(res, DRAIN_WAIT_MS);
  });
  await Promise.race([closed, drained]);
  clearTimeout(drainTimer);
  child.stdout?.destroy();
  child.stderr?.destroy();

  const artifacts = [await out.close(), await err.close()];
  const captured = { stdoutExcerpt: out.excerpt(), stderrExcerpt: err.excerpt(), artifacts };
  const signal = exit.signal ?? null;

  if (exit.spawnError) {
    return finish({
      result: "error",
      reason: `could not start the check: ${exit.spawnError.message}`,
      exitCode: null,
      signal: null,
      timedOut: false,
      ...captured,
    });
  }
  if (stoppedBy === "cancel") {
    return finish({ result: "cancelled", reason: "cancelled while running", exitCode: exit.code, signal, timedOut: false, ...captured });
  }
  if (stoppedBy === "timeout") {
    return finish({
      result: "fail",
      reason: `did not finish within ${spec.timeoutMs}ms and was stopped`,
      exitCode: exit.code,
      signal,
      timedOut: true,
      ...captured,
    });
  }
  return finish({ ...classifyExit(spec, exit.code, signal, scan.result()), ...captured });
}

function classifyExit(
  spec: CheckSpec,
  code: number | null,
  signal: NodeJS.Signals | null,
  zeroTestsRunner: string | null,
): Pick<CheckOutcome, "result" | "reason" | "exitCode" | "signal" | "timedOut"> {
  const at = { exitCode: code, signal, timedOut: false };
  const result = (r: EvidenceResult, reason: string) => ({ result: r, reason, ...at });
  if (signal) return result("fail", `was killed by ${signal}`);
  if (code === 126 || code === 127) {
    return result("error", code === 127 ? "command not found (exit 127)" : "command not executable (exit 126)");
  }
  if (code !== 0) return result("fail", `exited with code ${code}`);
  if (spec.expectTests && zeroTestsRunner) {
    return result("inconclusive", `exited 0 but ran no tests (${zeroTestsRunner} reported an empty selection)`);
  }
  return result("pass", "exited 0");
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
