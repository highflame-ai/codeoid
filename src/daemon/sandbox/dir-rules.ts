/**
 * The rules a project root or an added directory must meet (project-roots.ts),
 * apart so config.ts can check them at load without the sandbox's policy.
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { worktreeRootProblem } from "./worktrees.js";

/** A project root entry meaning "the parent of the session's repository" (the default). */
export const PROJECT_ROOT_PARENT = "@parent";

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

export interface DirContext {
  home?: string;
  /** codeoid's config dir: no root is it, in it or holds it. */
  configDir?: string;
  platform?: NodeJS.Platform;
}

/**
 * Why `dir` can't be a project root or an added directory, or null: it must
 * be absolute (`~` expands), and never `/`, the home or a dir holding it, a
 * hidden dir of the home (`~/.config`, `~/.local`, …: what tools load
 * programs and settings from), `~/Library`, codeoid's config dir, or a
 * system dir (worktrees.ts `worktreeRootProblem`, as written and where it
 * really is).
 */
export function sandboxDirProblem(dir: string, ctx: DirContext = {}): string | null {
  const home = resolve(ctx.home ?? process.env.HOME ?? homedir());
  if (!dir.trim()) return "an empty path";
  const p = expandHome(dir, home);
  if (!isAbsolute(p)) return `${dir} isn't an absolute path`;
  return worktreeRootProblem(p, { home, ...(ctx.configDir ? { configDir: ctx.configDir } : {}), ...(ctx.platform ? { platform: ctx.platform } : {}) });
}

/** `~` expanded and resolved: how an added directory or a root is kept. Null when it isn't absolute. */
export function normalizeSandboxDir(dir: string, home: string = process.env.HOME ?? homedir()): string | null {
  const p = expandHome(dir.trim(), resolve(home));
  return isAbsolute(p) ? resolve(p) : null;
}

