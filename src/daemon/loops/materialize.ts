/**
 * Git objects read and written out by the daemon itself, for a candidate's
 * checks (docs/loops.md).
 *
 * Neither git's checkout nor its object store is trusted here. A checkout
 * consults the repository's config and attributes, which the worker can write
 * (a smudge filter scoped by `includeIf` survives any override computed for
 * another git directory). And git doesn't re-hash a loose object it reads, so
 * a worker that rewrites one changes what an id means. So every object is
 * read raw through `git cat-file --batch`, which runs nothing, and its content
 * is hashed against its id before it is used. A tree is written file by file
 * from what was verified, and nothing else.
 */

import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { copyFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { GIT_BIN } from "../git-env.js";

export interface TreeEntry {
  /** git's mode: `100644`, `100755`, `120000` (symlink), `160000` (submodule). */
  mode: string;
  oid: string;
}

/** Bounds on one tree, so a hostile object can't exhaust the daemon. */
const LIMITS = { ENTRIES: 500_000, DEPTH: 128, OBJECT_BYTES: 512 * 1024 * 1024, CHECKOUT_BYTES: 8 * 1024 ** 3 } as const;

/** A reply that takes longer than this means git is stuck (a prompt, a hung fetch). */
const READ_TIMEOUT_MS = 120_000;

/**
 * Reads objects through one `git cat-file --batch`, each checked against its
 * id. `env` must locate the repository (GIT_DIR); nothing else of the
 * caller's environment is passed. Requests are written at once and their
 * replies, which git returns in order, parsed in turn, so many reads in
 * flight cost one pipe, not one round trip each. Any failure to follow git's
 * output leaves the reader dead: later reads fail rather than misread.
 */
export class ObjectReader {
  readonly #proc: ChildProcessWithoutNullStreams;
  readonly #env: Record<string, string>;
  readonly #cwd: string;
  /** Unread output, as received: joined only when a reply is complete. */
  #chunks: Buffer[] = [];
  #len = 0;
  readonly #waiting: Array<() => void> = [];
  #closed = false;
  #dead: Error | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(env: Record<string, string>, cwd: string) {
    this.#env = env;
    this.#cwd = cwd;
    this.#proc = spawn(GIT_BIN, ["cat-file", "--batch"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.#proc.stdout.on("data", (chunk: Buffer) => {
      this.#chunks.push(chunk);
      this.#len += chunk.length;
      this.#wake();
    });
    const end = (): void => {
      this.#closed = true;
      this.#wake();
    };
    this.#proc.on("close", end);
    this.#proc.on("error", end);
    this.#proc.stdin.on("error", () => {});
    this.#proc.stderr.resume();
  }

  /** One object, verified. Throws when it is missing or its content doesn't hash to its id. */
  read(oid: string): Promise<{ type: string; data: Buffer }> {
    if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(oid)) return Promise.reject(new Error(`not an object id: ${oid}`));
    if (this.#dead) return Promise.reject(this.#dead);
    this.#proc.stdin.write(`${oid}\n`);
    const next = this.#queue.then(() => this.#readOne(oid));
    this.#queue = next.catch(() => {});
    return next;
  }

  /** Objects' sizes as git reports them — unverified, so only for planning
   *  how much to read at once. */
  async sizes(oids: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (oids.length === 0) return out;
    const { stdout } = await new Promise<{ stdout: string }>((res, rej) => {
      const child = execFile(GIT_BIN, ["cat-file", "--batch-check"], { cwd: this.#cwd, env: this.#env, maxBuffer: 256 * 1024 * 1024 }, (err, stdout) =>
        err ? rej(err) : res({ stdout }),
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(`${oids.join("\n")}\n`);
    });
    for (const line of stdout.split("\n")) {
      const m = /^([0-9a-f]+) \w+ (\d+)$/.exec(line);
      if (m) out.set(m[1]!, Number(m[2]));
    }
    return out;
  }

  close(): void {
    this.#dead ??= new Error("the object reader was closed");
    this.#proc.stdin.end();
    this.#proc.kill();
    this.#wake();
  }

  async #readOne(oid: string): Promise<{ type: string; data: Buffer }> {
    if (this.#dead) throw this.#dead;
    try {
      const header = (await this.#line()).toString("utf8");
      if (header === `${oid} missing`) throw new Error(`object ${oid} is missing`);
      const m = /^([0-9a-f]+) (blob|tree|commit|tag) (\d+)$/.exec(header);
      if (!m || m[1] !== oid) throw new Error(`unexpected object header for ${oid}: ${header.slice(0, 80)}`);
      const size = Number(m[3]);
      if (size > LIMITS.OBJECT_BYTES) throw new Error(`object ${oid} is larger than ${LIMITS.OBJECT_BYTES} bytes`);
      const body = await this.#bytes(size + 1);
      if (body[size] !== 0x0a) throw new Error(`object ${oid}'s reply is malformed`);
      const data = body.subarray(0, size);
      const type = m[2]!;
      const hash = createHash(oid.length === 64 ? "sha256" : "sha1")
        .update(`${type} ${size}\0`)
        .update(data)
        .digest("hex");
      if (hash !== oid) throw new Error(`object ${oid} doesn't hash to its id — the repository's object store was altered`);
      return { type, data };
    } catch (err) {
      // A missing object is a whole reply; anything else may leave us mid-reply.
      if (!(err instanceof Error && err.message.endsWith("is missing"))) {
        this.#dead ??= err instanceof Error ? err : new Error(String(err));
        this.close();
      }
      throw err;
    }
  }

  /** The next line of output, without its newline. */
  async #line(): Promise<Buffer> {
    for (;;) {
      // A header sits at the front; join only what's needed to find its end.
      let seen = 0;
      for (let i = 0; i < this.#chunks.length; i++) {
        const nl = this.#chunks[i]!.indexOf(0x0a);
        if (nl >= 0) {
          const line = this.#take(seen + nl + 1);
          return line.subarray(0, line.length - 1);
        }
        seen += this.#chunks[i]!.length;
        if (seen > 4096) throw new Error("git cat-file sent an over-long header");
      }
      await this.#more();
    }
  }

  /** The next `n` bytes of output, joined once. */
  async #bytes(n: number): Promise<Buffer> {
    while (this.#len < n) await this.#more();
    return this.#take(n);
  }

  #take(n: number): Buffer {
    const parts: Buffer[] = [];
    let need = n;
    while (need > 0) {
      const head = this.#chunks[0]!;
      if (head.length <= need) {
        parts.push(head);
        this.#chunks.shift();
        need -= head.length;
      } else {
        parts.push(head.subarray(0, need));
        this.#chunks[0] = head.subarray(need);
        need = 0;
      }
    }
    this.#len -= n;
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts, n);
  }

  async #more(): Promise<void> {
    if (this.#dead) throw this.#dead;
    if (this.#closed) throw new Error("git cat-file ended early");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((res, rej) => {
        this.#waiting.push(res);
        timer = setTimeout(() => rej(new Error(`git cat-file gave no reply in ${READ_TIMEOUT_MS / 1000}s`)), READ_TIMEOUT_MS);
      });
    } finally {
      clearTimeout(timer);
    }
  }

  #wake(): void {
    for (const w of this.#waiting.splice(0)) w();
  }
}

