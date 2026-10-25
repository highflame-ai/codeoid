/**
 * Generic newline-delimited JSON-RPC 2.0 client over a child process's
 * stdio — the shared transport for harnesses that expose a machine
 * protocol this way (codex `app-server`, ACP agents like gemini-cli).
 *
 *   - requests:      {jsonrpc, id, method, params} → {id, result|error}
 *   - notifications: {method, params} in both directions
 *   - SERVER→CLIENT requests (approvals, questions) carry an id and expect
 *     a response frame — the seam codeoid's approval gate plugs into.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type JsonRpcFrame = Record<string, unknown> & {
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string };
  params?: Record<string, unknown>;
};

export interface StdioJsonRpcSpawnOptions {
  /** Resolved binary. */
  command: string;
  /** Full argv (callers include their subcommand/flags). */
  args: string[];
  /** Short name for error messages ("codex", "gemini-cli"). */
  name: string;
  cwd: string;
  /** Allowlisted env (buildCodexEnv) — never raw process.env (GHSA-38vh). */
  env: Record<string, string>;
  /** Server→client NOTIFICATION (no id). */
  onNotification: (method: string, params: Record<string, unknown>) => void;
  /**
   * Server→client REQUEST (id present) — approvals + user-input questions.
   * The returned value is sent back as the JSON-RPC result; a throw sends
   * a JSON-RPC error (codex treats it as a denial-equivalent failure).
   */
  onServerRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  onExit: (info: { code: number | null; signal: string | null; stderrTail: string }) => void;
}

const REQUEST_TIMEOUT_MS = 30_000;
const STDERR_TAIL_BYTES = 4_096;

export class StdioJsonRpcProcess {
  #proc: ChildProcessWithoutNullStreams;
  #stdoutBuf = "";
  #stderrTail = "";
  #nextId = 1;
  #pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  #opts: StdioJsonRpcSpawnOptions;
  #exited = false;

  constructor(opts: StdioJsonRpcSpawnOptions) {
    this.#opts = opts;
    this.#proc = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: opts.env,
    });
    // A child that dies mid-write must not crash the daemon: without an
    // error listener, stdin's EPIPE becomes an uncaught stream error. The
    // exit handler owns diagnostics; writes after death are just dropped.
    this.#proc.stdin.on("error", () => {});
    this.#proc.stdout.setEncoding("utf8");
    this.#proc.stdout.on("data", (chunk: string) => this.#onStdout(chunk));
    this.#proc.stderr.setEncoding("utf8");
    this.#proc.stderr.on("data", (chunk: string) => {
      this.#stderrTail = (this.#stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    this.#proc.on("error", (err) => this.#failAll(new Error(`${opts.name} spawn failed: ${err.message}`)));
    this.#proc.on("exit", (code, signal) => {
      this.#exited = true;
      this.#failAll(new Error(`${opts.name} exited (code=${code} signal=${signal})`));
      opts.onExit({ code, signal, stderrTail: this.#stderrTail });
    });
  }

  get alive(): boolean {
    return !this.#exited;
  }

  /** The child's pid while it runs (process-tree kill on terminateBackend). */
  get pid(): number | undefined {
    return this.#exited ? undefined : this.#proc.pid;
  }

  /** Client→server request; resolves with the JSON-RPC result. */
  request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.#exited) return Promise.reject(new Error(`${this.#opts.name} process has exited`));
    const id = this.#nextId++;
    const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${this.#opts.name} request timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#write(`${frame}\n`, (err) => {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(err);
      });
    });
  }

  /** Client→server notification (no response expected). */
  notify(method: string, params?: Record<string, unknown>): void {
    if (this.#exited) return;
    this.#write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) })}\n`);
  }

  kill(): void {
    this.#proc.kill("SIGKILL");
  }

  /**
   * Write one frame, tolerating a dead child. Beyond the #exited flag and
   * the stdin "error" listener (async errors), write() on a DESTROYED
   * stream throws synchronously — swallow it: the exit handler owns
   * diagnostics, and pending requests are already failed by #failAll.
   */
  #write(frame: string, onWriteError?: (err: Error) => void): void {
    try {
      this.#proc.stdin.write(frame, (err) => {
        if (err) onWriteError?.(err);
      });
    } catch (err) {
      onWriteError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  #onStdout(chunk: string): void {
    this.#stdoutBuf += chunk;
    for (;;) {
      const idx = this.#stdoutBuf.indexOf("\n");
      if (idx < 0) break;
      const line = this.#stdoutBuf.slice(0, idx).trim();
      this.#stdoutBuf = this.#stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let frame: JsonRpcFrame;
      try {
        frame = JSON.parse(line) as JsonRpcFrame;
      } catch {
        continue; // non-JSON noise on stdout — ignore
      }
      this.#dispatch(frame);
    }
  }

  #dispatch(frame: JsonRpcFrame): void {
    // Response to one of OUR requests.
    if (frame.id !== undefined && frame.method === undefined) {
      const pending = this.#pending.get(frame.id as number);
      if (!pending) return;
      this.#pending.delete(frame.id as number);
      clearTimeout(pending.timer);
      if (frame.error) pending.reject(new Error(frame.error.message ?? `${this.#opts.name} error`));
      else pending.resolve(frame.result);
      return;
    }
    // Server→client REQUEST — must be answered (approvals, questions).
    if (frame.id !== undefined && frame.method !== undefined) {
      const id = frame.id;
      this.#opts
        .onServerRequest(frame.method, frame.params ?? {})
        .then((result) => {
          this.#write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
        })
        .catch((err: unknown) => {
          this.#write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
            })}\n`,
          );
        });
      return;
    }
    // Notification.
    if (frame.method !== undefined) {
      this.#opts.onNotification(frame.method, frame.params ?? {});
    }
  }

  #failAll(err: Error): void {
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.#pending.clear();
  }
}
