/**
 * The daemon's own directory for what it makes for sandboxes (#448): each
 * session's private temp dir, the launchers that start a backend or a shell
 * line inside one, a check's temp dir — and every other temp entry of the
 * daemon's ({@link daemonTempDir}: sign-in homes, a check's artifacts, a
 * loop's index, pi's bridge). One per daemon process, made private
 * (mkdtemp, 0700) under the daemon's temp dir at its start, and hidden from
 * every sandbox (policy.ts): a session whose workspace is `/tmp` or `/` must
 * not reach another session's temp dir, or rewrite a launcher that would then
 * run outside its sandbox, and Claude's own sandbox, which keeps the host's
 * `/tmp`, must not read a sign-in made while it runs.
 */

import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string | null = null;

/** The directory (made on first use; made again, at the same path, if a temp cleaner removed it). */
// paths: the daemon's private dir: made 0700 by it, exclusive, never a link, which no sandbox sees
export function sandboxRoot(): string {
  if (!root) {
    const made = mkdtempSync(join(tmpdir(), "codeoid-sandbox-"));
    root = made;
    // Gone with the daemon (a killed one's stays until the OS cleans its temp dir).
    process.once("exit", () => {
      try {
        rmSync(made, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    });
    return root;
  }
  try {
    const st = lstatSync(root);
    if (st.isDirectory() && !st.isSymbolicLink() && (typeof process.getuid !== "function" || st.uid === process.getuid())) return root;
    throw new Error(`${root} isn't this daemon's directory any more`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // Exclusive: if someone else made it meanwhile, this throws rather than use theirs.
    mkdirSync(root, { mode: 0o700 });
    return root;
  }
}

/** The root, when it has been made (for the hidden list: nothing to hide before). */
export function sandboxRootIfMade(): string | null {
  return root;
}

/**
 * A fresh private dir of the daemon's own, `<root>/<prefix>XXXXXX`: under the
 * root every sandbox hides, whenever it is made (a sign-in started after a
 * session's sandbox was built is hidden from it too).
 // paths: the daemon's private dir (sandboxRoot)
 */
export function daemonTempDir(prefix: string): string {
  return mkdtempSync(join(sandboxRoot(), prefix));
}

/** A path for a temp file of the daemon's own (not made), under the root every sandbox hides. */
export function daemonTempPath(name: string): string {
  return join(sandboxRoot(), name);
}

// paths: a look at the host's temp dir for daemons' private dirs, no write
/** Every daemon's root in `tmp` (this one's, another's, a killed one's): `codeoid-sandbox-*`. */
export function sandboxRootsIn(tmp: string = tmpdir()): string[] {
  try {
    return readdirSync(tmp)
      .filter((n) => n.startsWith("codeoid-sandbox-"))
      .map((n) => join(tmp, n));
  } catch {
    return [];
  }
}

/** Where every launcher lives: `<this>…/launch-<n>` (opencode's shell shim checks the prefix). */
export function launcherRoot(): string {
  return join(sandboxRoot(), "launch-");
}