/** A tree entry's name, refused when it could step out of the checkout or
 *  into git's own files, or can't be written as the bytes it is. */
function safeName(raw: Buffer): string {
  const name = raw.toString("utf8");
  if (!Buffer.from(name, "utf8").equals(raw)) throw new Error(`the tree holds a file name that isn't UTF-8: ${raw.toString("hex")}`);
  // As git's own checks: HFS+ ignores some code points, NTFS trailing dots and spaces.
  const folded = name
    .replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, "")
    .toLowerCase()
    .replace(/[. ]+$/, "");
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || folded === ".git" || folded === "git~1") {
    throw new Error(`the tree holds an entry git itself would refuse: ${JSON.stringify(name)}`);
  }
  return name;
}

/** git's own reading of a mode: legacy group-writable files and padded tree modes. */
function normalMode(mode: string): string | null {
  if (mode === "40000" || mode === "040000") return "40000";
  if (mode === "100644" || mode === "100664") return "100644";
  if (mode === "100755" || mode === "120000" || mode === "160000") return mode;
  return null;
}

/** The commit's tree id, from the verified commit object. */
export async function commitTree(reader: ObjectReader, commit: string): Promise<string> {
  const { type, data } = await reader.read(commit);
  if (type !== "commit") throw new Error(`${commit} is not a commit`);
  const m = /^tree ([0-9a-f]{40}|[0-9a-f]{64})\n/.exec(data.toString("utf8"));
  if (!m) throw new Error(`commit ${commit} has no tree`);
  return m[1]!;
}

