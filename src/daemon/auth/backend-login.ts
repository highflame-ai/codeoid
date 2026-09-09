/**
 * Backend login broker — runs a backend's OWN login command and brokers its two
 * interactive steps to a codeoid client.
 *
 * See `packages/protocol/src/backend-login.ts` for why the daemon drives the
 * vendor's command rather than implementing the vendor's OAuth. This file is
 * the mechanism: a small amount of process wrangling around one awkward fact.
 *
 * THE AWKWARD FACT: these commands are terminal UIs. `claude setup-token`
 * writes nothing at all to a pipe — it detects the absence of a TTY and waits
 * forever. Verified: piped stdin/stdout produced zero bytes and hung; the same
 * command under a pty printed its authorize URL in under two seconds. So the
 * command needs a pty, and codeoid has no pty dependency (node-pty is a native
 * module — a build toolchain in every image, for one feature). `script(1)` is
 * the pty: util-linux on Linux (Essential, so present even in debian-slim),
 * BSD script on macOS, different argv on each.
 *
 * WHAT WE READ BACK is raw terminal output — ANSI, OSC-8 hyperlinks, spinner
 * redraws, an 80-column wrap that chops the URL across lines. Rather than strip
 * escapes and hope, every pattern here is chosen to match on a character class
 * that terminal control bytes cannot appear in, so the escapes are simply not
 * matchable and the longest match wins (the OSC-8 copy of the URL is the
 * unwrapped one).
 *
 * SECRET HYGIENE. The transcript holds a credential by the end, and the code
 * the user submits is a bearer of one. Neither is ever logged, returned to a
 * client, or included in an error; {@link redact} runs over anything that
 * escapes this module.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { LoginBackend, PendingBackendLogin } from "../../protocol/types.js";
import { buildSubprocessEnv } from "../providers/env.js";

/** Longest we hold a started attempt open before killing it. */
const ATTEMPT_TTL_MS = 10 * 60_000;
/** Longest we wait for the command to print its authorize URL. */
const URL_TIMEOUT_MS = 45_000;
/** Longest we wait for the vendor to accept or reject a submitted code. */
const EXCHANGE_TIMEOUT_MS = 90_000;
/**
 * Transcript cap. We keep the TAIL (the outcome), never the whole stream: a
 * spinner redrawing at 10 Hz for ten minutes is megabytes of nothing, and the
 * URL is captured out of the stream the moment it appears rather than kept by
 * holding the bytes it arrived in.
 */
const TRANSCRIPT_MAX = 64 * 1024;

/** Reject a code that could not be one, before it reaches a live process. */
const CODE_MAX = 1024;

/**
 * One backend's login command and how to read its terminal output.
 *
 * Adding a backend is an entry in {@link FLOWS}. The shape is deliberately
 * declarative — no per-backend branching anywhere else in this file — because
 * the parts that differ between vendors are exactly these five, and the parts
 * that are hard (pty, timeouts, cancellation, redaction) are the same for all.
 */
export interface LoginFlow {
  backend: LoginBackend;
  /**
   * Resolve the command to run, or `null` when this installation has no such
   * binary — a clean "not available here" rather than a spawn failure.
   */
  resolve(): { file: string; args: string[] } | null;
  /** Matches the authorize URL in raw terminal output. */
  urlPattern: RegExp;
  /** Matches the vendor's own rejection of a submitted code. */
  failurePattern: RegExp;
  /** Shown to the user beside the code box; vendor-specific wording. */
  codeHint: string;
  /**
   * Pull the credential out of the finished transcript.
   *
   * `null` is NOT failure — some commands write their credential to disk and
   * print nothing worth keeping. It means "nothing for codeoid to store", and
   * the attempt still succeeds on the command's exit status.
   */
  extractSecret(transcript: string): { key: string; value: string } | null;
}

const require_ = createRequire(import.meta.url);

