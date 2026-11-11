/**
 * JSONL transcript persistence — enables session resume after daemon restart.
 *
 * Production pattern from Claude Code: sessionStorage.ts
 *
 * Each session gets a JSONL file. Every DaemonMessage broadcast to clients is
 * also appended here. On daemon restart, transcripts are replayed to rebuild
 * the scrollback buffer and session state.
 *
 * Design decisions:
 *   - Write before API call (user messages) so crashes don't lose prompts
 *   - Exclude ephemeral progress events from persistence
 *   - Use append-only JSONL — no reads on the hot path
 */

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, read, readFileSync, readSync, statSync } from "node:fs";
import type { WorkstreamBinding } from "./workstreams/binding.js";
import { appendFile, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CanonicalHistoryChange, CanonicalToolCall, CanonicalTurn } from "./providers/canonical.js";
import type { SessionSandboxSetting, TurnSummary } from "../protocol/types.js";
import type { ForkIsolation } from "./fork-isolation.js";

/** One turn in a session's turn index (#354): what `session.turns` lists. */
export type TurnIndexEntry = Pick<TurnSummary, "turnId" | "kind" | "preview" | "startedAt">;

/** Compact the canonical log past this size (keeps the newest half). */
export const CANONICAL_COMPACT_BYTES = 32 * 1024 * 1024;
/** Per-field caps for a persisted canonical turn. */
const CANONICAL_TEXT_CAP = 256 * 1024;
const CANONICAL_TOOL_CAP = 64 * 1024;

function capText(s: string, cap: number): string {
  return s.length > cap ? `${s.slice(0, cap)}\n… [truncated for the history log: ${s.length} chars total]` : s;
}

/** A whole persisted turn never exceeds this (one line of the log). */
const CANONICAL_LINE_CAP = 1024 * 1024;

/** One log line for `turn`: oversized fields capped, then the whole turn. */
function canonicalLine(turn: CanonicalTurn): string {
  const line = cappedLine(turn, CANONICAL_TEXT_CAP, CANONICAL_TOOL_CAP);
  if (line.length <= CANONICAL_LINE_CAP) return line;
  // Many tool calls, each under its own cap, can still add up — squeeze
  // every field, then keep the newest tool calls that fit.
  const squeezed = cappedLine(turn, 32 * 1024, 2 * 1024);
  if (squeezed.length <= CANONICAL_LINE_CAP || turn.role !== "assistant" || !turn.toolCalls) return squeezed;
  const keep = Math.max(1, Math.floor(turn.toolCalls.length * (CANONICAL_LINE_CAP / squeezed.length) * 0.9));
  return cappedLine(
    {
      ...turn,
      content: `${turn.content}\n… [${turn.toolCalls.length - keep} earlier tool calls omitted from the history log]`,
      toolCalls: turn.toolCalls.slice(-keep),
    },
    32 * 1024,
    2 * 1024,
  );
}

function cappedLine(turn: CanonicalTurn, textCap: number, toolCap: number): string {
  let t: CanonicalTurn = turn;
  if (t.role === "user") {
    if (t.content.length > textCap) t = { ...t, content: capText(t.content, textCap) };
  } else {
    const content = capText(t.content, textCap);
    const thinking = t.thinking !== undefined ? capText(t.thinking, textCap) : undefined;
    const toolCalls = t.toolCalls?.map((tc: CanonicalToolCall) => {
      const input = JSON.stringify(tc.input);
      return {
        ...tc,
        output: capText(tc.output, toolCap),
        input: input.length > toolCap ? { truncated: capText(input, toolCap) } : tc.input,
      };
    });
    t = {
      ...t,
      content,
      ...(thinking !== undefined ? { thinking } : {}),
      ...(toolCalls ? { toolCalls } : {}),
    };
  }
  return `${JSON.stringify({ op: "append", turn: t })}\n`;
}
import type {
  CollaborationConfig,
  DaemonMessage,
  SessionInfo,
  SessionMessage,
  SessionStatus,
  SessionWorktree,
} from "../protocol/types.js";

/** Persistent entry in the transcript. */
export interface TranscriptEntry {
  /** Monotonic sequence number for ordering. */
  seq: number;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** The message that was broadcast. */
  message: DaemonMessage;
  /**
   * UTF-8 byte length of the JSONL line this entry was loaded from (of the
   * LAST line, for messages updated across several lines). Populated by
   * loadTranscript only — never persisted. Lets resume seed scrollback size
   * accounting without re-serializing every historical message.
   */
  bytes?: number;
}

/** Byte-budget / deadline knobs for loadTranscript. */
export interface LoadTranscriptOptions {
  /**
   * Read at most this many bytes, taken from the NEWEST end of the log
   * (older segments — and the head of the oldest file that still fits —
   * are skipped). Resume passes the scrollback cap: anything past it would
   * be evicted right after being parsed anyway.
   */
  maxBytes?: number;
  /**
   * Absolute epoch-ms deadline. Checked every few hundred lines DURING the
   * parse (not just between files): when exceeded, parsing stops and the
   * entries merged so far are returned, so one huge transcript can't wedge
   * daemon startup past the resume deadline.
   */
  deadlineAt?: number;
  /**
   * Out-param: the loader sets `truncated: true` when the returned entries
   * are NOT the complete on-disk history (byte budget skipped older
   * segments, or the deadline stopped the parse early). Callers seeding a
   * scrollback buffer use it to mark the buffer as partial so history
   * paging (`scrollback.page`) knows older messages exist on disk.
   */
  stats?: { truncated?: boolean };
  /**
   * Read the log as it was when these marks were taken (`transcriptTail`):
   * each file up to its size then, wherever rotation has moved it since. What
   * a resumed session appended before its scrollback was loaded, which it
   * holds itself (`Session#hydrate`), is left out whatever its seqs.
   */
  asOf?: readonly TranscriptFileMark[];
}

/** One transcript file as it was at a moment: which file (it may be renamed by rotation) and its size then. */
export interface TranscriptFileMark {
  dev: number;
  ino: number;
  size: number;
}

/** Tuning knobs, injectable for tests. */
export interface TranscriptStoreOptions {
  /** Rotate the live JSONL past this size. Default 32 MiB. */
  segmentMaxBytes?: number;
  /** Rotated segments kept per session (older ones are deleted). Default 2. */
  maxRotatedSegments?: number;
  /** Compact a session's canonical-history log past this size (#354). Default 32 MiB. */
  canonicalCompactBytes?: number;
}

const DEFAULT_SEGMENT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_ROTATED_SEGMENTS = 2;
/** Per-line cap on persisted tool output — the transcript is a resume/replay
 * log, not an archival copy of every 10 MB build log a tool ever printed.
 * The in-memory scrollback (and the live broadcast) keep the full output. */