/** Every file under `tree` (path → entry), each tree object verified on the way. */
/** How the filesystem a tree is written to compares names. */
export interface NameFolding {
  /** `A` and `a` are one file (macOS, Windows). */
  case: boolean;
  /** Composed and decomposed forms of a name are one file (macOS). */
  unicode: boolean;
}

export async function listTree(reader: ObjectReader, tree: string, folding: NameFolding = { case: false, unicode: false }): Promise<Map<string, TreeEntry>> {
  const out = new Map<string, TreeEntry>();
  // Names are compared as the filesystem will: two that fold to one would
  // land on the same file.
  const folded = new Set<string>();
  const fold = (p: string): string => {
    const n = folding.unicode ? p.normalize("NFC") : p;
    return folding.case ? n.toLowerCase() : n;
  };
  const walk = async (oid: string, prefix: string, depth: number): Promise<void> => {
    if (depth > LIMITS.DEPTH) throw new Error("the tree is nested too deeply");
    const { type, data } = await reader.read(oid);
    if (type !== "tree") throw new Error(`${oid} is not a tree`);
    const idLen = oid.length / 2;
    const subtrees: Array<Promise<void>> = [];
    let i = 0;
    while (i < data.length) {
      const sp = data.indexOf(0x20, i);
      const nul = data.indexOf(0x00, sp + 1);
      if (sp < 0 || nul < 0 || nul + 1 + idLen > data.length) throw new Error(`tree ${oid} is malformed`);
      const mode = normalMode(data.subarray(i, sp).toString("latin1"));
      const name = safeName(data.subarray(sp + 1, nul));
      const child = data.subarray(nul + 1, nul + 1 + idLen).toString("hex");
      i = nul + 1 + idLen;
      if (!mode) throw new Error(`tree ${oid} has an entry of unknown mode`);
      const path = prefix ? `${prefix}/${name}` : name;
      const key = fold(path);
      if (folded.has(key)) throw new Error(`the tree holds two entries that may be the same file: ${JSON.stringify(path)}`);
      folded.add(key);
      if (mode === "40000") {
        const sub = walk(child, path, depth + 1);
        // Settled even if this level throws first: none is left unobserved.
        sub.catch(() => {});
        subtrees.push(sub);
      }
      else {
        out.set(path, { mode, oid: child });
        if (out.size > LIMITS.ENTRIES) throw new Error(`the tree has more than ${LIMITS.ENTRIES} files`);
      }
    }
    await Promise.all(subtrees);
  };
  await walk(tree, "", 0);
  return out;
}

