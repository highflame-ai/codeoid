/**
 * Reading a file the daemon can't trust to be a file (one an agent may write: a repository's git records, a
 * workspace's settings, a backend's home) on the daemon's thread. A FIFO there would hold a blocking read for ever
 * (and every session with it), and a type check before the read can lose a race to one put in its place: so the file
 * is opened without blocking and judged by what was opened.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

/**
 * A regular file's bytes, read without blocking: opened `O_NONBLOCK` (a link followed, as `readFileSync` does), judged
 * by `fstat` on what was opened, at most `max` bytes. Throws as `readFileSync` does for a missing or unreadable file,
 * and for one that isn't a regular file or is larger than `max`.
 */
// paths: an open (non-blocking) and a bounded read, no write
export function readRegularSync(p: string, max = 16 << 20, o: { noFollow?: boolean } = {}): Buffer {
  const fd = openSync(p, constants.O_RDONLY | constants.O_NONBLOCK | (o.noFollow ? constants.O_NOFOLLOW : 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw Object.assign(new Error(`${p} isn't a regular file`), { code: "ENOTREG" });
    if (st.size > max) throw Object.assign(new Error(`${p} is larger than ${max} bytes`), { code: "EFBIG" });
    const buf = Buffer.alloc(st.size);
    let at = 0;
    while (at < st.size) {
      const n = readSync(fd, buf, at, st.size - at, at);
      if (n <= 0) break;
      at += n;
    }
    return buf.subarray(0, at);
  } finally {
    closeSync(fd);
  }
}

/** The text of a regular file, read as `readRegularSync` does. */
export function readRegularTextSync(p: string, max?: number, o?: { noFollow?: boolean }): string {
  return readRegularSync(p, max, o).toString("utf8");
}
