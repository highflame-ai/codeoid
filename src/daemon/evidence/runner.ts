/**
 * Run one check and capture what it did (docs/loop-engineering-design.md §7).
 *
 * The runner owns the process it starts: the check runs as the leader of its
 * own process group, so a timeout, a cancel, or the check's own exit can kill
 * everything it spawned — a test server left behind by `sh -c` included. Output
 * is kept twice: bounded excerpts for display and worker feedback, and the full
 * streams as artifact files (up to a cap) so nothing a reviewer needs is lost.
 *
 * Classification is the runner's job, not the caller's: exit 0 is `pass` only
 * when it actually established something (see parsers.ts), a timeout is
 * `fail`, and anything that stopped the check from running is `error`.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { detectZeroTests } from "./parsers";
import type { CheckOutcome, CheckSpec, EvidenceArtifact, EvidenceEnvironment, EvidenceResult } from "./types";

/** Excerpt kept from each end of a stream for display and worker feedback. */
export const EXCERPT_HEAD_BYTES = 4 * 1024;
export const EXCERPT_TAIL_BYTES = 12 * 1024;
/** Default cap on one stream's artifact file. */
export const DEFAULT_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
/** Between SIGTERM and SIGKILL when the runner stops a check. */
export const DEFAULT_KILL_GRACE_MS = 2_000;
/** How long to wait for output pipes to drain after the check exits, before
 *  giving up on a descendant that escaped the process group and still holds them. */
const DRAIN_WAIT_MS = 2_000;

export interface RunCheckOptions {
  /** Directory the check runs in. */
  cwd: string;
  /** Directory the full output streams are written to (created if missing). */
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

/** One output stream: written to its artifact file up to a cap, hashed, and
 *  kept as a head + rolling tail for the excerpt. */
class CapturedStream {
  readonly #name: "stdout" | "stderr";
  readonly #path: string;
  readonly #file: WriteStream;
  readonly #hash = createHash("sha256");
  readonly #max: number;
  #bytes = 0;
  #written = 0;
  #head: Buffer[] = [];
  #headBytes = 0;
  #tail: Buffer[] = [];
  #tailBytes = 0;

  constructor(name: "stdout" | "stderr", dir: string, max: number) {
    this.#name = name;
    this.#path = join(dir, `${name}.log`);
    this.#file = createWriteStream(this.#path);
    this.#max = max;
  }

  push(chunk: Buffer): void {
    this.#bytes += chunk.length;
    if (this.#written < this.#max) {
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

  /** The excerpt: the head, then — if output was longer — a marker and the tail. */
  excerpt(): string {
    const head = Buffer.concat(this.#head).toString("utf8");
    if (this.#tailBytes === 0) return head;
    let tail = Buffer.concat(this.#tail);
    let skipped = this.#bytes - this.#headBytes - tail.length;
    if (tail.length > EXCERPT_TAIL_BYTES) {
      skipped += tail.length - EXCERPT_TAIL_BYTES;
      tail = tail.subarray(tail.length - EXCERPT_TAIL_BYTES);
    }
    const marker = skipped > 0 ? `\n… [${skipped} bytes omitted — full output in the ${this.#name} artifact] …\n` : "";
    return head + marker + tail.toString("utf8");
  }

  /** Flush the artifact file and describe it. */
  async close(): Promise<EvidenceArtifact> {
    await new Promise<void>((res) => this.#file.end(res));
    return {
      name: this.#name,
      path: this.#path,
      sha256: this.#hash.digest("hex"),
      bytes: this.#written,
      truncated: this.#bytes > this.#written,
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

  if (opts.signal?.aborted) {
    return finish({ result: "cancelled", reason: "cancelled before it started", exitCode: null, signal: null, timedOut: false });
  }

  try {
    mkdirSync(opts.artifactDir, { recursive: true });
  } catch (err) {
    return finish({
      result: "error",
      reason: `could not create the artifact directory: ${errText(err)}`,
      exitCode: null,
      signal: null,
      timedOut: false,
    });
  }

  const max = opts.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  const out = new CapturedStream("stdout", opts.artifactDir, max);
  const err = new CapturedStream("stderr", opts.artifactDir, max);
  const grace = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  const child = spawn("sh", ["-c", spec.command], {
    cwd: opts.cwd,
    env: { ...process.env, ...(spec.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so killGroup reaches everything it spawns.
    detached: true,
  });
  child.stdout?.on("data", (c: Buffer) => out.push(c));
  child.stderr?.on("data", (c: Buffer) => err.push(c));
  // Listened for from the start: `close` can fire in the same tick as `exit`.
  const closed = new Promise<void>((res) => child.once("close", () => res()));

  let stoppedBy: "timeout" | "cancel" | null = null;
  const stop = (why: "timeout" | "cancel"): void => {
    if (stoppedBy || child.pid === undefined) return;
    stoppedBy = why;
    killGroup(child.pid, "SIGTERM");
    setTimeout(() => killGroup(child.pid!, "SIGKILL"), grace).unref();
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

  // The check is over; anything it left running in its group goes too.
  if (child.pid !== undefined) killGroup(child.pid, "SIGKILL");
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const drained = new Promise<void>((res) => {
    drainTimer = setTimeout(res, DRAIN_WAIT_MS);
  });
  await Promise.race([closed, drained]);
  clearTimeout(drainTimer);
  child.stdout?.destroy();
  child.stderr?.destroy();

  const artifacts = [await out.close(), await err.close()];
  const stdoutExcerpt = out.excerpt();
  const stderrExcerpt = err.excerpt();
  const captured = { stdoutExcerpt, stderrExcerpt, artifacts };
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
  return finish({ ...classifyExit(spec, exit.code, signal, `${stdoutExcerpt}\n${stderrExcerpt}`), ...captured });
}

function classifyExit(
  spec: CheckSpec,
  code: number | null,
  signal: NodeJS.Signals | null,
  output: string,
): Pick<CheckOutcome, "result" | "reason" | "exitCode" | "signal" | "timedOut"> {
  const at = { exitCode: code, signal, timedOut: false };
  const result = (r: EvidenceResult, reason: string) => ({ result: r, reason, ...at });
  if (signal) return result("fail", `was killed by ${signal}`);
  if (code === 126 || code === 127) {
    return result("error", code === 127 ? "command not found (exit 127)" : "command not executable (exit 126)");
  }
  if (code !== 0) return result("fail", `exited with code ${code}`);
  if (spec.expectTests) {
    const runner = detectZeroTests(output);
    if (runner) return result("inconclusive", `exited 0 but ran no tests (${runner} reported an empty selection)`);
  }
  return result("pass", "exited 0");
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
