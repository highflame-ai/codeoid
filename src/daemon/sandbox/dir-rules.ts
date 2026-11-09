/**
 * The rules a project root or an added directory must meet (project-roots.ts),
 * apart so config.ts can check them at load without the sandbox's policy.
 */

import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { worktreeRootProblem } from "./worktrees.js";

/** A project root entry meaning "the parent of the session's repository" (the default). */
export const PROJECT_ROOT_PARENT = "@parent";

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

// paths: a refusal rule, checked by the path as given and where it leads; a directory it lets through is used by its real path, pinned (project-roots.ts, pinned.ts)
function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export interface DirContext {
  home?: string;
  /** codeoid's config dir: no root is it, in it or holds it. */
  configDir?: string;
  platform?: NodeJS.Platform;
  /** The host's shared temp dirs (default {@link hostTempRoots}): no project root is in one, no added dir is one. */
  tempRoots?: readonly string[];
}

/**
 * The host's shared temp dirs: `/tmp`, `/var/tmp`, `/dev/shm`, the
 * daemon's `TMPDIR`, macOS's (`/private/tmp`, `/var/folders`), each also
 * where it really is. Every program of the user's (and codeoid's private
 * dir) keeps files there: never a project root, nor one inside them, nor an
 * added directory itself.
 */
export function hostTempRoots(): string[] {
  const roots = ["/tmp", "/var/tmp", "/dev/shm", "/private/tmp", "/private/var/tmp", "/var/folders", "/private/var/folders", tmpdir()];
  return [...new Set(roots.flatMap((r) => [resolve(r), realOr(resolve(r))]))];
}

/**
 * Why `dir` can't be a project root or an added directory, or null: it must
 * be absolute (`~` expands), and never `/`, the home or a dir holding it, a
 * hidden dir of the home (`~/.config`, `~/.local`, …: what tools load
 * programs and settings from), `~/Library`, codeoid's config dir, or a
 * system dir (worktrees.ts `worktreeRootProblem`, as written and where it
 * really is), nor one of the host's temp dirs itself ({@link hostTempRoots}).
 */
export function sandboxDirProblem(dir: string, ctx: DirContext = {}): string | null {
  const home = resolve(ctx.home ?? process.env.HOME ?? homedir());
  if (!dir.trim()) return "an empty path";
  const p = expandHome(dir, home);
  if (!isAbsolute(p)) return `${dir} isn't an absolute path`;
  const problem = worktreeRootProblem(p, { home, ...(ctx.configDir ? { configDir: ctx.configDir } : {}), ...(ctx.platform ? { platform: ctx.platform } : {}) });
  if (problem) return problem;
  const temps = ctx.tempRoots ?? hostTempRoots();
  const at = [resolve(p), realOr(resolve(p))];
  if (temps.some((t) => at.includes(t))) return `${dir} is the host's temp dir, shared by every program of yours (and codeoid's private dir)`;
  return null;
}

/**
 * Why `dir` can't be a project root, or null: {@link sandboxDirProblem},
 * and never inside one of the host's temp dirs (what codeoid's private dir,
 * other programs' sockets and sessions' scratch dirs sit beside; under
 * bubblewrap the sandbox's `/tmp` is its own).
 */
export function projectRootProblem(dir: string, ctx: DirContext = {}): string | null {
  const basic = sandboxDirProblem(dir, ctx);
  if (basic) return basic;
  const home = resolve(ctx.home ?? process.env.HOME ?? homedir());
  const p = resolve(expandHome(dir, home));
  const temps = ctx.tempRoots ?? hostTempRoots();
  const temp = temps.find((t) => within(p, t) || within(realOr(p), t));
  return temp ? `${dir} is in the host's temp dir (${temp}), shared by every program of yours (and codeoid's private dir)` : null;
}

/** `~` expanded and resolved: how an added directory or a root is kept. Null when it isn't absolute. */
export function normalizeSandboxDir(dir: string, home: string = process.env.HOME ?? homedir()): string | null {
  const p = expandHome(dir.trim(), resolve(home));
  return isAbsolute(p) ? resolve(p) : null;
}