/** Refuse to write through a symlink: every parent of `rel` under `root` must be a real directory (or absent). */
export function assertNoLinkedParent(root: string, rel: string): void {
  const parts = rel.split("/");
  let at = root;
  for (const p of parts.slice(0, -1)) {
    at = join(at, p);
    let st: ReturnType<typeof lstatSync> | undefined;
    try {
      st = lstatSync(at);
    } catch {
      return; // absent: created as a directory
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${rel} would be written through ${at.slice(root.length + 1)}, which isn't a directory`);
  }
}

/** Reads in flight at once while writing a tree, by count and by bytes. */
const WRITE_AHEAD = 32;
const READ_AHEAD_BYTES = 64 * 1024 * 1024;

/**
 * Make `root` hold `to`'s files where it holds `from`'s (null: an empty
 * directory): files `to` dropped are removed, the rest written from their
 * verified blobs. Files `from` never had (what the setup recipe made) are left
 * alone. A submodule is an empty directory. Nothing is removed or written
 * through a symlink, and a blob used at several paths is read once.
 */
export async function writeTree(
  reader: ObjectReader,
  root: string,
  to: Map<string, TreeEntry>,
  from: Map<string, TreeEntry> | null,
  signal?: AbortSignal,
  /** Filled with each written file's stat stamp (see {@link restoreTree}). */
  stamps?: Stamps,
): Promise<void> {
  if (from) {
    for (const [rel, was] of from) {
      const now = to.get(rel);
      if (now && now.mode === was.mode) continue;
      assertNoLinkedParent(root, rel);
      rmSync(join(root, rel), { recursive: true, force: true });
    }
  }
  const byBlob = new Map<string, Array<[string, TreeEntry]>>();
  for (const [rel, entry] of to) {
    const was = from?.get(rel);
    if (was && was.mode === entry.mode && was.oid === entry.oid) continue;
    if (entry.mode === "160000") {
      assertNoLinkedParent(root, rel);
      const at = join(root, rel);
      let real = false;
      try {
        const st = lstatSync(at);
        real = st.isDirectory() && !st.isSymbolicLink();
      } catch {
        // absent
      }
      if (!real) {
        rmSync(at, { recursive: true, force: true });
        mkdirSync(at, { recursive: true });
      }
      continue;
    }
    const list = byBlob.get(entry.oid);
    if (list) list.push([rel, entry]);
    else byBlob.set(entry.oid, [[rel, entry]]);
  }
  let bytes = 0;
  const blobs = [...byBlob.entries()];
  // Reads in flight are bounded by bytes as well as count: their replies are
  // held until written.
  const sizes = await reader.sizes(blobs.map(([oid]) => oid));
  for (let i = 0; i < blobs.length; ) {
    if (signal?.aborted) throw new Error("stopped");
    let end = i;
    let ahead = 0;
    while (end < blobs.length && end - i < WRITE_AHEAD && (end === i || ahead + (sizes.get(blobs[end]![0]) ?? 0) <= READ_AHEAD_BYTES)) {
      ahead += sizes.get(blobs[end]![0]) ?? 0;
      end++;
    }
    const batch = blobs.slice(i, end);
    i = end;
    const read = batch.map(([oid]) => reader.read(oid));
    for (const r of read) r.catch(() => {});
    for (let j = 0; j < batch.length; j++) {
      const { type, data } = await read[j]!;
      const [, uses] = batch[j]!;
      if (type !== "blob") throw new Error(`${uses[0]![0]} is not a blob`);
      bytes += data.length * uses.length;
      if (bytes > LIMITS.CHECKOUT_BYTES) throw new Error(`the tree is larger than ${LIMITS.CHECKOUT_BYTES / 1024 ** 3} GiB`);
      for (const [rel, entry] of uses) {
        assertNoLinkedParent(root, rel);
        const target = join(root, rel);
        mkdirSync(join(target, ".."), { recursive: true });
        rmSync(target, { recursive: true, force: true });
        if (entry.mode === "120000") symlinkSync(utf8(data, rel), target);
        else writeFileSync(target, data, { mode: entry.mode === "100755" ? 0o755 : 0o644 });
        if (stamps) {
          const st = stampOf(target);
          if (st) stamps.set(rel, st);
        }
      }
    }
  }
}

/** Bytes as UTF-8 text, refused when they aren't (a symlink target written lossily would point elsewhere). */
function utf8(data: Buffer, what: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new Error(`${what} isn't UTF-8`);
  }
}

/**
 * Where `rel` under `root` leads once every link on the way is followed, as
 * the kernel would (done by hand, so a link whose end doesn't exist still
 * resolves). Null when the chain is longer than the kernel allows.
 */
export function resolveUnder(root: string, rel: string): string | null {
  const pending = rel.split("/").filter(Boolean);
  let at = root;
  let hops = 0;
  while (pending.length > 0) {
    const part = pending.shift()!;
    if (part === ".") continue;
    if (part === "..") {
      at = dirname(at);
      continue;
    }
    const next = join(at, part);
    let link = false;
    try {
      link = lstatSync(next).isSymbolicLink();
    } catch {
      // Missing: the rest of the path is followed as written.
    }
    if (!link) {
      at = next;
      continue;
    }
    if (++hops > 40) return null;
    const target = readlinkSync(next);
    pending.unshift(...target.split("/").filter(Boolean));
    if (isAbsolute(target)) at = "/";
  }
  return at;
}

/** A file's identity as written: inode, size, times and mode. A file whose
 *  stamp still matches hasn't been touched (ctime can't be set from userspace). */
export type Stamps = Map<string, string>;

function stampOf(path: string): string | null {
  try {
    const st = lstatSync(path, { bigint: true });
    return `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.mode}`;
  } catch {
    return null;
  }
}

/** The file at `rel` is `entry`: its kind, executable bit and content. */
function holds(root: string, rel: string, entry: TreeEntry): boolean {
  const at = join(root, rel);
  let data: Buffer;
  try {
    const st = lstatSync(at);
    if (entry.mode === "120000") {
      if (!st.isSymbolicLink()) return false;
      data = readlinkSync(at, { encoding: "buffer" });
    } else {
      if (!st.isFile()) return false;
      // Another name for the same file could change it later: written anew.
      if (st.nlink > 1) return false;
      if (((st.mode & 0o100) !== 0) !== (entry.mode === "100755")) return false;
      data = readFileSync(at);
    }
  } catch {
    return false;
  }
  const hash = createHash(entry.oid.length === 64 ? "sha256" : "sha1")
    .update(`blob ${data.length}\0`)
    .update(data)
    .digest("hex");
  return hash === entry.oid;
}

