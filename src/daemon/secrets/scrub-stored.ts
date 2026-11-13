/**
 * `codeoid secret scrub` (docs/secrets-and-memory-design.md §2.6): rewrite
 * what was stored before secret handling, with values codeoid knows and
 * secrets found by shape replaced by references. Run with the daemon
 * stopped (the caller holds its data locks), so nothing appends meanwhile.
 *
 * Rewrites: every transcript, canonical-history and turn-index log
 * (`<transcriptDir>/*.jsonl`), memory episodes and their full bodies (the
 * FTS index follows by trigger), and dispatch tasks' prompts and result
 * digests. Embeddings are left as they are: a vector holds no recoverable
 * text. A file is replaced whole (written beside it, renamed over), so a
 * crash leaves the old file or the new one, never half of each.
 */

import { Database } from "bun:sqlite";
import { closeSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";

export interface ScrubReport {
  files: number;
  filesChanged: number;
  linesChanged: number;
  episodesChanged: number;
  tasksChanged: number;
}

type ScrubFn = <T>(value: T) => { value: T; changed: boolean };

/** Scrub one JSONL file's lines; returns how many changed. Unparseable lines are scrubbed as text. */
export function scrubJsonlFile(path: string, scrub: ScrubFn, dryRun: boolean): number {
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  let changed = 0;
  const out = lines.map((line) => {
    if (!line) return line;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      const r = scrub(line);
      if (r.changed) changed++;
      return r.value;
    }
    const r = scrub(parsed);
    if (!r.changed) return line;
    changed++;
    return JSON.stringify(r.value);
  });
  if (changed > 0 && !dryRun) replaceFile(path, out.join("\n"));
  return changed;
}

function replaceFile(path: string, content: string): void {
  const tmp = `${path}.scrub-${process.pid}`;
  const mode = statSync(path).mode & 0o777;
  const fd = openSync(tmp, "wx", mode);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** Every `*.jsonl` directly in the transcript dir, and their rotated segments (`<id>.jsonl.1`, …). */
export function scrubTranscripts(dir: string, scrub: ScrubFn, dryRun: boolean): Pick<ScrubReport, "files" | "filesChanged" | "linesChanged"> {
  const report = { files: 0, filesChanged: 0, linesChanged: 0 };
  if (!existsSync(dir)) return report;
  for (const name of readdirSync(dir)) {
    if (!/\.jsonl(?:\.\d+)?$/.test(name)) continue;
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    report.files++;
    const n = scrubJsonlFile(path, scrub, dryRun);
    if (n > 0) {
      report.filesChanged++;
      report.linesChanged += n;
    }
  }
  return report;
}

/** Memory episodes: summary and content (FTS follows by trigger), and full bodies kept apart. */
export function scrubMemoryDb(dbPath: string, scrub: ScrubFn, dryRun: boolean): number {
  if (!existsSync(dbPath)) return 0;
  const db = new Database(dbPath);
  let changed = 0;
  try {
    const update = db.prepare("UPDATE episodes SET summary = ?, content = ? WHERE id = ?");
    const rows = db.prepare("SELECT id, summary, content FROM episodes").all() as Array<{ id: string; summary: string; content: string }>;
    const tx = db.transaction(() => {
      for (const r of rows) {
        const s = scrub(r.summary);
        const c = scrub(r.content);
        if (!s.changed && !c.changed) continue;
        changed++;
        if (!dryRun) update.run(s.value, c.value, r.id);
      }
      const payloads = db.prepare("SELECT episode_id, encoding, data FROM episode_payloads").all() as Array<{ episode_id: string; encoding: string; data: Uint8Array }>;
      const updatePayload = db.prepare("UPDATE episode_payloads SET chars = ?, data = ? WHERE episode_id = ?");
      for (const p of payloads) {
        if (p.encoding !== "zstd") continue;
        const body = Buffer.from(Bun.zstdDecompressSync(p.data)).toString("utf8");
        const r = scrub(body);
        if (!r.changed) continue;
        changed++;
        if (!dryRun) updatePayload.run(r.value.length, Bun.zstdCompressSync(Buffer.from(r.value, "utf8"), { level: 3 }), p.episode_id);
      }
    });
    tx();
    if (changed > 0 && !dryRun) purgeOldCopies(db, ["episodes_fts"]);
  } finally {
    db.close();
  }
  return changed;
}

/**
 * Rewritten rows' old text can stay in the file (free pages, the WAL, FTS
 * segments): merge the full-text index, checkpoint the WAL and rebuild the
 * file, so what was replaced is gone from disk too.
 */
function purgeOldCopies(db: Database, ftsTables: readonly string[]): void {
  for (const t of ftsTables) {
    try {
      db.exec(`INSERT INTO ${t}(${t}) VALUES('optimize')`);
    } catch {
      // No such index here.
    }
  }
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec("VACUUM");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

/** Dispatch tasks' prompts and result digests in the daemon's database (the conductor reads them back). */
export function scrubDispatchTasks(dbPath: string, scrub: ScrubFn, dryRun: boolean): number {
  if (!existsSync(dbPath)) return 0;
  const db = new Database(dbPath);
  let changed = 0;
  try {
    const cols = new Set((db.prepare("PRAGMA table_info(dispatch_tasks)").all() as Array<{ name: string }>).map((c) => c.name));
    if (!cols.has("prompt")) return 0;
    const digest = cols.has("result_digest");
    // Settled tasks only: a queued or running one's prompt is what its worker is sent, as written.
    const rows = db
      .prepare(`SELECT id, prompt${digest ? ", result_digest" : ""} FROM dispatch_tasks WHERE status IN ('done', 'failed', 'blocked', 'cancelled')`)
      .all() as Array<{ id: string; prompt: string | null; result_digest?: string | null }>;
    const update = db.prepare(`UPDATE dispatch_tasks SET prompt = ?${digest ? ", result_digest = ?" : ""} WHERE id = ?`);
    const tx = db.transaction(() => {
      for (const r of rows) {
        const p = r.prompt ? scrub(r.prompt) : { value: r.prompt, changed: false };
        const d = r.result_digest ? scrub(r.result_digest) : { value: r.result_digest ?? null, changed: false };
        if (!p.changed && !d.changed) continue;
        changed++;
        if (!dryRun) {
          if (digest) update.run(p.value, d.value, r.id);
          else update.run(p.value, r.id);
        }
      }
    });
    tx();
    if (changed > 0 && !dryRun) purgeOldCopies(db, []);
  } finally {
    db.close();
  }
  return changed;
}
