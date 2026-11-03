/**
 * The daemon's own directory for what it makes for sandboxes (#448): each
 * session's private temp dir, the launchers that start a backend or a shell
 * line inside one, a check's temp dir. One per daemon process, made private
 * (mkdtemp, 0700) under the daemon's temp dir, and hidden from every sandbox
 * (policy.ts): a session whose workspace is `/tmp` or `/` must not reach
 * another session's temp dir, or rewrite a launcher that would then run
 * outside its sandbox.
 */

import { lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string | null = null;

/** The directory (made on first use; made again, at the same path, if a temp cleaner removed it). */
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

/** Where every launcher lives: `<this>…/launch-<n>` (opencode's shell shim checks the prefix). */
export function launcherRoot(): string {
  return join(sandboxRoot(), "launch-");
}