/**
 * Put `files` back where anything changed them (the setup command, a check,
 * code a check ran): a file whose stamp still matches is untouched; any other
 * is compared with its blob and, when it differs, written again from verified
 * bytes. Returns what was put back. Yields as it goes, so a large tree doesn't
 * hold up the daemon.
 */
export async function restoreTree(
  reader: () => ObjectReader,
  root: string,
  files: Map<string, TreeEntry>,
  stamps: Stamps,
  signal?: AbortSignal,
): Promise<string[]> {
  const changed = new Map<string, TreeEntry>();
  // A directory on the way that isn't one any more (a file, a link — even to
  // identical files elsewhere) goes, and everything under it is written again.
  const dirs = new Map<string, boolean>();
  const parentsOk = (rel: string): boolean => {
    const parts = rel.split("/").slice(0, -1);
    let at = "";
    for (const p of parts) {
      at = at ? `${at}/${p}` : p;
      let ok = dirs.get(at);
      if (ok === undefined) {
        let st: ReturnType<typeof lstatSync> | undefined;
        try {
          st = lstatSync(join(root, at));
        } catch {
          st = undefined;
        }
        ok = st === undefined || (st.isDirectory() && !st.isSymbolicLink());
        if (!ok) rmSync(join(root, at), { recursive: true, force: true });
        dirs.set(at, ok);
      }
      if (!ok) return false;
    }
    return true;
  };
  let n = 0;
  let read = 0;
  for (const [rel, entry] of files) {
    if (++n % 2_000 === 0 || read > 64 * 1024 * 1024) {
      read = 0;
      await new Promise<void>((res) => setImmediate(res));
      if (signal?.aborted) throw new Error("stopped");
    }
    if (!parentsOk(rel)) {
      changed.set(rel, entry);
      continue;
    }
    if (entry.mode === "160000") {
      try {
        const st = lstatSync(join(root, rel));
        if (st.isDirectory() && !st.isSymbolicLink()) continue;
      } catch {
        // gone: made again
      }
      changed.set(rel, entry);
      continue;
    }
    const now = stampOf(join(root, rel));
    const was = stamps.get(rel);
    if (now !== null && now === was) continue;
    // A different size is a different file; only a same-size change is hashed.
    if (now !== null && was !== undefined && now.split(":")[1] !== was.split(":")[1]) {
      changed.set(rel, entry);
      continue;
    }
    read += Number(now?.split(":")[1] ?? 0);
    if (holds(root, rel, entry)) {
      if (now) stamps.set(rel, now);
      continue;
    }
    changed.set(rel, entry);
  }
  if (changed.size > 0) {
    const r = reader();
    try {
      await writeTree(r, root, changed, null, signal, stamps);
    } finally {
      r.close();
    }
  }
  return [...changed.keys()];
}


/**
 * A directory tree's exact state as a digest: every entry's path, kind,
 * inode, mode, size and change time (which no unprivileged process can set),
 * so any write, rename, create or delete anywhere in it changes the digest.
 * Also the number of entries and bytes. Yields as it goes.
 */
export async function fingerprint(
  root: string,
  signal?: AbortSignal,
  /** Stop early (as changed) past this many entries: a tree grown huge needn't be walked whole. */
  expectEntries?: number,
): Promise<{ digest: string; entries: number; bytes: number; newestCtimeNs: bigint }> {
  const hash = createHash("sha256");
  let bytes = 0;
  let newest = 0n;
  let n = 0;
  const top = lstatSync(root, { bigint: true });
  hash.update(`.\0${top.dev}:${top.ino}:${top.mode}:${top.ctimeNs}\n`);
  const walk = async (rel: string): Promise<void> => {
    const names = readdirSync(join(root, rel)).sort();
    for (const name of names) {
      if (++n % 500 === 0) {
        await new Promise<void>((res) => setImmediate(res));
        if (signal?.aborted) throw new Error("stopped");
      }
      if (expectEntries !== undefined && n > expectEntries) throw new Error("grown");
      const path = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(root, path), { bigint: true });
      hash.update(`${path}\0${st.dev}:${st.ino}:${st.mode}:${st.size}:${st.ctimeNs}\n`);
      if (st.ctimeNs > newest) newest = st.ctimeNs;
      // What it takes on disk: a sparse file counts for its blocks.
      if (st.isFile()) bytes += Number(st.blocks) * 512;
      else if (st.isDirectory()) await walk(path);
    }
  };
  try {
    await walk("");
  } catch (err) {
    if (err instanceof Error && err.message === "grown") return { digest: "grown", entries: n, bytes, newestCtimeNs: newest };
    throw err;
  }
  return { digest: hash.digest("hex"), entries: n, bytes, newestCtimeNs: newest > top.ctimeNs ? newest : top.ctimeNs };
}