const TOOL_OUTPUT_PERSIST_CAP = 64 * 1024;
/** Lines between deadline checks while parsing a transcript. */
const DEADLINE_CHECK_EVERY = 512;

/** Session metadata stored alongside transcript for fast resume. */
export interface TranscriptMeta {
  /** The session's OS sandbox setting (#448); absent = the daemon's config. */
  sandbox?: SessionSandboxSetting;
  sessionId: string;
  sessionName: string;
  workdir: string;
  createdBy: string;
  createdAt: string;
  lastStatus: SessionStatus;
  lastActivityAt: string;
  accountId: string;
  projectId: string;
  /** "conductor" / "worker" for special sessions; absent = normal. */
  role?: "conductor" | "worker";
  /** Provider id backing the session; absent = claude (pre-upgrade metas). */
  providerId?: string;
  /** The session's own Claude account choice (claude-accounts.ts); absent = follow the daemon default. */
  claudeAccount?: string;
  /** The session's account per backend (accounts.ts); a backend absent = follow its default. */
  accounts?: Record<string, string>;
  /**
   * The backend was reset (a rewind) and has not run a turn since, so it
   * holds no conversation: on resume, re-seed it from the canonical history
   * instead of resuming an empty backing session (#355).
   */
  backingFresh?: boolean;
  /**
   * Backing sessions that hold tool output a tool_result hook redacted from
   * codeoid's record: never forked natively (#387). Persisted the moment a
   * redaction happens, so a crash before the turn ends can't forget it.
   */
  redactedBackings?: string[];
  /** Fork lineage (session.fork). Absent = not a fork. */
  forkedFrom?: { sessionId: string; name: string; atTurn: number };
  /**
   * A fork's boundary and the parent's task ids (fork-isolation.ts), so the
   * parent's background work stays the parent's across a restart. Validated
   * on load (readForkIsolation): it is read back from a file.
   */
  forkIsolation?: ForkIsolation;
  /**
   * The newest background task ids whose settle this session queued or
   * delivered (bounded), so a fork made after a restart doesn't take each of
   * their launches as still running. Validated on load.
   */
  reportedBackgroundTasks?: string[];
  /**
   * The newest ids of this session's own background tasks it has seen
   * running (bounded), so a fork made after a restart (which empties the
   * live set) still finds their launches. Validated on load.
   */
  knownBackgroundTasks?: string[];
  /** Git worktree backing workdir (fork isolation / bind). Absent = shared. */
  worktree?: SessionWorktree;
  /**
   * Collaboration this session orchestrates (goal + role→backend bindings).
   * Absent = a normal session. Stamped here, not just in the sessions table,
   * because meta is what the resume path actually reads.
   */
  collaboration?: CollaborationConfig;
  /**
   * Which collaboration + role this session serves, when it is a child.
   * Written in BOTH saveMeta calls (create and status-persist) — meta is a
   * whole-file overwrite, so a field present in only one of them is erased by
   * the first status transition.
   */
  collaborationRole?: SessionInfo["collaborationRole"];
  /**
   * Home workstream (docs/workstreams-design.md G5). Written in BOTH saveMeta
   * calls, like `collaborationRole`. Validated when read
   * (`readWorkstreamBinding`): it is read from a file.
   */
  workstream?: WorkstreamBinding;
}

/** Types we persist. Skip ephemeral events like heartbeats. */
const PERSISTED_TYPES = new Set([
  "session.message",
  "session.status_change",
]);

export class TranscriptStore {
  #dir: string;
  /**
   * Per-session promise chain for `saveMeta`. setStatus fires many
   * times per turn (working → waiting_approval → working → idle),
   * each as a fire-and-forget `saveMeta`; without serialization two
   * overlapping writes interleave the open(O_WRONLY|O_TRUNC) +
   * write sequence, leaving a truncated JSON file. `loadAllMeta`
   * silently drops unparseable files, so the session goes missing
   * on next restart. Chaining + atomic temp+rename eliminates the
   * window.
   */
  #metaWriteChain = new Map<string, Promise<void>>();
  /** Per-session promise chain for `append()`. See append() docs. */
  #appendChain = new Map<string, Promise<void>>();
  /** Per-session promise chains for the canonical-history log and turn index (#354). */
  #canonicalChain = new Map<string, Promise<void>>();
  #turnIndexChain = new Map<string, Promise<void>>();
  /** Canonical log size per session, seeded lazily from disk. */
  #canonicalBytes = new Map<string, number>();
  /** Live-file byte counter per session, so rotation doesn't stat per append.
   * Seeded lazily from the file's on-disk size on the first append. */
  #liveBytes = new Map<string, number>();
  #segmentMaxBytes: number;
  #maxRotatedSegments: number;
  #canonicalCompactBytes: number;

