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

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { LoginBackend, PendingBackendLogin } from "../../protocol/types.js";
import {
  closeSync,
  constants as fsConstants,
  createWriteStream,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripClaudeCredentials } from "../claude-accounts.js";
import { buildSubprocessEnv } from "../providers/env.js";
import { resolveCodexCommand } from "../providers/codex/resolve.js";
import { isCodexCredentialVar } from "../account-apply.js";

/** Longest we hold a started attempt open before killing it. */
const ATTEMPT_TTL_MS = 10 * 60_000;
/** Longest we wait for the command to print its authorize URL. */
const URL_TIMEOUT_MS = 45_000;
/** Longest we wait for the vendor to accept or reject a submitted code. */
const EXCHANGE_TIMEOUT_MS = 90_000;
/** Pause between typing a code and pressing Enter, so the code isn't read as one paste with the Enter in it. */
const ENTER_DELAY_MS = 300;
/** Width of the sign-in command's terminal: wide enough that no URL or token wraps. */
const PTY_COLUMNS = 500;
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
   * `code`: the vendor's page shows a code the user pastes back (submit).
   * `device`: the user enters the code the COMMAND printed on the vendor's
   * page, and the command finishes on its own (wait).
   */
  mode: "code" | "device";
  /**
   * Resolve the command to run, or `null` when this installation has no such
   * binary — a clean "not available here" rather than a spawn failure.
   */
  resolve(): { file: string; args: string[] } | null;
  /** Matches the authorize URL in raw terminal output. */
  urlPattern: RegExp;
  /** `device` only: matches the one-time code the user enters on the vendor's page. */
  userCodePattern?: RegExp;
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
  /** Variable-name prefixes the command inherits (beyond the shared basics). */
  envPrefixes: readonly string[];
  /** The inherited environment without any daemon credential — an isolated login must not see one. */
  stripCredentials(env: Record<string, string>): Record<string, string>;
  /** Variables pointing the command at its staging home. */
  homeEnv(home: string): Record<string, string>;
  /** Prepare the staging home before the command runs. */
  prepareHome?(home: string): void;
  /**
   * Files (relative to the home) the command writes its credential to. The
   * first must exist for the sign-in to count as done; all that exist are
   * handed back to be kept as the account's.
   */
  credentialFiles?: readonly string[];
  /** Only a named account may sign in this way — there is no daemon-wide login to replace. */
  isolatedOnly?: boolean;
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
  mode: "code",
  envPrefixes: ["ANTHROPIC_", "CLAUDE_", "LC_"],
  stripCredentials: stripClaudeCredentials,
  homeEnv: (home) => ({ CLAUDE_CONFIG_DIR: home }),
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

/**
 * `codex login --device-auth` against the account's staging CODEX_HOME. It
 * prints a link and a one-time code, polls OpenAI until the user enters it,
 * writes `auth.json`, and exits 0. Verified headless (codex-cli 0.154).
 */
export const CODEX_LOGIN_FLOW: LoginFlow = {
  backend: "codex",
  mode: "device",
  resolve() {
    const r = resolveCodexCommand(undefined);
    return r ? { file: r.command, args: [...r.argsPrefix, "login", "--device-auth"] } : null;
  },
  urlPattern: /https:\/\/auth\.openai\.com\/[A-Za-z0-9/_.~-]+(?:\?[A-Za-z0-9_=&%.~+-]+)?/g,
  // `8UP4-KHOLU`: groups of capitals and digits joined by a dash.
  userCodePattern: /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/,
  failurePattern: /Error logging in|Login failed|device code (?:has )?expired|authorization (?:was )?denied/i,
  codeHint: "Open the link, sign in to ChatGPT, and enter this code. codeoid finishes the sign-in once you approve.",
  extractSecret: () => null,
  envPrefixes: ["CODEX_", "OPENAI_", "LC_"],
  stripCredentials: (env) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) if (!isCodexCredentialVar(k)) out[k] = v;
    return out;
  },
  homeEnv: (home) => ({ CODEX_HOME: home }),
  credentialFiles: ["auth.json"],
  isolatedOnly: true,
};

const FLOWS: Record<LoginBackend, LoginFlow> = {
  claude: CLAUDE_LOGIN_FLOW,
  codex: CODEX_LOGIN_FLOW,
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
  /** What the user types reaches the command through here (see spawnUnderPty). */
  input: PtyInput;
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
  /** Staging home an isolated login ran against — removed on dispose. */
  isolatedDir?: string;
  /** `device`: the one-time code the command printed. */
  userCode: string | null;
  /**
   * File-credential flows: re-tests waiters on a timer, because a command
   * that writes its credential file and then sits quietly (the Gemini CLI
   * becomes a chat) prints nothing that would wake them.
   */
  poller?: ReturnType<typeof setInterval>;
}

