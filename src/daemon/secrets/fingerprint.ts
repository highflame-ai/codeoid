/**
 * A detected secret's fingerprint (docs/secrets-and-memory-design.md §2.3):
 * HMAC-SHA256 of the value under a key made once per daemon, truncated to 8
 * hex characters. The same secret seen in three sessions has the same
 * reference; without the key a fingerprint can't be checked against a guess.
 *
 * The key lives in `<config dir>/secrets/fingerprint.key` (0600, in a 0700
 * dir that every sandbox hides and the gate refuses: secretMaterialDir).
 */

import { createHmac, randomBytes } from "node:crypto";
import { closeSync, constants as fsc, fstatSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { join } from "node:path";

/** Where codeoid keeps the keys for secret handling. */
export function secretMaterialDir(configDir: string): string {
  return join(configDir, "secrets");
}

const KEY_BYTES = 32;

/**
 * Read a key file, or make it once: created with O_EXCL, never through a
 * link, so a planted file or link is refused rather than used.
 */
export function loadOrCreateKey(dir: string, name: string): Buffer {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name);
  try {
    const fd = openSync(path, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size !== KEY_BYTES) throw new Error(`${path} isn't a ${KEY_BYTES}-byte key file`);
      const buf = Buffer.alloc(KEY_BYTES);
      if (readSync(fd, buf, 0, KEY_BYTES, 0) !== KEY_BYTES) throw new Error(`${path} couldn't be read whole`);
      return buf;
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const key = randomBytes(KEY_BYTES);
  const fd = openSync(path, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, key);
  } finally {
    closeSync(fd);
  }
  return key;
}

export class Fingerprinter {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    this.#key = key;
  }

  of(value: string): string {
    return createHmac("sha256", this.#key).update(value).digest("hex").slice(0, 8);
  }
}