  constructor(transcriptDir: string, opts: TranscriptStoreOptions = {}) {
    this.#dir = transcriptDir;
    // Sanity-clamp the internal tuning knobs — a zero/negative/fractional
    // value would make rotation thrash or produce unreadable segment paths.
    this.#segmentMaxBytes = Math.max(
      1,
      Math.floor(opts.segmentMaxBytes ?? DEFAULT_SEGMENT_MAX_BYTES),
    );
    this.#maxRotatedSegments = Math.max(
      1,
      Math.floor(opts.maxRotatedSegments ?? DEFAULT_MAX_ROTATED_SEGMENTS),
    );
    this.#canonicalCompactBytes = Math.max(1024, Math.floor(opts.canonicalCompactBytes ?? CANONICAL_COMPACT_BYTES));
    if (!existsSync(this.#dir)) {
      mkdirSync(this.#dir, { recursive: true });
    }
  }

  /**
   * Await all in-flight per-session append + meta writes to settle. The writes
   * are fire-and-forget (append per message, `saveMeta` on every status flip),
   * so without draining them a teardown of the transcript dir — a graceful
   * shutdown, or a test's temp-dir cleanup — races a pending atomic rename and
   * surfaces as an unhandled ENOENT. Call before removing the dir or exiting.
   */
  async flush(): Promise<void> {
    await Promise.allSettled([
      ...this.#metaWriteChain.values(),
      ...this.#appendChain.values(),
      ...this.#canonicalChain.values(),
      ...this.#turnIndexChain.values(),
    ]);
  }

  /** Sessions with a write still in flight (each chain clears itself once its last write settles). */
  get pendingWrites(): number {
    return (
      this.#metaWriteChain.size + this.#appendChain.size + this.#canonicalChain.size + this.#turnIndexChain.size
    );
  }

  // ── Canonical history log (#354) ─────────────────────────────────────────
  //
  // The backend-neutral conversation (CanonicalTurn[]) every fork, backend
  // switch and rewind is built from. It lived only in memory, so after a
  // restart a session showed its scrollback but forked / switched with NO
  // conversation. One JSONL per session: `append` lines grow it, a `replace`
  // (fork seed, rotation reset, rewind) rewrites the file atomically.
  //
  // Bounded on every axis: each turn is capped as it is written (an attached
  // file or a tool's full output can't make one line huge), the file is
  // compacted to its newest turns once it outgrows CANONICAL_COMPACT_BYTES,
  // and resume reads only a tail (`maxBytes`). Lines are serialized at call
  // time, so a caller mutating its history afterwards can't change what is
  // written. Files are owner-only (0600): they hold prompts and tool output.

  /** Directory this store writes into. */
  get dir(): string {
    return this.#dir;
  }

  /** Path to a session's canonical-history log. */
  canonicalPath(sessionId: string): string {
    return join(this.#dir, `${sessionId}.canonical.jsonl`);
  }

  /** Path to a session's turn index (#354). */
  turnIndexPath(sessionId: string): string {
    return join(this.#dir, `${sessionId}.turns.jsonl`);
  }

  /** Persist one canonical-history change. Serialized per session; never throws. */
  recordCanonical(sessionId: string, change: CanonicalHistoryChange): Promise<void> {
    const path = this.canonicalPath(sessionId);
    // Serialize NOW: the caller's arrays may change before the write runs.
    const body =
      change.op === "append"
        ? canonicalLine(change.turn)
        : change.turns.map((t) => canonicalLine(t)).join("");
    const bytes = Buffer.byteLength(body, "utf-8");
    const write = async () => {
      if (change.op === "append") {
        let size = this.#canonicalBytes.get(sessionId);
        if (size === undefined) {
          const f = Bun.file(path);
          size = (await f.exists()) ? f.size : 0;
        }
        await appendFile(path, body, { encoding: "utf-8", mode: 0o600 });
        size += bytes;
        if (size > this.#canonicalCompactBytes) size = await this.#compactCanonical(sessionId);
        this.#canonicalBytes.set(sessionId, size);
      } else {
        await this.#writeAtomic(path, body);
        this.#canonicalBytes.set(sessionId, bytes);
      }
    };
    return this.#chain(this.#canonicalChain, sessionId, write, "canonical log");
  }

  /** Keep the newest turns (≤ half the ceiling, starting at a user turn). Returns the new size. */
  async #compactCanonical(sessionId: string): Promise<number> {
    const { turns } = await this.#readCanonical(sessionId, this.#canonicalCompactBytes / 2);
    const body = turns.map((t) => canonicalLine(t)).join("");
    await this.#writeAtomic(this.canonicalPath(sessionId), body);
    return Buffer.byteLength(body, "utf-8");
  }

  /**
   * Load a session's canonical history, or null when it has no log (a session
   * from before #354). With `maxBytes`, only the newest turns that fit are
   * read (`partial: true` when older ones were left out) — always starting at
   * a user turn. A torn last line (a crash mid-append) is skipped.
   */
  async loadCanonical(
    sessionId: string,
    opts: { maxBytes?: number } = {},
  ): Promise<{ turns: CanonicalTurn[]; partial: boolean } | null> {
    await this.#canonicalChain.get(sessionId);
    if (!(await Bun.file(this.canonicalPath(sessionId)).exists())) return null;
    return this.#readCanonical(sessionId, opts.maxBytes);
  }

  async #readCanonical(sessionId: string, maxBytes?: number): Promise<{ turns: CanonicalTurn[]; partial: boolean }> {
    // A tail must contain at least one whole prompt: widen the window until
    // it does (or covers the file). Otherwise one turn larger than the window
    // reads as an EMPTY history — and compaction would persist that.
    let window = maxBytes;
    for (;;) {
      const r = await this.#readCanonicalOnce(sessionId, window);
      if (!r.partial || r.turns.length > 0 || window === undefined) return r;
      window *= 2;
    }
  }

  async #readCanonicalOnce(sessionId: string, maxBytes?: number): Promise<{ turns: CanonicalTurn[]; partial: boolean }> {
    const path = this.canonicalPath(sessionId);
    const offset = canonicalOffset(Bun.file(path).size, maxBytes);
    const turns: CanonicalTurn[] = [];
    for await (const line of readLines(path, offset)) {
      const turn = canonicalTurnOf(line);
      if (turn) turns.push(turn);
    }
    return canonicalWindow(turns, offset);
  }

  /**
   * `loadCanonical` read synchronously, for a session whose history a
   * synchronous path needs before anything awaited loading it
   * (`Session#hydrateNow`). Doesn't wait for pending writes: the caller only
   * reads a log nothing has appended to in this process.
   */
  loadCanonicalSync(sessionId: string, opts: { maxBytes?: number } = {}): { turns: CanonicalTurn[]; partial: boolean } | null {
    const path = this.canonicalPath(sessionId);
    const size = fileSize(path);
    if (size === null) return null;
    let window = opts.maxBytes;
    for (;;) {
      const offset = canonicalOffset(size, window);
      const turns: CanonicalTurn[] = [];
      for (const line of readLinesSync(path, offset)) {
        const turn = canonicalTurnOf(line);
        if (turn) turns.push(turn);
      }
      const r = canonicalWindow(turns, offset);
      if (!r.partial || r.turns.length > 0 || window === undefined) return r;
      window *= 2;
    }
  }

  /**
   * The newest turn of a session's canonical log, read from the end of the
   * file only: what a resumed session reports (`lastTurnId`, `lastTurnRole`)
   * before its history is loaded. Null when the session has no log;
   * `last: null` for an empty one.
   */
  async canonicalTail(sessionId: string): Promise<{ last: Pick<CanonicalTurn, "role" | "turnId"> | null } | null> {
    await this.#canonicalChain.get(sessionId);
    const path = this.canonicalPath(sessionId);
    if (fileSize(path) === null) return null;
    let last: CanonicalTurn | null = null;
    tailLines(path, (line) => {
      last = canonicalTurnOf(line);
      return last !== null;
    });
    const turn = last as CanonicalTurn | null;
    return { last: turn ? { role: turn.role, ...(turn.turnId !== undefined ? { turnId: turn.turnId } : {}) } : null };
  }

  /** Append one turn-index entry (#354). Serialized per session; never throws. */
  recordTurn(sessionId: string, entry: TurnIndexEntry): Promise<void> {
    const line = `${JSON.stringify(entry)}\n`;
    const path = this.turnIndexPath(sessionId);
    return this.#chain(
      this.#turnIndexChain,
      sessionId,
      () => appendFile(path, line, { encoding: "utf-8", mode: 0o600 }),
      "turn index",
    );
  }

  /** Replace a session's turn index (fork, rewind). */
  replaceTurnIndex(sessionId: string, entries: readonly TurnIndexEntry[]): Promise<void> {
    const body = entries.map((e) => `${JSON.stringify(e)}\n`).join("");
    const path = this.turnIndexPath(sessionId);
    return this.#chain(this.#turnIndexChain, sessionId, () => this.#writeAtomic(path, body), "turn index");
  }

  /** A session's turn index, or null when it has none (a session from before #354). */
  async loadTurnIndex(sessionId: string): Promise<TurnIndexEntry[] | null> {
    await this.#turnIndexChain.get(sessionId);
    const file = Bun.file(this.turnIndexPath(sessionId));
    if (!(await file.exists())) return null;
    return turnIndexOf(await file.text());
  }

  /**
   * `loadTurnIndex` read synchronously (`Session#hydrateNow`). Doesn't wait
   * for pending writes: the caller only reads an index nothing has written
   * to in this process.
   */
  loadTurnIndexSync(sessionId: string): TurnIndexEntry[] | null {
    let text: string;
    try {
      text = readFileSync(this.turnIndexPath(sessionId), "utf-8");
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
    return turnIndexOf(text);
  }

  async #writeAtomic(path: string, body: string): Promise<void> {
    const tmp = `${path}.tmp`;
    await writeFile(tmp, body, { encoding: "utf-8", mode: 0o600 });
    await rename(tmp, path);
  }

  /**
   * Run `write` after the session's previous write in `chains`. The stored
   * promise never rejects (a rejected promise left in the map is an
   * unhandled rejection under Bun), logs failures once, and removes itself
   * when it is the leaf.
   */
  #chain(
    chains: Map<string, Promise<void>>,
    sessionId: string,
    write: () => Promise<void>,
    what: string,
  ): Promise<void> {
    const prev = chains.get(sessionId) ?? Promise.resolve();
    const stored: Promise<void> = prev
      .then(write)
      .catch((err) => {
        console.error(
          `[codeoid] ${what} ${sessionId}: write failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        if (chains.get(sessionId) === stored) chains.delete(sessionId);
      });
    chains.set(sessionId, stored);
    return stored;
  }

  /** Path to a session's live (currently-appended) transcript file. */
  transcriptPath(sessionId: string): string {
    return join(this.#dir, `${sessionId}.jsonl`);
  }

  /** Path to rotated segment `n` (1 = newest rotated, higher = older). */
  #segmentPath(sessionId: string, n: number): string {
    return `${this.transcriptPath(sessionId)}.${n}`;
  }

  /** Path to a session's metadata file. */
  metaPath(sessionId: string): string {
    return join(this.#dir, `${sessionId}.meta.json`);
  }

  /**
   * Append a message to the session's transcript.
   * Non-blocking — uses Bun.write for fast I/O.
   */
  async append(sessionId: string, msg: DaemonMessage, seq: number): Promise<void> {
    if (!PERSISTED_TYPES.has(msg.type)) return;

    const line = transcriptLine(msg, seq);

    // True append. The previous implementation read the entire file
    // and rewrote it with the new line concatenated — O(n) per append,
    // O(n²) over a session lifetime. A 5 000-message session burned
    // tens of MB of write amplification for nothing. `appendFile`
    // resolves to a single open(O_APPEND) + write under the hood.
    //
    // CONCURRENCY: callers fire-and-forget multiple appends per turn
    // with monotonically-increasing `seq`. `appendFile`'s O_APPEND
    // makes individual writes atomic, but the LOGICAL order of
    // overlapping calls isn't guaranteed — so a `seq=42` write can
    // hit disk before `seq=41`'s. `loadTranscript` then merges by
    // messageId in file order; "later" tool state may be replaced
    // by "earlier" state, leaving tool calls stuck `executing` after
    // restart. Chain per-session so writes for the same session
    // serialize. Different sessions still write in parallel.
    const prev = this.#appendChain.get(sessionId) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() => this.#appendWithRotation(sessionId, line));
    // Same shape as saveMeta: the STORED chain absorbs the rejection (callers
    // that fire-and-forget never consume it, and a rejected promise left in
    // the map is an unhandled rejection under Bun) and clears itself once it
    // is the leaf. It used to compare the map entry against `next` — never
    // the stored promise — so entries were never removed, and a failed write
    // escaped as an unhandled rejection. The RETURNED promise still rejects.
    const stored: Promise<void> = next
      .catch(() => undefined)
      .finally(() => {
        if (this.#appendChain.get(sessionId) === stored) this.#appendChain.delete(sessionId);
      });
    this.#appendChain.set(sessionId, stored);
    return next;
  }

  /**
   * Append one line to the live file, rotating it into a numbered segment
   * first when it would exceed the size ceiling. Runs inside the per-session
   * append chain, so the size counter and the rename can't race other writes.
   * Rotation is what keeps both disk usage AND the resume-time read bounded —
   * before it, transcripts grew without bound and were re-read whole.
   */
  async #appendWithRotation(sessionId: string, line: string): Promise<void> {
    const path = this.transcriptPath(sessionId);
    const lineBytes = Buffer.byteLength(line, "utf-8");

    let liveBytes = this.#liveBytes.get(sessionId);
    if (liveBytes === undefined) {
      const f = Bun.file(path);
      liveBytes = (await f.exists()) ? f.size : 0;
    }

    if (liveBytes > 0 && liveBytes + lineBytes > this.#segmentMaxBytes) {
      await this.#rotate(sessionId);
      liveBytes = 0;
    }

    await appendFile(path, line, "utf-8");
    this.#liveBytes.set(sessionId, liveBytes + lineBytes);
  }

  /** Shift segments one slot older (dropping the oldest) and move the live
   * file into slot 1. Retention: live + #maxRotatedSegments segments.
   * Only ENOENT is tolerated (segment not written yet / live file deleted
   * concurrently) — any other rename failure is logged, since silently
   * continuing could overwrite a segment that never shifted. */
  async #rotate(sessionId: string): Promise<void> {
    await rm(this.#segmentPath(sessionId, this.#maxRotatedSegments), { force: true });
    for (let i = this.#maxRotatedSegments - 1; i >= 1; i--) {
      try {
        await rename(this.#segmentPath(sessionId, i), this.#segmentPath(sessionId, i + 1));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error(
            `[codeoid] transcript ${sessionId}: segment shift ${i}→${i + 1} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    try {
      await rename(this.transcriptPath(sessionId), this.#segmentPath(sessionId, 1));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(
          `[codeoid] transcript ${sessionId}: rotate live→1 failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Write a user prompt to the transcript BEFORE the API call.
   * This ensures prompts survive crashes.
   */
  /** @deprecated Use append() directly — session.ts now builds the full SessionMessage. */
  async appendUserPrompt(_sessionId: string, _text: string, _sender: string, _seq: number): Promise<void> {
    // No-op — session.ts now calls persistAndBuffer() which calls append()
  }

  /**
   * Save session metadata for fast resume. Atomic + serialized:
   *
   * - **Atomic.** Writes to `.meta.json.tmp` then `rename`s — POSIX
   *   guarantees rename-over-existing is atomic, so a crash mid-
   *   write leaves either the old or the new file, never a partial
   *   one.
   * - **Serialized per session.** `setStatus` fires fire-and-forget,
   *   often multiple times per turn. Two concurrent `Bun.write`s
   *   used to open+truncate+write twice and interleave; the second
   *   could clobber the first half-written. Chain on the existing
   *   promise so writes for the same session run end-to-end.
   *
   * Different sessions still write in parallel — the chain map is
   * keyed by sessionId.
   */
  async saveMeta(meta: TranscriptMeta): Promise<void> {
    return this.#enqueueMeta(meta.sessionId, () => this.#writeMetaAtomic(meta));
  }

  /**
   * Change only some fields of a session's meta as it is on disk, in the same
   * write chain as `saveMeta` (so it lands after any write queued before it).
   * For resume (workstreams G5): recording a home decided at this resume must
   * not rewrite what the session holds in memory over what the file says.
   * A meta that can't be read is left as it is (the error is logged by the chain).
   */
  async patchMeta(sessionId: string, patch: Partial<Omit<TranscriptMeta, "sessionId">>): Promise<void> {
    return this.#enqueueMeta(sessionId, async () => {
      const current = JSON.parse(await readFile(this.metaPath(sessionId), "utf-8")) as TranscriptMeta;
      await this.#writeMetaAtomic({ ...current, ...patch, sessionId });
    });
  }

  #enqueueMeta(id: string, write: () => Promise<void>): Promise<void> {
    const prev = this.#metaWriteChain.get(id) ?? Promise.resolve();
    // Absorb the previous write's failure so one rejected write can't skip
    // every write queued behind it — and LOG failures: *.meta.json is the
    // sole restart-resume discovery mechanism, so silent failures here mean
    // sessions vanish on the next restart with zero diagnostic.
    const attempt = prev.then(write);
    // The STORED chain absorbs the rejection (fire-and-forget callers never
    // consume it — a rejected promise in the map is an unhandled-rejection
    // crash under Bun) and owns the exactly-once error log. The RETURNED
    // promise still rejects so awaiting callers can react.
    const stored = attempt.catch((err) => {
      console.error(
        `[codeoid/transcript ${id}] meta write failed (sessions may not resume after restart): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
    const chained = stored.finally(() => {
      // Clear the chain entry once this leaf settles, so the map
      // doesn't grow without bound for sessions whose metas land
      // in steady state.
      if (this.#metaWriteChain.get(id) === chained) {
        this.#metaWriteChain.delete(id);
      }
    });
    this.#metaWriteChain.set(id, chained);
    return attempt;
  }

  async #writeMetaAtomic(meta: TranscriptMeta): Promise<void> {
    const path = this.metaPath(meta.sessionId);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(meta, null, 2), "utf-8");
    await rename(tmp, path);
  }

  /**
   * Load all session metadata files — used on daemon restart.
   * Returns sessions that were active when daemon last stopped.
   */
  async loadAllMeta(): Promise<TranscriptMeta[]> {
    const glob = new Bun.Glob("*.meta.json");
    const metas: TranscriptMeta[] = [];

    for await (const path of glob.scan(this.#dir)) {
      try {
        const file = Bun.file(join(this.#dir, path));
        const text = await file.text();
        metas.push(JSON.parse(text));
      } catch {
        // Skip corrupted meta files
      }
    }

    return metas;
  }

  /**
   * Load a session's transcript entries — used for scrollback replay on
   * resume (byte-budgeted, deadline-aware) and by share.pack (unbounded).
   *
   * Entries with the same messageId are applied in order (append-only log).
   * Later entries for the same messageId are updates (e.g. tool state
   * transitions). Returns the final merged state of each unique message.
   *
   * Files are STREAM-parsed line by line (never `file.text()`-ed whole), and
   * with `maxBytes` set, only the newest window of the log is read at all:
   * rotated segments — and the head of the oldest file that straddles the
   * budget — are skipped, since resume's scrollback would evict everything
   * past its cap anyway.
   */
  async loadTranscript(
    sessionId: string,
    opts: LoadTranscriptOptions = {},
  ): Promise<TranscriptEntry[]> {
    const merged = new TranscriptMerge();
    let sinceDeadlineCheck = 0;
    outer: for (const part of this.#transcriptWindow(sessionId, opts)) {
      const lines = part.mark ? this.#readMarked(sessionId, part.mark, part.offset, opts) : readLines(part.path, part.offset);
      for await (const line of lines) {
        if (++sinceDeadlineCheck >= DEADLINE_CHECK_EVERY) {
          sinceDeadlineCheck = 0;
          if (deadlineHit(sessionId, opts, merged.size)) break outer;
        }
        merged.add(line);
      }
    }
    return merged.entries();
  }

  /**
   * `loadTranscript` read synchronously (same window, deadline and merge),
   * for a session whose scrollback a synchronous path needs before anything
   * awaited loading it (`Session#hydrateNow`).
   */
  loadTranscriptSync(sessionId: string, opts: LoadTranscriptOptions = {}): TranscriptEntry[] {
    const merged = new TranscriptMerge();
    let sinceDeadlineCheck = 0;
    outer: for (const part of this.#transcriptWindow(sessionId, opts)) {
      const lines = part.mark ? this.#readMarkedSync(sessionId, part.mark, part.offset, opts) : readLinesSync(part.path, part.offset);
      for (const line of lines) {
        if (++sinceDeadlineCheck >= DEADLINE_CHECK_EVERY) {
          sinceDeadlineCheck = 0;
          if (deadlineHit(sessionId, opts, merged.size)) break outer;
        }
        merged.add(line);
      }
    }
    return merged.entries();
  }

  /**
   * The files (and start offsets) holding the newest `opts.maxBytes` of a
   * session's log, oldest first: the files as they are, or as `opts.asOf`
   * marked them. Sets `opts.stats.truncated` when older history is left out.
   */
  #transcriptWindow(
    sessionId: string,
    opts: LoadTranscriptOptions,
  ): Array<{ path: string; offset: number; mark?: TranscriptFileMark }> {
    // Oldest → newest: [.N, …, .1, live].
    const candidates: Array<{ path: string; size: number; mark?: TranscriptFileMark }> = opts.asOf
      ? opts.asOf.map((mark) => ({ path: "", size: mark.size, mark }))
      : this.#transcriptFiles(sessionId).flatMap((path) => {
          const size = fileSize(path);
          return size === null ? [] : [{ path, size }];
        });

    // Walk newest-first, keeping files while budget remains; the oldest
    // surviving file may enter mid-way (offset > 0, first partial line
    // dropped by the reader).
    const chosen: Array<{ path: string; offset: number; mark?: TranscriptFileMark }> = [];
    let budget = opts.maxBytes ?? Number.POSITIVE_INFINITY;
    let skippedBytes = 0;
    for (let i = candidates.length - 1; i >= 0; i--) {
      const { path, size, mark } = candidates[i]!;
      if (budget <= 0) {
        skippedBytes += size;
        continue;
      }
      if (size <= budget) {
        chosen.unshift({ path, offset: 0, ...(mark ? { mark } : {}) });
        budget -= size;
      } else {
        skippedBytes += size - budget;
        chosen.unshift({ path, offset: size - budget, ...(mark ? { mark } : {}) });
        budget = 0;
      }
    }
    if (skippedBytes > 0) {
      if (opts.stats) opts.stats.truncated = true;
      console.warn(
        `[codeoid] transcript ${sessionId}: replay window capped at ${opts.maxBytes} bytes — ${skippedBytes} bytes of older history left on disk (still exported by share.pack).`,
      );
    }
    return chosen;
  }

  /** A session's log files, oldest first: [.N, …, .1, live]. */
  #transcriptFiles(sessionId: string): string[] {
    const files: string[] = [];
    for (let i = this.#maxRotatedSegments; i >= 1; i--) files.push(this.#segmentPath(sessionId, i));
    files.push(this.transcriptPath(sessionId));
    return files;
  }

  /**
   * Open the file `mark` names, wherever rotation has moved it since: null
   * when it is gone (rotated out of retention; logged, and the read flagged
   * as missing history).
   */
  #openMarked(sessionId: string, mark: TranscriptFileMark, opts: LoadTranscriptOptions): number | null {
    for (const path of this.#transcriptFiles(sessionId).reverse()) {
      let fd: number;
      try {
        fd = openSync(path, "r");
      } catch (err) {
        if (isMissing(err)) continue;
        throw err;
      }
      const st = fstatSync(fd);
      if (st.dev === mark.dev && st.ino === mark.ino) return fd;
      closeSync(fd);
    }
    if (opts.stats) opts.stats.truncated = true;
    console.warn(`[codeoid] transcript ${sessionId}: a file of the log was rotated out before it was read — ${mark.size} bytes of older history left out.`);
    return null;
  }

  /** The lines of the file `mark` names, from `offset` up to its size then. */
  async *#readMarked(
    sessionId: string,
    mark: TranscriptFileMark,
    offset: number,
    opts: LoadTranscriptOptions,
  ): AsyncGenerator<string> {
    const fd = this.#openMarked(sessionId, mark, opts);
    if (fd === null) return;
    try {
      const lines = new LineSplitter(offset > 0);
      const buf = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      for (let pos = offset; pos < mark.size; ) {
        const n = await readAt(fd, buf, Math.min(buf.length, mark.size - pos), pos);
        if (n <= 0) break;
        pos += n;
        yield* lines.push(buf.subarray(0, n));
      }
      yield* lines.end();
    } finally {
      closeSync(fd);
    }
  }

  /** `#readMarked`, synchronously. */
  *#readMarkedSync(sessionId: string, mark: TranscriptFileMark, offset: number, opts: LoadTranscriptOptions): Generator<string> {
    const fd = this.#openMarked(sessionId, mark, opts);
    if (fd === null) return;
    try {
      yield* readFdLinesSync(fd, offset, mark.size);
    } finally {
      closeSync(fd);
    }
  }

  /**
   * The newest end of a session's log, read from the tail of its newest
   * file holding an entry, and a mark of each of its files as they are now
   * (`LoadTranscriptOptions.asOf`): what a resumed session needs to keep
   * appending before its scrollback is loaded, and to load it later exactly
   * as it is now. `nextSeq` is one past the newest entry's seq: the highest
   * in a log whose seqs only grow; one whose seqs went back down (an older
   * daemon restarted them, an import) continues past the highest once its
   * scrollback is loaded (`Session#installHistory`). `hasEntries`: the log
   * holds any entry at all, with a seq or not. Throws when a file is there
   * but can't be read.
   */
  async transcriptTail(sessionId: string): Promise<{ nextSeq: number; hasEntries: boolean; files: TranscriptFileMark[] }> {
    await this.#appendChain.get(sessionId);
    const paths = this.#transcriptFiles(sessionId);
    const files: TranscriptFileMark[] = [];
    for (const path of paths) {
      const st = fileStat(path);
      if (st) files.push({ dev: st.dev, ino: st.ino, size: st.size });
    }
    let hasEntries = false;
    for (let i = paths.length - 1; i >= 0; i--) {
      if (!fileSize(paths[i]!)) continue;
      let newest: number | null = null;
      tailLines(paths[i]!, (line) => {
        const entry = transcriptEntryOf(line);
        if (!entry) return false;
        hasEntries = true;
        if (typeof entry.seq !== "number" || !Number.isFinite(entry.seq)) return false;
        newest = entry.seq;
        return true;
      });
      if (newest !== null) return { nextSeq: (newest as number) + 1, hasEntries, files };
    }
    return { nextSeq: 0, hasEntries, files };
  }

  /**
   * Delete a session's transcript (live file + rotated segments) and metadata.
   */
  async delete(sessionId: string): Promise<void> {
    // Drain this session's in-flight fire-and-forget writes first — a
    // pending append/meta chain settling after the removals below would
    // recreate the file and resurrect the session on the next restart.
    await Promise.allSettled([
      this.#appendChain.get(sessionId),
      this.#metaWriteChain.get(sessionId),
      this.#canonicalChain.get(sessionId),
      this.#turnIndexChain.get(sessionId),
    ]);
    this.#liveBytes.delete(sessionId);
    this.#canonicalBytes.delete(sessionId);

    await rm(this.transcriptPath(sessionId), { force: true });
    for (const p of [this.canonicalPath(sessionId), this.turnIndexPath(sessionId)]) {
      await rm(p, { force: true });
      await rm(`${p}.tmp`, { force: true }); // a crash mid-rewrite leaves this behind
    }
    await rm(this.metaPath(sessionId), { force: true });
    for (let i = 1; i <= this.#maxRotatedSegments; i++) {
      await rm(this.#segmentPath(sessionId, i), { force: true });
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** metadata.event of the durable marker a rewind appends (#355). */
export const REWIND_EVENT = "session.rewound";

/**
 * Apply rewind markers to transcript rows (#355). A marker hides every row
 * from the first row it took back (`metadata.fromMessageId`, the prompt that
 * started the turn) up to the marker — positional, so notices between turns
 * that came after it go too: exactly what the person saw being taken back.
 * The marker stays, as the visible "went back" notice.
 *
 * When that row isn't among `rows` (older than a bounded read, or in a
 * rotated-away segment), fall back to hiding the rows stamped with a removed
 * turn id (`metadata.removedTurnIds`) — never guess by position.
 */
export function applyRewinds<T extends { message: DaemonMessage }>(rows: T[]): T[] {
  let out: T[] = [];
  for (const row of rows) {
    const m = row.message as Partial<SessionMessage>;
    // Only codeoid's own notice counts — never a row some other identity wrote.
    if (m.type === "session.message" && m.metadata?.event === REWIND_EVENT && m.identity?.sub === "system:codeoid") {
      const from = m.metadata.fromMessageId;
      const at = typeof from === "string" ? out.findIndex((r) => (r.message as Partial<SessionMessage>).messageId === from) : -1;
      if (at !== -1) {
        out.length = at;
      } else {
        const removed = new Set(Array.isArray(m.metadata.removedTurnIds) ? (m.metadata.removedTurnIds as string[]) : []);
        out = out.filter((r) => {
          const id = (r.message as Partial<SessionMessage>).turnId;
          return !(id && removed.has(id));
        });
      }
    }
    out.push(row);
  }
  return out;
}

/** A turn index file's entries (torn lines left out). */
function turnIndexOf(text: string): TurnIndexEntry[] {
  const out: TurnIndexEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as TurnIndexEntry;
      if (typeof e.turnId === "string" && (e.kind === "prompt" || e.kind === "background")) out.push(e);
    } catch {
      // torn line
    }
  }
  return out;
}

/** One transcript line for `msg` at `seq`, as `append` writes it. */
function transcriptLine(msg: DaemonMessage, seq: number): string {
  const entry: TranscriptEntry = {
    seq,
    timestamp: "timestamp" in msg ? (msg as { timestamp: string }).timestamp : new Date().toISOString(),
    message: withoutBufferSeq(capPersistedToolOutput(msg)),
  };
  return `${JSON.stringify(entry)}\n`;
}

/**
 * A message without the replay buffer's `seq` stamp: a cursor into one daemon
 * run's scrollback, meaningless once it is read back after a restart (the
 * replay frame's `maxSeq` is the client's cursor), and present or not
 * depending on whether the session's scrollback was in memory when it was
 * appended (lazy session loading).
 */
function withoutBufferSeq(msg: DaemonMessage): DaemonMessage {
  if (msg.type !== "session.message" || (msg as { seq?: number }).seq === undefined) return msg;
  const { seq: _seq, ...rest } = msg as SessionMessage;
  return rest as DaemonMessage;
}

/** A transcript line's entry, or null for a blank, torn or malformed line. */
function transcriptEntryOf(line: string): TranscriptEntry | null {
  if (!line.trim()) return null;
  let entry: TranscriptEntry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null; // Skip corrupted lines
  }
  // Valid JSON isn't necessarily a valid entry — `null`, arrays, or
  // primitives would throw on the field accesses below. Skip them the
  // same way as corrupted lines.
  if (
    entry === null ||
    typeof entry !== "object" ||
    Array.isArray(entry) ||
    typeof entry.message !== "object" ||
    entry.message === null
  ) {
    return null;
  }
  return entry;
}

/**
 * A transcript's lines merged by messageId, in file order — later entries
 * update earlier ones — with rewinds applied (`entries()`).
 */
class TranscriptMerge {
  #byMessageId = new Map<string, TranscriptEntry>();
  #order: string[] = [];

  get size(): number {
    return this.#order.length;
  }

  add(line: string): void {
    const entry = transcriptEntryOf(line);
    if (!entry) return;
    const bytes = Buffer.byteLength(line, "utf-8");

    const msg = entry.message;
    const messageId = (msg as { messageId?: string }).messageId;

    if (!messageId) {
      // No messageId (e.g. status_change) — keep as-is with synthetic key
      const key = `_seq_${entry.seq}`;
      this.#byMessageId.set(key, { ...entry, bytes });
      this.#order.push(key);
      return;
    }

    const existing = this.#byMessageId.get(messageId);
    if (existing) {
      // Update: merge the newer entry over the older one
      const existingMsg = existing.message as unknown as Record<string, unknown>;
      const newMsg = msg as unknown as Record<string, unknown>;

      // Shallow merge — newer fields overwrite older, preserving what's not in the update
      for (const [k, v] of Object.entries(newMsg)) {
        if (v !== undefined) existingMsg[k] = v;
      }
      // Deep merge tool state specifically
      if (newMsg.tool && existingMsg.tool) {
        Object.assign(existingMsg.tool as Record<string, unknown>, newMsg.tool as Record<string, unknown>);
      }
      existing.seq = entry.seq; // update seq to latest
      // The merged message is at least as large as its latest full line —
      // good enough for scrollback's byte accounting.
      existing.bytes = Math.max(existing.bytes ?? 0, bytes);
    } else {
      // First occurrence — insert
      this.#byMessageId.set(messageId, { ...entry, message: { ...msg as object } as typeof msg, bytes });
      this.#order.push(messageId);
    }
  }

  entries(): TranscriptEntry[] {
    // "Went back a turn" (#355): hide what was taken back.
    return applyRewinds(this.#order.map((key) => this.#byMessageId.get(key)!));
  }
}

/** Whether a transcript read ran past its deadline (logged, and flagged in `opts.stats`). */
function deadlineHit(sessionId: string, opts: LoadTranscriptOptions, merged: number): boolean {
  if (opts.deadlineAt === undefined || Date.now() <= opts.deadlineAt) return false;
  if (opts.stats) opts.stats.truncated = true;
  console.warn(
    `[codeoid] transcript ${sessionId}: resume deadline hit mid-parse — replaying the ${merged} message(s) merged so far.`,
  );
  return true;
}

/** A canonical log line's turn, or null for a blank, torn or foreign line. */
function canonicalTurnOf(line: string): CanonicalTurn | null {
  if (!line.trim()) return null;
  try {
    const entry = JSON.parse(line) as { op?: string; turn?: CanonicalTurn };
    if (entry.op === "append" && entry.turn && (entry.turn.role === "user" || entry.turn.role === "assistant")) {
      return entry.turn;
    }
  } catch {
    // torn line
  }
  return null;
}

/** Where a canonical read of the newest `maxBytes` starts. */
function canonicalOffset(size: number, maxBytes: number | undefined): number {
  return maxBytes !== undefined && size > maxBytes ? size - maxBytes : 0;
}

/** The turns read from `offset` on, as a history: a tail starts at a prompt. */
function canonicalWindow(turns: CanonicalTurn[], offset: number): { turns: CanonicalTurn[]; partial: boolean } {
  const partial = offset > 0;
  if (partial) {
    // A tail read may start mid-turn: drop leading assistant turns.
    const firstUser = turns.findIndex((t) => t.role === "user");
    turns.splice(0, firstUser === -1 ? turns.length : firstUser);
  }
  return { turns, partial };
}

/** Bytes read per step by the synchronous and marked readers. */
const READ_CHUNK_BYTES = 1024 * 1024;

/** A missing file (or a missing dir on its path): what the readers treat as no file. */
function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** A regular file's stat, or null when there is none at `path`. Throws when it can't be looked at. */
function fileStat(path: string): import("node:fs").Stats | null {
  let st: import("node:fs").Stats;
  try {
    st = statSync(path);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  return st.isFile() ? st : null;
}

/** A regular file's size, or null when there is none at `path`. Throws when it can't be looked at. */
function fileSize(path: string): number | null {
  return fileStat(path)?.size ?? null;
}

/** `pread`, awaited. */
function readAt(fd: number, buf: Buffer, length: number, position: number): Promise<number> {
  return new Promise((resolve, reject) => {
    read(fd, buf, 0, length, position, (err, n) => (err ? reject(err) : resolve(n)));
  });
}

/**
 * A byte stream cut into lines, as the readers yield them: with `dropFirst`
 * (a read starting mid-file) the first, partial line is left out.
 */
class LineSplitter {
  #decoder = new TextDecoder();
  #remainder = "";
  #dropFirst: boolean;

  constructor(dropFirst: boolean) {
    this.#dropFirst = dropFirst;
  }

  *push(bytes: Uint8Array): Generator<string> {
    this.#remainder += this.#decoder.decode(bytes, { stream: true });
    const lines = this.#remainder.split("\n");
    this.#remainder = lines.pop()!;
    for (const line of lines) {
      if (this.#dropFirst) {
        this.#dropFirst = false;
        continue;
      }
      yield line;
    }
  }

  *end(): Generator<string> {
    this.#remainder += this.#decoder.decode();
    if (this.#remainder && !this.#dropFirst) yield this.#remainder;
  }
}

/** `readLines`, synchronously. */
function* readLinesSync(path: string, offset: number): Generator<string> {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  try {
    yield* readFdLinesSync(fd, offset, Number.POSITIVE_INFINITY);
  } finally {
    closeSync(fd);
  }
}

/** An open file's lines from `offset` up to `end`. */
function* readFdLinesSync(fd: number, offset: number, end: number): Generator<string> {
  const lines = new LineSplitter(offset > 0);
  const buf = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  for (let pos = offset; pos < end; ) {
    const n = readSync(fd, buf, 0, Math.min(buf.length, end - pos), pos);
    if (n <= 0) break;
    pos += n;
    yield* lines.push(buf.subarray(0, n));
  }
  yield* lines.end();
}

/**
 * Hand a file's whole lines to `take`, newest first, reading backwards from
 * its end in growing windows, until `take` returns true or the file's start
 * is reached. For the few newest lines of a log too big to read whole.
 */
function tailLines(path: string, take: (line: string) => boolean): void {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (err) {
    // Gone since it was looked at: nothing to read. Anything else (a file
    // that can't be read) is the caller's to fail on, never an empty log.
    if (isMissing(err)) return;
    throw err;
  }
  try {
    const size = fstatSync(fd).size;
    let window = 64 * 1024;
    for (;;) {
      const start = Math.max(0, size - window);
      const buf = Buffer.allocUnsafe(size - start);
      let read = 0;
      while (read < buf.length) {
        const n = readSync(fd, buf, read, buf.length - read, start + read);
        if (n <= 0) break;
        read += n;
      }
      const lines = buf.subarray(0, read).toString("utf-8").split("\n");
      // Mid-file, the first line is cut: the next, wider window reads it whole.
      const from = start > 0 ? 1 : 0;
      for (let i = lines.length - 1; i >= from; i--) {
        if (take(lines[i]!)) return;
      }
      if (start === 0) return;
      window *= 4;
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Stream a file's lines without materialising the whole file. With
 * `offset > 0` the read starts mid-file and the first (partial) line is
 * dropped — callers slice from a byte budget, not a line boundary.
 */
async function* readLines(path: string, offset: number): AsyncGenerator<string> {
  const file = Bun.file(path);
  const blob = offset > 0 ? file.slice(offset) : file;
  const decoder = new TextDecoder();
  let remainder = "";
  let dropFirst = offset > 0;

  for await (const chunk of blob.stream()) {
    remainder += decoder.decode(chunk, { stream: true });
    const lines = remainder.split("\n");
    remainder = lines.pop()!;
    for (const line of lines) {
      if (dropFirst) {
        dropFirst = false;
        continue;
      }
      yield line;
    }
  }
  remainder += decoder.decode();
  if (remainder && !dropFirst) yield remainder;
}

/**
 * Cap the tool output persisted per transcript line. Tool results routinely
 * carry entire file contents / build logs; persisting them verbatim is the
 * dominant term in transcript growth (up to three lines per tool call, one
 * with the full output). The live broadcast and in-memory scrollback keep
 * the full text — only the on-disk replay copy is trimmed.
 */
function capPersistedToolOutput(msg: DaemonMessage): DaemonMessage {
  if (msg.type !== "session.message") return msg;
  const tool = (msg as SessionMessage).tool;
  if (!tool || tool.state.phase !== "completed") return msg;
  const output = tool.state.output;
  if (typeof output !== "string") return msg;
  // Cap by real UTF-8 bytes, not UTF-16 code units — non-ASCII CLI output
  // (CJK, box-drawing, emoji) would otherwise persist 2-3× past the cap.
  const outputBytes = Buffer.byteLength(output, "utf-8");
  if (outputBytes <= TOOL_OUTPUT_PERSIST_CAP) return msg;
  // The byte slice can split a multi-byte char at the boundary; a non-fatal
  // decode turns that into U+FFFD instead of throwing.
  const truncated = new TextDecoder("utf-8", { fatal: false }).decode(
    Buffer.from(output, "utf-8").subarray(0, TOOL_OUTPUT_PERSIST_CAP),
  );

  return {
    ...msg,
    tool: {
      ...tool,
      state: {
        ...tool.state,
        output: `${truncated}\n… [output truncated for persistence: ${outputBytes} bytes total]`,
      },
    },
  } as DaemonMessage;
}