export interface LoginOutcome {
  ok: boolean;
  /** Present on success when the command emitted a credential worth storing. */
  secret?: { key: string; value: string };
  /** Redacted, user-safe. Present on failure. */
  error?: string;
  /**
   * The attempt ran against a throwaway config dir for a NAMED account. Its
   * credential belongs to that account only and must never be written where
   * the daemon's own login lives (`~/.codeoid/.env`).
   */
  isolated?: boolean;
  /**
   * File-credential flows: the credential files the command wrote, relative
   * to its home, to be kept as the account's. Read before the staging home
   * is deleted; never logged.
   */
  files?: Record<string, string>;
}

/** Prefix of the staging homes isolated logins run against (any backend). */
export const ISOLATED_DIR_PREFIX = "codeoid-login-";
/** #392's prefix — still swept, so an upgrade cleans up after an older daemon. */
const LEGACY_ISOLATED_DIR_PREFIX = "codeoid-claude-login-";

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
    sweepStaleIsolatedDirs();
  }

  /** Is this attempt still open (a code can still be submitted to it)? */
  isOpen(loginId: string): boolean {
    return this.#byId.has(loginId);
  }

  /**
   * Run the backend's login command and resolve once it has printed its URL.
   *
   * Supersedes any attempt already in flight for this backend. A user who
   * reloads the page must not be locked out by their own abandoned attempt, and
   * two live logins for one backend would race to write the same credential.
   */
  /**
   * `isolated`: run the command against a THROWAWAY Claude config dir with no
   * inherited credential variables. `claude setup-token` also writes the
   * config dir's stored login, so a login for a second, named account
   * (claude-accounts.ts) must never touch the machine's own: it would replace
   * the personal sign-in every unaccounted session runs on. Only the token the
   * command prints is kept; the dir is deleted when the attempt ends.
   */
  async start(backend: LoginBackend, opts: { isolated?: boolean } = {}): Promise<PendingBackendLogin> {
    const flow = this.#flows[backend];
    if (!flow) throw new BackendLoginError(`No interactive login for backend '${backend}'.`);
    if (flow.isolatedOnly && !opts.isolated) {
      throw new BackendLoginError(`A ${backend} sign-in is for a named account — give the account a name.`);
    }

    const resolved = flow.resolve();
    if (!resolved) {
      throw new BackendLoginError(
        `The ${backend} login command is not installed on this machine, so codeoid cannot sign in for you.`,
      );
    }

    const superseded = this.#byBackend.get(backend);
    if (superseded) this.cancel(superseded);

    const isolatedDir = opts.isolated ? mkdtempSync(join(tmpdir(), ISOLATED_DIR_PREFIX)) : undefined;
    let child: ChildProcess;
    let input: PtyInput;
    try {
      if (isolatedDir) flow.prepareHome?.(isolatedDir);
      ({ child, input } = spawnUnderPty(resolved.file, resolved.args, flow, isolatedDir));
    } catch (err) {
      if (isolatedDir) rmSync(isolatedDir, { recursive: true, force: true });
      throw err;
    }
    const loginId = randomUUID();
    const attempt: Attempt = {
      loginId,
      backend,
      flow,
      child,
      input,
      transcript: "",
      dropped: 0,
      verificationUrl: null,
      expiresAt: Date.now() + ATTEMPT_TTL_MS,
      ttlTimer: setTimeout(() => this.cancel(loginId), ATTEMPT_TTL_MS),
      exited: false,
      exitCode: null,
      wake: [],
      ...(isolatedDir ? { isolatedDir } : {}),
      userCode: null,
    };
    // `unref` so a forgotten attempt cannot hold the process open at shutdown.
    attempt.ttlTimer.unref?.();
    if (flow.credentialFiles?.length) {
      attempt.poller = setInterval(() => drain(attempt), 500);
      attempt.poller.unref?.();
    }
    this.#byId.set(loginId, attempt);
    this.#byBackend.set(backend, loginId);

    const absorb = (buf: Buffer | string) => {
      append(attempt, String(buf));
      if (!attempt.verificationUrl) {
        const found = longestMatch(attempt.transcript, flow.urlPattern);
        // Enforced here, not left to each flow's regex, because this string
        // becomes an `href` in every client. Today's patterns are anchored on
        // `https://claude.com/…` and cannot produce anything else; the point is
        // that a future flow with a looser pattern cannot turn scraped terminal
        // output into a `javascript:` link. One place, all flows, all clients.
        attempt.verificationUrl = found?.startsWith("https://") ? found : null;
      }
      if (flow.userCodePattern && !attempt.userCode) {
        attempt.userCode = flow.userCodePattern.exec(stripAnsi(attempt.transcript))?.[0] ?? null;
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
      // A device login needs its code too — both are printed together.
      const ready = () => attempt.verificationUrl !== null && (flow.mode !== "device" || attempt.userCode !== null);
      await waitFor(attempt, URL_TIMEOUT_MS, () => ready() || attempt.exited);
    } catch {
      this.cancel(loginId);
      throw new BackendLoginError(
        `The ${backend} login command did not produce a sign-in link in time.`,
      );
    }
    if (!attempt.verificationUrl || (flow.mode === "device" && !attempt.userCode)) {
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
      expiresInMs: Math.max(0, attempt.expiresAt - Date.now()),
      codeHint: flow.codeHint,
      mode: flow.mode,
      ...(attempt.userCode ? { userCode: attempt.userCode } : {}),
    };
  }

  /**
   * A `device` login: wait until the user approved on the vendor's page (the
   * command wrote its credential and exited) or it failed. Terminal either
   * way, like `submit`.
   */
  async wait(loginId: string): Promise<LoginOutcome> {
    const attempt = this.#byId.get(loginId);
    if (!attempt) return { ok: false, error: "That sign-in attempt is no longer open. Start again." };
    if (attempt.flow.mode !== "device") {
      return { ok: false, error: "This sign-in finishes with the code the page shows — paste it instead." };
    }
    const isolated = attempt.isolatedDir !== undefined;
    const done = () => attempt.exited || attempt.flow.failurePattern.test(attempt.transcript) || this.#credentialReady(attempt);
    try {
      await waitFor(attempt, Math.max(0, attempt.expiresAt - Date.now()), done);
    } catch {
      this.#dispose(attempt);
      return { ok: false, error: "The sign-in was not approved in time. Start again." };
    }
    if (this.#byId.get(loginId) !== attempt) return { ok: false, error: "That sign-in attempt was cancelled." };
    // Give a command that wrote its credential a moment to exit cleanly.
    if (!attempt.exited) await waitFor(attempt, 3_000, () => attempt.exited).catch(() => {});
    const files = this.#collectFiles(attempt);
    const rejected = attempt.flow.failurePattern.test(attempt.transcript);
    const reason = rejected ? redact(vendorReason(attempt.transcript)) : null;
    const exitCode = attempt.exitCode;
    this.#dispose(attempt);
    if (files && !rejected) return { ok: true, files, ...(isolated ? { isolated: true } : {}) };
    return {
      ok: false,
      error: reason ? `${reason} Start the sign-in again.` : `The ${attempt.backend} sign-in did not complete${exitCode === null ? "" : ` (exit ${exitCode})`}. Start again.`,
      ...(isolated ? { isolated: true } : {}),
    };
  }

  /** Has the command written the file that proves the sign-in (file-credential flows)? */
  #credentialReady(attempt: Attempt): boolean {
    const first = attempt.flow.credentialFiles?.[0];
    return first !== undefined && attempt.isolatedDir !== undefined && existsSync(join(attempt.isolatedDir, first));
  }

  /** The credential files the command wrote, or null when the first (required) one is missing. */
  #collectFiles(attempt: Attempt): Record<string, string> | null {
    const files = attempt.flow.credentialFiles;
    if (!files?.length || !attempt.isolatedDir || !this.#credentialReady(attempt)) return null;
    const out: Record<string, string> = {};
    for (const rel of files) {
      try {
        out[rel] = readFileSync(join(attempt.isolatedDir, rel), "utf8");
      } catch {
        // Optional file the vendor didn't write.
      }
    }
    return out;
  }

  /**
   * Hand the vendor's code to the waiting command and wait for the exchange.
   *
   * Terminal once the code reached the command — the attempt is disposed
   * before returning, so a rejected code means starting again rather than
   * retrying into a process whose state we can no longer describe. A code
   * refused before it was sent (malformed) leaves the attempt open: check
   * `isOpen`.
   */
  async submit(loginId: string, code: string): Promise<LoginOutcome> {
    const attempt = this.#byId.get(loginId);
    if (!attempt) return this.#exchange(loginId, attempt, code);
    const isolated = attempt.isolatedDir !== undefined;
    const outcome = await this.#exchange(loginId, attempt, code);
    return isolated ? { ...outcome, isolated: true } : outcome;
  }

  async #exchange(loginId: string, attempt: Attempt | undefined, code: string): Promise<LoginOutcome> {
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
    // Enter goes separately: a long chunk arriving at once is read as a paste,
    // and a `\r` inside a paste is text, not Enter — a real code (~130 chars)
    // then sits in the field forever while a short one submits.
    attempt.input.write(trimmed);
    await new Promise((r) => setTimeout(r, ENTER_DELAY_MS));
    attempt.input.write("\r");

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
      if (this.#credentialReady(attempt)) return true;
      return attempt.exited;
    };

    try {
      await waitFor(attempt, EXCHANGE_TIMEOUT_MS, settled);
    } catch {
      this.#dispose(attempt);
      return { ok: false, error: "The sign-in did not complete in time. Start again." };
    }

    // Cancelled (or expired) out from under us while we waited. `#dispose`
    // wakes every waiter by marking the attempt exited and then drops the
    // transcript, so falling through would judge the exchange against an empty
    // window and report "the sign-in command failed" for what was actually a
    // user pressing Cancel. Say what happened instead.
    if (this.#byId.get(loginId) !== attempt) {
      return { ok: false, error: "That sign-in attempt was cancelled." };
    }

    const since = sinceMark();
    const secret = mintedSecret() ?? undefined;
    const rejected = attempt.flow.failurePattern.test(since);
    const files = this.#collectFiles(attempt);
    this.#dispose(attempt);

    if (secret && !rejected) return { ok: true, secret };
    if (files && !rejected) return { ok: true, files };
    // A file-credential flow that ended without its file did not sign in,
    // whatever its exit status (the Gemini CLI is killed, not exited).
    if (attempt.flow.credentialFiles?.length && !rejected) {
      return { ok: false, error: `The ${attempt.backend} sign-in did not complete. Start again.` };
    }
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
    if (attempt.poller) clearInterval(attempt.poller);
    this.#byId.delete(attempt.loginId);
    if (this.#byBackend.get(attempt.backend) === attempt.loginId) {
      this.#byBackend.delete(attempt.backend);
    }
    killTree(attempt.child);
    attempt.input.close();
    // Anything still awaiting this attempt must not hang on a dead process.
    attempt.exited = true;
    drain(attempt);
    // Drop the transcript: it is the one place a credential sits in memory
    // longer than the exchange needs it.
    attempt.transcript = "";
    if (attempt.isolatedDir) {
      const dir = attempt.isolatedDir;
      attempt.isolatedDir = undefined;
      const remove = () => rmSync(dir, { recursive: true, force: true });
      remove();
      // The command may still be writing as it dies (the kill is a signal, not
      // a wait): remove again once it has actually gone.
      if (attempt.child.exitCode === null && attempt.child.signalCode === null) attempt.child.once("exit", remove);
    }
  }
}

