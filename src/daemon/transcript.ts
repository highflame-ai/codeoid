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

import { existsSync, mkdirSync } from "node:fs";
import { appendFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
}

/** Tuning knobs, injectable for tests. */
export interface TranscriptStoreOptions {
  /** Rotate the live JSONL past this size. Default 32 MiB. */
  segmentMaxBytes?: number;
  /** Rotated segments kept per session (older ones are deleted). Default 2. */
  maxRotatedSegments?: number;
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
  /** Fork lineage (session.fork). Absent = not a fork. */
  forkedFrom?: { sessionId: string; name: string; atTurn: number };
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
  /** Live-file byte counter per session, so rotation doesn't stat per append.
   * Seeded lazily from the file's on-disk size on the first append. */
  #liveBytes = new Map<string, number>();
  #segmentMaxBytes: number;
  #maxRotatedSegments: number;

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
    ]);
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

    const entry: TranscriptEntry = {
      seq,
      timestamp: "timestamp" in msg ? (msg as { timestamp: string }).timestamp : new Date().toISOString(),
      message: capPersistedToolOutput(msg),
    };

    const line = `${JSON.stringify(entry)}\n`;

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
    this.#appendChain.set(
      sessionId,
      next.finally(() => {
        if (this.#appendChain.get(sessionId) === next) {
          this.#appendChain.delete(sessionId);
        }
      }),
    );
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
    const id = meta.sessionId;
    const prev = this.#metaWriteChain.get(id) ?? Promise.resolve();
    // Absorb the previous write's failure so one rejected write can't skip
    // every write queued behind it — and LOG failures: *.meta.json is the
    // sole restart-resume discovery mechanism, so silent failures here mean
    // sessions vanish on the next restart with zero diagnostic.
    const attempt = prev.then(() => this.#writeMetaAtomic(meta));
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
    // Oldest → newest: [.N, …, .1, live].
    const candidates: string[] = [];
    for (let i = this.#maxRotatedSegments; i >= 1; i--) {
      candidates.push(this.#segmentPath(sessionId, i));
    }
    candidates.push(this.transcriptPath(sessionId));

    // Walk newest-first, keeping files while budget remains; the oldest
    // surviving file may enter mid-way (offset > 0, first partial line
    // dropped by the reader).
    const chosen: Array<{ path: string; offset: number }> = [];
    let budget = opts.maxBytes ?? Number.POSITIVE_INFINITY;
    let skippedBytes = 0;
    for (let i = candidates.length - 1; i >= 0; i--) {
      const f = Bun.file(candidates[i]!);
      if (!(await f.exists())) continue;
      if (budget <= 0) {
        skippedBytes += f.size;
        continue;
      }
      if (f.size <= budget) {
        chosen.unshift({ path: candidates[i]!, offset: 0 });
        budget -= f.size;
      } else {
        skippedBytes += f.size - budget;
        chosen.unshift({ path: candidates[i]!, offset: f.size - budget });
        budget = 0;
      }
    }
    if (skippedBytes > 0) {
      if (opts.stats) opts.stats.truncated = true;
      console.warn(
        `[codeoid] transcript ${sessionId}: replay window capped at ${opts.maxBytes} bytes — ${skippedBytes} bytes of older history left on disk (still exported by share.pack).`,
      );
    }

    // Merge entries by messageId — later entries update earlier ones.
    const byMessageId = new Map<string, TranscriptEntry>();
    const order: string[] = [];
    let sinceDeadlineCheck = 0;

    outer: for (const { path, offset } of chosen) {
      for await (const line of readLines(path, offset)) {
        if (++sinceDeadlineCheck >= DEADLINE_CHECK_EVERY) {
          sinceDeadlineCheck = 0;
          if (opts.deadlineAt !== undefined && Date.now() > opts.deadlineAt) {
            if (opts.stats) opts.stats.truncated = true;
            console.warn(
              `[codeoid] transcript ${sessionId}: resume deadline hit mid-parse — replaying the ${order.length} message(s) merged so far.`,
            );
            break outer;
          }
        }
        if (!line.trim()) continue;
        let entry: TranscriptEntry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue; // Skip corrupted lines
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
          continue;
        }
        const bytes = Buffer.byteLength(line, "utf-8");

        const msg = entry.message;
        const messageId = (msg as { messageId?: string }).messageId;

        if (!messageId) {
          // No messageId (e.g. status_change) — keep as-is with synthetic key
          const key = `_seq_${entry.seq}`;
          byMessageId.set(key, { ...entry, bytes });
          order.push(key);
          continue;
        }

        if (byMessageId.has(messageId)) {
          // Update: merge the newer entry over the older one
          const existing = byMessageId.get(messageId)!;
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
          byMessageId.set(messageId, { ...entry, message: { ...msg as object } as typeof msg, bytes });
          order.push(messageId);
        }
      }
    }

    return order.map((key) => byMessageId.get(key)!);
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
    ]);
    this.#liveBytes.delete(sessionId);

    await rm(this.transcriptPath(sessionId), { force: true });
    await rm(this.metaPath(sessionId), { force: true });
    for (let i = 1; i <= this.#maxRotatedSegments; i++) {
      await rm(this.#segmentPath(sessionId, i), { force: true });
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

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
