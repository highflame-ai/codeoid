/**
 * Secret stores (docs/workstreams-design.md G2): where a named credential's
 * VALUE lives. The rest of the daemon asks a SecretStore by id and never
 * knows which kind it is, so a deployment picks one in config
 * (`credentialStore`) without code changes:
 *
 *  - `env-file` (default): `CODEOID_CRED_<ID>` in the daemon's environment,
 *    which `~/.codeoid/.env` (0600) feeds. The `CODEOID_` prefix is what
 *    keeps every value out of every agent subprocess (providers/env.ts
 *    DENY_PREFIXES) — the guarantee G1 rests on, for free.
 *  - `dir`: one file per credential, named by id, in a directory — a mounted
 *    Kubernetes Secret, a Vault agent sink. Read-only.
 *
 * Values are read when used (a backend spawn, an upstream request), never
 * cached here, so a rotated secret applies at the next use.
 *
 * OAuth tokens are not here: they change on every refresh and have their own
 * store (mcp/oauth.ts, keyed by credential slot).
 */

import { closeSync, constants as fsc, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { SecretStoreConfig } from "./schema.js";

/** Largest secret value read from a file. */
const MAX_SECRET_BYTES = 64 * 1024;

export type SecretStatus = { set: true; source: string } | { set: false };

export interface SecretStore {
  /** Which implementation, for display ("env-file", "dir"). */
  readonly kind: string;
  /** Whether codeoid may write values (the UI offers an edit box only then). */
  readonly writable: boolean;
  /** The value, or undefined when it isn't set. */
  get(id: string): string | undefined;
  /** Whether it is set, and where from — never the value. */
  status(id: string): SecretStatus;
}

/** The env var an id's value lives in: `gh-saucam` → `CODEOID_CRED_GH_SAUCAM`. */
export function credentialEnvName(id: string): string {
  return `CODEOID_CRED_${id.toUpperCase().replace(/-/g, "_")}`;
}

export class EnvFileSecretStore implements SecretStore {
  readonly kind = "env-file";
  readonly writable = true;
  readonly #env: Record<string, string | undefined>;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.#env = env;
  }

  get(id: string): string | undefined {
    const v = this.#env[credentialEnvName(id)];
    return v !== undefined && v.length > 0 ? v : undefined;
  }

  status(id: string): SecretStatus {
    return this.get(id) !== undefined ? { set: true, source: credentialEnvName(id) } : { set: false };
  }
}

export class DirSecretStore implements SecretStore {
  readonly kind = "dir";
  readonly writable = false;
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  get(id: string): string | undefined {
    // Ids are validated (lowercase, digits, dashes), so `id` is one path segment.
    if (!/^[a-z0-9-]{1,64}$/.test(id)) return undefined;
    let fd: number | undefined;
    try {
      // Non-blocking and no final symlink-follow, as every small read here:
      // a FIFO must not hang the daemon. Kubernetes mounts a Secret's keys as
      // links into a timestamped dir, so a final link is followed for this
      // store only — the dir is the operator's, not an agent's.
      fd = openSync(join(this.#dir, id), fsc.O_RDONLY | fsc.O_NONBLOCK);
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > MAX_SECRET_BYTES) return undefined;
      const buf = Buffer.alloc(st.size);
      let off = 0;
      while (off < st.size) {
        const n = readSync(fd, buf, off, st.size - off, off);
        if (n <= 0) break;
        off += n;
      }
      // A trailing newline is how files are written, never part of a token.
      const value = buf.subarray(0, off).toString("utf8").replace(/\r?\n$/, "");
      return value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  status(id: string): SecretStatus {
    return this.get(id) !== undefined ? { set: true, source: join(this.#dir, id) } : { set: false };
  }
}

export function createSecretStore(cfg: SecretStoreConfig | undefined, env: Record<string, string | undefined> = process.env): SecretStore {
  if (cfg?.kind === "dir") return new DirSecretStore(cfg.path);
  return new EnvFileSecretStore(env);
}
