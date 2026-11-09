/**
 * The {@link SandboxHandle} of a local provider that confines a program by
 * wrapping its argv (bwrap, sandbox-exec, `docker run`): spawn and exec are
 * the wrapped argv run as a child of the daemon, and close ends every child it
 * started that is still running. Every wrap first checks the spec's pinned
 * directories (pins.ts) and refuses when one isn't what it was, and the argv
 * it hands back checks them again right before the program starts, so a
 * launcher written from it once checks at each run (#448 round 13).
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { pinGuardArgv, pinRefusal, pinsProblem, SandboxPinError } from "./pins.js";
import type { SandboxExecOptions, SandboxExecResult, SandboxHandle, SandboxSpawnOptions, SandboxSpec } from "./types.js";

export type ArgvWrapper = (argv: readonly string[], opts: SandboxSpawnOptions) => { argv: string[]; env: Record<string, string> };

/** Output kept per stream by {@link SandboxHandle.exec}. */
const EXEC_OUTPUT_CAP = 4 * 1024 * 1024;

export class LocalSandboxHandle implements SandboxHandle {
  readonly providerId: string;
  readonly spec: SandboxSpec;
  readonly #wrap: ArgvWrapper;
  readonly #children = new Set<ChildProcessWithoutNullStreams>();
  readonly #onClose: (() => Promise<void> | void) | undefined;
  #closed = false;

  constructor(providerId: string, spec: SandboxSpec, wrap: ArgvWrapper, onClose?: () => Promise<void> | void) {
    this.providerId = providerId;
    this.spec = spec;
    this.#wrap = wrap;
    this.#onClose = onClose;
  }

  wrap(argv: readonly string[], opts: SandboxSpawnOptions): { argv: string[]; env: Record<string, string> } {
    if (this.#closed) throw new Error(`the ${this.providerId} sandbox for session ${this.spec.sessionId} is closed`);
    const problem = pinsProblem(this.spec.pins);
    if (problem) throw new SandboxPinError(pinRefusal(problem));
    const wrapped = this.#wrap(argv, opts);
    return { ...wrapped, argv: pinGuardArgv(this.spec.pins, wrapped.argv) };
  }

  spawn(command: string, args: readonly string[], opts: SandboxSpawnOptions): ChildProcessWithoutNullStreams {
    const wrapped = this.wrap([command, ...args], opts);
    const [bin, ...rest] = wrapped.argv;
    if (!bin) throw new Error("empty sandbox argv");
    const child = spawn(bin, rest, { cwd: opts.cwd, env: wrapped.env, stdio: ["pipe", "pipe", "pipe"] });
    this.#children.add(child);
    child.once("exit", () => this.#children.delete(child));
    child.once("error", () => this.#children.delete(child));
    return child;
  }

  exec(argv: readonly string[], opts: SandboxExecOptions): Promise<SandboxExecResult> {
    const [command, ...args] = argv;
    if (!command) return Promise.reject(new Error("empty command"));
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawn(command, args, opts);
      } catch (err) {
        reject(err);
        return;
      }
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (c: string) => {
        if (stdout.length < EXEC_OUTPUT_CAP) stdout += c;
      });
      child.stderr.on("data", (c: string) => {
        if (stderr.length < EXEC_OUTPUT_CAP) stderr += c;
      });
      child.stdin.on("error", () => {});
      if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
      else child.stdin.end();
      const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : undefined;
      child.once("error", (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });
      child.once("close", (code, signal) => {
        if (timer) clearTimeout(timer);
        resolve({ exitCode: code, signal, stdout, stderr });
      });
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const child of this.#children) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    this.#children.clear();
    await this.#onClose?.();
  }
}