/**
 * The `claude` binary that the Agent SDK already ships.
 *
 * codeoid does not depend on the Claude Code CLI and does not need to: the
 * Agent SDK's platform package (`@anthropic-ai/claude-agent-sdk-<platform>`)
 * contains the real binary, and it is what every Claude turn already runs
 * through. So this feature adds no dependency and no image bytes — it runs the
 * executable that is by definition present wherever the Claude backend works.
 *
 * The musl variant is tried second so an Alpine install resolves; a plain
 * `claude` on PATH is the last resort for an unusual layout.
 */
function resolveClaudeBinary(): string | null {
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  for (const pkg of [base, `${base}-musl`]) {
    try {
      return require_.resolve(`${pkg}/claude`);
    } catch {
      // Not this variant — try the next.
    }
  }
  return null;
}

/**
 * `sk-ant-oat01-…` — the long-lived OAuth token `setup-token` mints. Bounded
 * character class so a trailing ANSI reset or newline is not swallowed into it.
 */
const CLAUDE_OAUTH_TOKEN = /sk-ant-oat01-[A-Za-z0-9_-]{20,}/;

export const CLAUDE_LOGIN_FLOW: LoginFlow = {
  backend: "claude",
  resolve() {
    const bin = resolveClaudeBinary();
    return bin ? { file: bin, args: ["setup-token"] } : null;
  },
  // The character class stops at any terminal control byte, so the OSC-8
  // hyperlink wrapping this URL cannot bleed into the match — and the
  // hyperlink's copy is the one that is not line-wrapped, hence longest-wins.
  urlPattern: /https:\/\/claude\.com\/[A-Za-z0-9/_.~-]*oauth\/authorize\?[A-Za-z0-9_=&%.~+-]+/g,
  // The command prints this and then offers "Press Enter to retry", i.e. it
  // stays alive. We treat it as terminal anyway: a retry loop driven one
  // round-trip at a time through a websocket is a worse experience than
  // pressing the button again, and leaving the process alive after a failure we
  // have already reported is a leak.
  failurePattern: /OAuth error:/,
  codeHint: "Approve in the browser, then paste the code the page shows.",
  extractSecret(transcript) {
    const m = CLAUDE_OAUTH_TOKEN.exec(transcript);
    // No token in the output is not a failure: `setup-token` also writes
    // ~/.claude/.credentials.json, which the Agent SDK reads directly. Storing
    // the token when we can see it is strictly better — it survives a container
    // whose home directory does not — but its absence just means the on-disk
    // credential is the one doing the work.
    return m ? { key: "CLAUDE_CODE_OAUTH_TOKEN", value: m[0] } : null;
  },
};

const FLOWS: Record<LoginBackend, LoginFlow> = {
  claude: CLAUDE_LOGIN_FLOW,
};

/** Anything credential-shaped, gone — applied to every string that leaves here. */
export function redact(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9]+-[A-Za-z0-9_-]{8,}/g, "«redacted»")
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "«redacted»");
}

export class BackendLoginError extends Error {}

interface Attempt {
  loginId: string;
  backend: LoginBackend;
  flow: LoginFlow;
  child: ChildProcess;
  transcript: string;
  /**
   * Characters discarded off the FRONT by {@link capTail}, so an offset taken
   * before a trim still addresses the same point in the stream. Without this a
   * long-running attempt (a spinner redrawing for minutes) would silently shift
   * the "everything since the code was submitted" window, and the exchange
   * could be judged against output from before it.
   */
  dropped: number;
  verificationUrl: string | null;
  expiresAt: number;
  ttlTimer: ReturnType<typeof setTimeout>;
  exited: boolean;
  exitCode: number | null;
  /** Woken on every chunk of output and on exit, so waiters can re-test. */
  wake: (() => void)[];
}

export interface LoginOutcome {
  ok: boolean;
  /** Present on success when the command emitted a credential worth storing. */
  secret?: { key: string; value: string };
  /** Redacted, user-safe. Present on failure. */
  error?: string;
}

/**
 * Holds at most one in-flight login per backend.
 *
 * `flows` is injectable so tests drive a fake login command through the REAL
 * pty and the real matching — the parts that are easy to get wrong — without
 * reaching a vendor.
 */