/**
 * Copy `src` to `dst` (which must not exist): directories, files (cloned
 * copy-on-write where the filesystem can, with their modes) and symlinks as
 * they are. Anything else (a socket, a FIFO, a device) isn't copied; its path
 * is returned. Yields as it goes, so a large tree doesn't hold up the daemon.
 */
export async function copyTree(src: string, dst: string, signal?: AbortSignal): Promise<string[]> {
  const skipped: string[] = [];
  let n = 0;
  const walk = async (rel: string): Promise<void> => {
    const from = rel ? join(src, rel) : src;
    const to = rel ? join(dst, rel) : dst;
    mkdirSync(to, { mode: lstatSync(from).mode & 0o7777 });
    for (const name of readdirSync(from)) {
      if (++n % 200 === 0) {
        await new Promise<void>((res) => setImmediate(res));
        if (signal?.aborted) throw new Error("stopped");
      }
      const path = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(src, path));
      if (st.isDirectory()) await walk(path);
      else if (st.isSymbolicLink()) symlinkSync(readlinkSync(join(src, path)), join(dst, path));
      else if (st.isFile()) {
        await copyFile(join(src, path), join(dst, path), fsConstants.COPYFILE_FICLONE | fsConstants.COPYFILE_EXCL);
        chmodSync(join(dst, path), st.mode & 0o7777);
      } else skipped.push(path);
    }
  };
  await walk("");
  return skipped;
}

/** The system's cp at a fixed place: one placed earlier on PATH isn't used. */
const CP_BIN = ["/bin/cp", "/usr/bin/cp"].find((p) => existsSync(p)) ?? null;

/**
 * Copy the directory `src` to `dst` (which must not exist) as the system's
 * `cp -a` does — links as links, modes and timestamps kept, cloned
 * copy-on-write where the filesystem can — in a child process, so a large
 * tree doesn't hold up the daemon. Falls back to {@link copyTree} where no
 * such `cp` exists.
 */
export async function copyDir(src: string, dst: string, signal?: AbortSignal): Promise<string[]> {
  // -T (and an absent target on darwin): the copy is `dst`, never a directory inside it.
  const args = process.platform === "linux" ? ["-a", "--reflink=auto", "-T", "--", src, dst] : process.platform === "darwin" ? ["-pRc", src, dst] : null;
  if (!args || !CP_BIN) return copyTree(src, dst, signal);
  let present = true;
  try {
    lstatSync(dst);
  } catch {
    present = false;
  }
  if (present) throw new Error(`${dst} already exists`);
  await new Promise<void>((res, rej) => {
    const child = spawn(CP_BIN, args, { stdio: ["ignore", "ignore", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C" } });
    let err = "";
    child.stderr.on("data", (b: Buffer) => {
      if (err.length < 4_000) err += b.toString("utf8");
    });
    const stop = (): void => {
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", stop, { once: true });
    let fellBack = false;
    child.on("error", (err) => {
      // No cp after all: the daemon copies the tree itself.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        fellBack = true;
        copyTree(src, dst, signal).then(() => res(), rej);
      } else rej(err);
    });
    child.on("close", (code) => {
      if (fellBack) return;
      signal?.removeEventListener("abort", stop);
      if (signal?.aborted) rej(new Error("stopped"));
      else if (code === 0) res();
      else rej(new Error(`copying the prepared check directory failed: ${err.trim().split("\n")[0] ?? `cp exited ${code}`}`));
    });
  });
  return [];
}

/** {@link removeTree} off the daemon's thread for the common case. */
export async function removeTreeAsync(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch {
    removeTree(path);
  }
}

/** Remove a tree even where its directories were made read-only. */
export function removeTree(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
    return;
  } catch {
    // A directory without write permission: open them up, then remove.
  }
  const open = (at: string): void => {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(at);
    } catch {
      return;
    }
    if (!st.isDirectory()) return;
    try {
      chmodSync(at, (st.mode & 0o7777) | 0o700);
    } catch {
      return;
    }
    for (const name of readdirSync(at)) open(join(at, name));
  };
  open(path);
  rmSync(path, { recursive: true, force: true });
}
