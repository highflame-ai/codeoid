/**
 * Raw-output spill — how the uncompressed output of a compressed command
 * reaches memory.
 *
 * The compressing wrapper runs inside the agent's shell, a separate process
 * from the daemon, and only its (compressed) stdout comes back as the tool
 * result. So the wrapper writes the raw output to a private spill file and
 * names it in the hint line (`raw=<uuid>`); when the daemon turns that tool
 * call into a memory episode, the chunker swaps the raw output in and deletes
 * the file. The agent sees the compressed text; memory keeps every byte.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../../config.js";

/** Where spill files live: `<config dir>/spill`. */
export function defaultSpillDir(): string {
  return join(getConfigDir(), "spill");
}

/** A hint line's raw-output reference. Anchored to the trailing hint so
 *  command output that merely contains the text can't name a file. */
const RAW_REF = /\[codeoid:[^\n]*\braw=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b[^\n]*\]\s*$/;

/** Write `raw` to a new spill file (0600, in a 0700 dir). Returns its id, or
 *  null when it can't be written — compression then proceeds without it. */
export function writeSpill(raw: string, dir: string): string | null {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    writeFileSync(join(dir, `${id}.out`), raw, { mode: 0o600 });
    return id;
  } catch {
    return null;
  }
}

/**
 * If `output` ends with a hint naming a spill file, read and delete that file
 * and return its raw contents. Null when there is no reference or the file
 * is gone.
 */
export function takeSpill(output: string, dir: string): string | null {
  const m = RAW_REF.exec(output);
  if (!m) return null;
  const path = join(dir, `${m[1]}.out`);
  try {
    const raw = readFileSync(path, "utf8");
    try {
      unlinkSync(path);
    } catch {
      /* already gone — the content is what matters */
    }
    return raw;
  } catch {
    return null;
  }
}

/** Delete spill files older than `maxAgeMs` — outputs whose tool call never
 *  became an episode (the session died first). Returns how many went. */
export function pruneSpill(dir: string, maxAgeMs: number, now = Date.now()): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.endsWith(".out")) continue;
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > maxAgeMs) {
        unlinkSync(path);
        removed++;
      }
    } catch {
      /* raced with takeSpill — fine */
    }
  }
  return removed;
}