export class BackendLoginBroker {
  readonly #flows: Record<string, LoginFlow>;
  readonly #byId = new Map<string, Attempt>();
  readonly #byBackend = new Map<string, string>();

  constructor(flows: Record<string, LoginFlow> = FLOWS) {
    this.#flows = flows;
  }

  /**
   * Run the backend's login command and resolve once it has printed its URL.
   *
   * Supersedes any attempt already in flight for this backend. A user who
   * reloads the page must not be locked out by their own abandoned attempt, and
   * two live logins for one backend would race to write the same credential.
   */
  async start(backend: LoginBackend): Promise<PendingBackendLogin> {
    const flow = this.#flows[backend];
    if (!flow) throw new BackendLoginError(`No interactive login for backend '${backend}'.`);

    const resolved = flow.resolve();
    if (!resolved) {
      throw new BackendLoginError(
        `The ${backend} login command is not installed on this machine, so codeoid cannot sign in for you.`,
      );
    }

    const superseded = this.#byBackend.get(backend);
    if (superseded) this.cancel(superseded);

    const child = spawnUnderPty(resolved.file, resolved.args);
    const loginId = randomUUID();
    const attempt: Attempt = {
      loginId,
      backend,
      flow,
      child,
      transcript: "",
      dropped: 0,
      verificationUrl: null,
      expiresAt: Date.now() + ATTEMPT_TTL_MS,
      ttlTimer: setTimeout(() => this.cancel(loginId), ATTEMPT_TTL_MS),
      exited: false,
      exitCode: null,
      wake: [],
    };
    // `unref` so a forgotten attempt cannot hold the process open at shutdown.
    attempt.ttlTimer.unref?.();
    this.#byId.set(loginId, attempt);
    this.#byBackend.set(backend, loginId);

    const absorb = (buf: Buffer | string) => {
      append(attempt, String(buf));
      if (!attempt.verificationUrl) {
        attempt.verificationUrl = longestMatch(attempt.transcript, flow.urlPattern);
      }
      drain(attempt);
    };
    child.stdout?.on("data", absorb);
    child.stderr?.on("data", absorb);
    child.on("error", (err) => {
      append(attempt, `\n${err.message}`);
      attempt.exited = true;
      drain(attempt);
    });
    child.on("exit", (code) => {
      attempt.exited = true;
      attempt.exitCode = code;
      drain(attempt);
    });

    try {
      await waitFor(attempt, URL_TIMEOUT_MS, () => attempt.verificationUrl !== null || attempt.exited);
    } catch {
      this.cancel(loginId);
      throw new BackendLoginError(
        `The ${backend} login command did not produce a sign-in link in time.`,
      );
    }
    if (!attempt.verificationUrl) {
      const tail = redact(lastLine(attempt.transcript));
      this.cancel(loginId);
      throw new BackendLoginError(
        `The ${backend} login command exited before producing a sign-in link${tail ? `: ${tail}` : "."}`,
      );
    }

    return {
      loginId,
      backend,
      verificationUrl: attempt.verificationUrl,
      expiresAt: attempt.expiresAt,
      codeHint: flow.codeHint,
    };
  }

