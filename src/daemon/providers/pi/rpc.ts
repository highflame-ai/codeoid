/**
 * PiRpcProcess — a `pi --mode rpc` subprocess speaking strict JSONL.
 *
 * pi's RPC protocol (packages/coding-agent/docs/rpc.md in pi-mono):
 *   - commands go to stdin, one JSON object per LF-terminated line
 *   - responses (`type: "response"`, correlated by `id`) and events stream
 *     from stdout as JSON lines
 *   - framing is LF-ONLY by contract; a trailing `\r` is tolerated on input
 *
 * This wrapper owns the subprocess + framing + request correlation and
 * nothing else — protocol semantics live in the provider.
 */

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** A parsed stdout frame — response or event; shape is provider-interpreted. */
export type PiFrame = Record<string, unknown> & { type: string };

export interface PiSpawnOptions {
  /** Binary or wrapper script (config `providers.pi.command`). */
  command: string;
  /**
   * argv entries placed BEFORE `--mode rpc` — the bundled fallback spawns
   * the runtime with pi's cli entry as the first arg (see pi/resolve.ts).
   */
  argsPrefix?: string[];
  /** Extra CLI args (mode/rpc is always appended by this wrapper). */
  args?: string[];
  cwd: string;
  /**
   * Subprocess environment — callers pass an allowlisted build (see
   * `buildPiEnv`), never a blanket `process.env` (GHSA-38vh vector 3: the
   * daemon's env carries codeoid's own secrets).
   */
  env: Record<string, string>;
  /** Called for every non-response frame (events, extension_ui_request). */
  onEvent: (frame: PiFrame) => void;
  /** Called once when the process exits (code/signal for diagnostics). */
  onExit: (info: { code: number | null; signal: string | null; stderrTail: string }) => void;
}

const REQUEST_TIMEOUT_MS = 30_000;
/** Keep the last N stderr bytes for exit diagnostics. */
const STDERR_TAIL_BYTES = 4_096;

export class PiRpcProcess {
  #proc: ChildProcessWithoutNullStreams;
  #stdoutBuf = "";
  #stderrTail = "";
  #pending = new Map<
    string,
    { resolve: (frame: PiFrame) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  #onEvent: (frame: PiFrame) => void;
  #exited = false;

  constructor(opts: PiSpawnOptions) {
    this.#onEvent = opts.onEvent;
    this.#proc = spawn(opts.command, [...(opts.argsPrefix ?? []), "--mode", "rpc", ...(opts.args ?? [])], {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: opts.env,
    });

    this.#proc.stdout.setEncoding("utf8");
    this.#proc.stdout.on("data", (chunk: string) => this.#onStdout(chunk));
    this.#proc.stderr.setEncoding("utf8");
    this.#proc.stderr.on("data", (chunk: string) => {
      this.#stderrTail = (this.#stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    this.#proc.on("exit", (code, signal) => {
      this.#exited = true;
      const err = new Error(
        `pi exited (code=${code ?? "?"} signal=${signal ?? "?"})${
          this.#stderrTail ? `: ${this.#stderrTail.trim().slice(-500)}` : ""
        }`,
      );
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(err);
      }
      this.#pending.clear();
      opts.onExit({ code, signal, stderrTail: this.#stderrTail });
    });
    this.#proc.on("error", (err) => {
      // Spawn failure (ENOENT: pi not installed) surfaces through the same
      // exit path so the provider has ONE failure channel.
      this.#exited = true;
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(err);
      }
      this.#pending.clear();
      opts.onExit({ code: null, signal: null, stderrTail: String(err.message ?? err) });
    });
  }

  get alive(): boolean {
    return !this.#exited;
  }

  /** The child's pid while it runs (process-tree kill on terminateBackend). */
  get pid(): number | undefined {
    return this.#exited ? undefined : this.#proc.pid;
  }

  /**
   * Strict-LF line assembly. pi warns that Unicode-separator-splitting
   * readers corrupt frames — we split on `\n` only and strip a trailing
   * `\r` per line.
   */
  #onStdout(chunk: string): void {
    this.#stdoutBuf += chunk;
    for (;;) {
      const nl = this.#stdoutBuf.indexOf("\n");
      if (nl === -1) break;
      let line = this.#stdoutBuf.slice(0, nl);
      this.#stdoutBuf = this.#stdoutBuf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length === 0) continue;
      this.#onLine(line);
    }
  }

  #onLine(line: string): void {
    let frame: PiFrame;
    try {
      frame = JSON.parse(line) as PiFrame;
    } catch {
      // pi promises JSON-only stdout in RPC mode; a stray line is most
      // likely extension console noise — log-and-drop keeps the turn alive.
      console.warn(`[codeoid/pi] dropped non-JSON stdout line: ${line.slice(0, 200)}`);
      return;
    }
    if (frame.type === "response" && typeof frame.id === "string") {
      const pending = this.#pending.get(frame.id);
      if (pending) {
        this.#pending.delete(frame.id);
        clearTimeout(pending.timer);
        pending.resolve(frame);
        return;
      }
    }
    this.#onEvent(frame);
  }

  /** Fire-and-forget frame (extension_ui_response, abort, steer, …). */
  send(frame: Record<string, unknown>): void {
    if (this.#exited) return;
    this.#proc.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  /** Correlated command — resolves with the matching `response` frame. */
  request(
    command: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<PiFrame> {
    if (this.#exited) {
      return Promise.reject(new Error("pi process is not running"));
    }
    const id = randomUUID();
    return new Promise<PiFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`pi RPC command "${String(command.type)}" timed out`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.send({ ...command, id });
    });
  }

  /** Terminate the subprocess. Idempotent; escalates to SIGKILL after 3s. */
  kill(): void {
    if (this.#exited) return;
    this.#proc.kill("SIGTERM");
    const hardKill = setTimeout(() => {
      if (!this.#exited) this.#proc.kill("SIGKILL");
    }, 3_000);
    // Don't hold the event loop open for the escalation timer.
    hardKill.unref?.();
  }
}