/**
 * Remove isolated login dirs a previous daemon left behind (it crashed or was
 * killed mid-login): each can hold a full Claude credential. Only dirs older
 * than an attempt can live, so a concurrently running daemon's live attempt is
 * never touched.
 */
function sweepStaleIsolatedDirs(): void {
  const root = tmpdir();
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  const cutoff = Date.now() - ATTEMPT_TTL_MS;
  for (const name of names) {
    if (!name.startsWith(ISOLATED_DIR_PREFIX) && !name.startsWith(LEGACY_ISOLATED_DIR_PREFIX)) continue;
    const dir = join(root, name);
    try {
      if (statSync(dir).mtimeMs < cutoff) rmSync(dir, { recursive: true, force: true });
    } catch {
      // Gone already, or not ours to remove.
    }
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
 *
 * `script`'s stdin is an ordinary pipe, fed from a named pipe we write to.
 * `script` asks its stdin for terminal attributes and only expects ENOTTY:
 * Bun (and Node) hand a child a socketpair for "pipe" stdio, where that fails
 * with EOPNOTSUPP, fatal to BSD script (macOS) and older util-linux —
 * "tcgetattr/ioctl: Operation not supported on socket", and no sign-in link.
 * Recent macOS refuses a named pipe (FIFO) the same way, so neither can be
 * script's stdin; only an ordinary pipe works everywhere, and only `sh` can
 * make one. See PTY_SHELL.
 */
function spawnUnderPty(file: string, args: string[], flow: LoginFlow, isolatedHome?: string): { child: ChildProcess; input: PtyInput } {
  let inherited = buildSubprocessEnv({ prefixes: flow.envPrefixes });
  if (isolatedHome) {
    // A named-account login: nothing of the daemon's own credential may reach
    // it, and it writes into its own staging home only.
    inherited = { ...flow.stripCredentials(inherited), ...flow.homeEnv(isolatedHome) };
  }
  const env = {
    ...inherited,
    // A login command tries to open a browser. On the machine a daemon runs on
    // that is at best useless and at worst a browser nobody asked for on
    // someone's desktop — the user opens the URL we return, on their own
    // machine. Every command tested prints the URL regardless.
    BROWSER: "/bin/true",
    // Terminal UIs size their output to the pty. Fixing it keeps the URL from
    // being wrapped differently on a client with a different terminal, and
    // keeps the transcript deterministic.
    COLUMNS: String(PTY_COLUMNS),
    LINES: "40",
    TERM: "xterm-256color",
  };
  // The pty script makes has no size, so the command wraps at its 80-column
  // fallback whatever COLUMNS says — and a wrapped token (`sk-ant-oat01-…` is
  // ~108 chars) is captured cut short. Size it before the command starts.
  const sized = ["/bin/sh", "-c", `stty cols ${PTY_COLUMNS} rows 40 2>/dev/null; exec "$@"`, "sh", file, ...args];
  const argv =
    process.platform === "darwin"
      ? ["-q", "/dev/null", ...sized]
      : ["-q", "-e", "-c", shellQuote(sized), "/dev/null"];
  const pipeDir = mkdtempSync(join(tmpdir(), INPUT_DIR_PREFIX));
  const fifo = join(pipeDir, "in");
  const made = spawnSync("mkfifo", ["-m", "600", fifo]);
  if (made.status !== 0) {
    rmSync(pipeDir, { recursive: true, force: true });
    throw new BackendLoginError("couldn't create the sign-in command's input pipe (mkfifo failed)");
  }
  // Run in the staging home: an interactive CLI must not load a project's
  // files from the daemon's cwd while signing in.
  const child = spawn("/bin/sh", ["-c", PTY_SHELL, "sh", fifo, ...argv], {
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    ...(isolatedHome ? { cwd: isolatedHome } : {}),
  });
  return { child, input: openPtyInput(fifo, pipeDir, child) };
}

/**
 * `sh -c` body: `$1` is the FIFO, the rest script's argv.
 *
 * `cat` copies the FIFO into an ordinary pipe that is script's stdin. It
 * would outlive script — it waits on the FIFO, whose writer (us) stays open
 * until the command is over, and the command is over only when `sh` exits —
 * so it is stopped by pid when script exits. The pid travels down the pipe
 * itself, as its first line: the left side prints its own pid and becomes
 * `cat` (exec keeps the pid); the right side reads that line before script
 * starts, so script never sees it and the pid is always known in time.
 * Nothing is matched by name. The status is script's.
 */
const PTY_SHELL =
  'f=$1; shift; sh -c \'echo $$; exec cat "$1"\' sh "$f" | { read -r c; script "$@"; s=$?; kill "$c" 2>/dev/null; exit "$s"; }';

/** The write side of a login command's input pipe. */
interface PtyInput {
  write(text: string): void;
  close(): void;
}

/** Prefix of the private dirs holding a login command's input pipe. */
const INPUT_DIR_PREFIX = "codeoid-login-input-";

/**
 * Open the FIFO for writing. The open completes once `cat` opens it for
 * reading (immediately, as it starts); text written before then is queued.
 * If the command dies before ever opening it, the pending open is released by
 * opening the read side ourselves — it would otherwise hold a worker thread.
 */
function openPtyInput(fifo: string, dir: string, child: ChildProcess): PtyInput {
  const stream = createWriteStream(fifo);
  stream.on("error", () => {
    // The reader is gone (the command exited); nothing more to deliver.
  });
  let closed = false;
  const release = () => {
    try {
      closeSync(openSync(fifo, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK));
    } catch {
      // Already opened by the command, or gone.
    }
  };
  child.once("exit", () => {
    release();
    stream.destroy();
  });
  return {
    write(text) {
      if (!closed) stream.write(text);
    },
    close() {
      if (closed) return;
      closed = true;
      release();
      stream.destroy();
      rmSync(dir, { recursive: true, force: true });
    },
  };
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