  /**
   * Hand the vendor's code to the waiting command and wait for the exchange.
   *
   * Terminal either way — the attempt is disposed before returning, so a
   * rejected code means starting again rather than retrying into a process
   * whose state we can no longer describe.
   */
  async submit(loginId: string, code: string): Promise<LoginOutcome> {
    const attempt = this.#byId.get(loginId);
    if (!attempt) {
      return { ok: false, error: "That sign-in attempt is no longer open. Start again." };
    }
    const trimmed = code.trim();
    // The code goes to a process's stdin, not a shell, so there is nothing to
    // inject — but a newline would submit a second phantom answer to whatever
    // the command asks next, and an unbounded blob is just a way to make a
    // pty misbehave. Refuse both rather than sanitise into something the user
    // did not type.
    if (trimmed.length === 0 || trimmed.length > CODE_MAX || /[\r\n\x00]/.test(trimmed)) {
      return { ok: false, error: "That does not look like a sign-in code." };
    }
    if (attempt.exited) {
      this.#dispose(attempt);
      return { ok: false, error: "The sign-in command exited before the code arrived. Start again." };
    }

    // Mark where the answer begins, so a failure pattern already in the
    // transcript (from the URL step) cannot be read as a rejection of THIS
    // code. Stream-absolute, so a mid-exchange trim cannot move it.
    const mark = attempt.dropped + attempt.transcript.length;
    attempt.child.stdin?.write(`${trimmed}\r`);

    const sinceMark = () => attempt.transcript.slice(Math.max(0, mark - attempt.dropped));

    /**
     * The credential the VENDOR minted — never the one the user typed.
     *
     * A pty echoes its input, so everything submitted lands in the transcript
     * a few bytes after the mark, indistinguishable from command output. Paste
     * something credential-shaped (the exact mistake a user makes when they
     * confuse "code" with "key") and the naive read is: match found, exchange
     * succeeded, store it — a reported sign-in that authenticates as nothing.
     *
     * Containment rather than equality, because a wrapped echo can be broken
     * across lines and match as a PREFIX of what was typed. Nothing a vendor
     * returns for an exchange is a substring of the code that requested it.
     */
    const mintedSecret = () => {
      const found = attempt.flow.extractSecret(sinceMark());
      return found && !trimmed.includes(found.value) ? found : null;
    };

    const settled = () => {
      if (attempt.flow.failurePattern.test(sinceMark())) return true;
      if (mintedSecret()) return true;
      return attempt.exited;
    };

    try {
      await waitFor(attempt, EXCHANGE_TIMEOUT_MS, settled);
    } catch {
      this.#dispose(attempt);
      return { ok: false, error: "The sign-in did not complete in time. Start again." };
    }

    const since = sinceMark();
    const secret = mintedSecret() ?? undefined;
    const rejected = attempt.flow.failurePattern.test(since);
    this.#dispose(attempt);

    if (secret && !rejected) return { ok: true, secret };
    if (rejected) {
      return { ok: false, error: `${redact(vendorReason(since))} Start the sign-in again.` };
    }
    // Exited with no credential in the output: trust the exit status. A command
    // that stores its credential on disk (and prints nothing) lands here, and
    // so does one that failed in a way we have no pattern for — the exit code
    // is what separates them.
    if (attempt.exitCode === 0) return { ok: true };
    return {
      ok: false,
      error: `The ${attempt.backend} sign-in command failed${
        attempt.exitCode === null ? "" : ` (exit ${attempt.exitCode})`
      }. Start again.`,
    };
  }

  /** Abandon an attempt and kill its command. Idempotent. */
  cancel(loginId: string): boolean {
    const attempt = this.#byId.get(loginId);
    if (!attempt) return false;
    this.#dispose(attempt);
    return true;
  }

