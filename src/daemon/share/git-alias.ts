/**
 * Resolve a stable cross-machine "alias" for a workdir, derived from
 * git remote when possible. The alias is what we rewrite absolute paths
 * to during export, so a teammate can re-anchor on import.
 *
 * Resolution order:
 *
 *   1. `git remote get-url origin` — host/path normalized:
 *        github.com:saucam/codeoid.git  → github.com/saucam/codeoid
 *        https://github.com/saucam/codeoid.git → github.com/saucam/codeoid
 *      Best signal — same alias across worktrees + clones of the same repo.
 *   2. `git rev-parse --show-toplevel` basename — when there's a repo but
 *      no `origin` remote (rare).
 *   3. The workdir's basename, prefixed `local:` so it's clear there's
 *      no shared identity. Two unrelated machines would still share the
 *      label "local:foo" but the importer's manifest preview surfaces
 *      that ambiguity.
 *
 * No path leakage in the alias — we never include absolute file paths.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { GIT_BIN, gitEnv } from "../git-env.js";

const execFileP = promisify(execFile);

export interface AliasResolution {
  alias: string;
  source:
    | "git-remote"
    | "git-toplevel-basename"
    | "directory-name"
    | "explicit";
}

export async function resolveWorkdirAlias(
  workdir: string,
  override?: string,
): Promise<AliasResolution> {
  if (override && override.trim().length > 0) {
    return { alias: normaliseAlias(override.trim()), source: "explicit" };
  }
  const remote = await tryGit(workdir, ["remote", "get-url", "origin"]);
  if (remote) {
    const fromRemote = remoteToAlias(remote);
    if (fromRemote) return { alias: fromRemote, source: "git-remote" };
  }
  const top = await tryGit(workdir, ["rev-parse", "--show-toplevel"]);
  if (top) {
    return {
      alias: `local:${path.basename(top)}`,
      source: "git-toplevel-basename",
    };
  }
  return {
    alias: `local:${path.basename(workdir.replace(/\/+$/, ""))}`,
    source: "directory-name",
  };
}

/**
 * Canonicalise a remote URL into a portable alias.
 *
 *   git@github.com:saucam/codeoid.git           → github.com/saucam/codeoid
 *   https://github.com/saucam/codeoid.git       → github.com/saucam/codeoid
 *   ssh://git@github.com/saucam/codeoid         → github.com/saucam/codeoid
 *   /home/me/Workspace/codeoid                  → null (file:// — too local)
 *   anything else                               → null
 */
export function remoteToAlias(remote: string): string | null {
  const trimmed = remote.trim();
  if (!trimmed) return null;

  // git@host:owner/repo.git
  const sshShort = trimmed.match(/^[\w.-]+@([\w.-]+):(.+?)(?:\.git)?\/?$/);
  if (sshShort) {
    return `${sshShort[1]}/${sshShort[2]!.replace(/\/+$/, "")}`;
  }

  // url://[user@]host[:port]/owner/repo.git
  try {
    const url = new URL(trimmed);
    if (url.protocol === "file:") return null;
    const host = url.hostname;
    const pathname = url.pathname.replace(/^\/+/, "").replace(/\.git\/?$/, "");
    if (!host || !pathname) return null;
    return `${host}/${pathname}`;
  } catch {
    return null;
  }
}

function normaliseAlias(s: string): string {
  return s.replace(/^\/+/, "").replace(/\/+$/, "");
}

async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileP(GIT_BIN, args, {
      cwd,
      // The session's repository: never the daemon's environment.
      env: gitEnv(),
      timeout: 2_000,
    });
    const out = stdout.trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}