  /** Kill every in-flight attempt — daemon shutdown. */
  dispose(): void {
    for (const id of [...this.#byId.keys()]) this.cancel(id);
  }

  #dispose(attempt: Attempt): void {
    clearTimeout(attempt.ttlTimer);
    this.#byId.delete(attempt.loginId);
    if (this.#byBackend.get(attempt.backend) === attempt.loginId) {
      this.#byBackend.delete(attempt.backend);
    }
    killTree(attempt.child);
    // Anything still awaiting this attempt must not hang on a dead process.
    attempt.exited = true;
    drain(attempt);
    // Drop the transcript: it is the one place a credential sits in memory
    // longer than the exchange needs it.
    attempt.transcript = "";
  }
}

// ── Process plumbing ──────────────────────────────────────────────────────────

/**
 * Spawn `file args…` attached to a pty, via `script(1)`.
 *
 * Two dialects, because the flag that means "run this command" is not the same
 * one on both platforms and getting it wrong looks like the command hanging:
 *   - util-linux (Linux): `script -q -e -c "<cmd>" /dev/null` — `-e` is what
 *     makes the child's exit status ours rather than script's.
 *   - BSD (macOS): `script -q /dev/null <cmd> <args…>` — argv, so no quoting.
 *
 * `detached` puts the child in its own process group: killing `script` alone
 * would orphan the command it wrapped, which for a login command means an
 * abandoned OAuth attempt still holding a pty.
 */
function spawnUnderPty(file: string, args: string[]): ChildProcess {
  const env = {
    ...buildSubprocessEnv({ prefixes: ["ANTHROPIC_", "CLAUDE_", "LC_"] }),
    // A login command tries to open a browser. On the machine a daemon runs on
    // that is at best useless and at worst a browser nobody asked for on
    // someone's desktop — the user opens the URL we return, on their own
    // machine. Every command tested prints the URL regardless.
    BROWSER: "/bin/true",
    // Terminal UIs size their output to the pty. Fixing it keeps the URL from
    // being wrapped differently on a client with a different terminal, and
    // keeps the transcript deterministic.
    COLUMNS: "100",
    LINES: "40",
    TERM: "xterm-256color",
  };
  const argv =
    process.platform === "darwin"
      ? ["-q", "/dev/null", file, ...args]
      : ["-q", "-e", "-c", shellQuote([file, ...args]), "/dev/null"];
  return spawn("script", argv, { env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
}

/** POSIX single-quoting — the command path is ours, but it may contain spaces. */
function shellQuote(parts: string[]): string {
  return parts.map((p) => `'${p.replaceAll("'", `'\\''`)}'`).join(" ");
}

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    // Negative pid = the whole process group (see `detached` above).
    if (child.pid) process.kill(-child.pid, "SIGTERM");
  } catch {
    // Already gone, or never started — nothing to clean up.
  }
  const hard = setTimeout(() => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      // Same.
    }
  }, 2_000);
  hard.unref?.();
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function drain(attempt: Attempt): void {
  const waiters = attempt.wake;
  attempt.wake = [];
  for (const w of waiters) w();
}

/** Resolve when `done()` holds; reject on timeout. Re-tested on every output chunk. */
function waitFor(attempt: Attempt, timeoutMs: number, done: () => boolean): Promise<void> {
  if (done()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    timer.unref?.();
    const tick = () => {
      if (!done()) {
        attempt.wake.push(tick);
        return;
      }
      clearTimeout(timer);
      resolve();
    };
    attempt.wake.push(tick);
  });
}

/**
 * The longest match, not the first.
 *
 * The URL is printed twice: once inside an OSC-8 hyperlink (complete) and once
 * as visible text (wrapped to the terminal width, so truncated at the first
 * newline). Longest-wins picks the usable one without knowing which came first.
 */
function longestMatch(text: string, pattern: RegExp): string | null {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let best: string | null = null;
  for (const m of text.matchAll(re)) {
    if (best === null || m[0].length > best.length) best = m[0];
  }
  return best;
}

/** Append to the transcript, trimming the front and accounting for what went. */
function append(attempt: Attempt, chunk: string): void {
  const grown = attempt.transcript + chunk;
  if (grown.length <= TRANSCRIPT_MAX) {
    attempt.transcript = grown;
    return;
  }
  const cut = grown.length - TRANSCRIPT_MAX;
  attempt.transcript = grown.slice(cut);
  attempt.dropped += cut;
}

/** The vendor's own last words, stripped of terminal noise, for an error we show. */
function vendorReason(text: string): string {
  const plain = stripAnsi(text);
  const line = plain
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .find((l) => /error/i.test(l));
  return line ?? "The provider rejected that code.";
}

function lastLine(text: string): string {
  const lines = stripAnsi(text)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.at(-1) ?? "";
}

/** CSI/OSC sequences out. Display only — never used to decide anything. */
function stripAnsi(text: string): string {
  // oxlint-disable-next-line no-control-regex -- terminal output is the input
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}
