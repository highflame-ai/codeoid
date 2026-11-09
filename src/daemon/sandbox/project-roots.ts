/**
 * Working across repositories (#448 follow-up, docs/sandbox.md "Working
 * across repositories"): what a session may read besides its workspace, and
 * what it may write.
 *
 *   - project roots (`sandbox.projectRoots`, a session's own at create):
 *     readable whole, read-only. The default, {@link PROJECT_ROOT_PARENT}, is
 *     the parent of the session's repository (`~/Workspace` for a session in
 *     `~/Workspace/codeoid`), so its commands read the other repositories
 *     there, and see what other sessions did in their checkouts; a workspace
 *     in no repository has none. What the sandbox hides anywhere stays hidden
 *     in them (credential stores, codeoid's own dirs, the agents' logins,
 *     container sockets), and so do the credential files anywhere in them
 *     ({@link projectRootSecrets}: a root too big to look through isn't used);
 *   - added directories (`SessionSandboxSetting.addedDirs`): writable, each
 *     as a workspace is (its git structure and project settings held, its
 *     own worktree folder), and so is every repository and settings dir
 *     inside one ({@link nestedControl}). Kept by their real path, taken when
 *     granted ({@link addedDirReal}), and dropped when that no longer is a
 *     directory ({@link stillRealDir}). Added by the owner, or asked for by
 *     the agent (`request_directory`, request-directory.ts; in autonomous
 *     mode only {@link autonomousGrantProblem}'s).
 *
 * Neither may be a place whose contents run outside the sandbox, the home or
 * `/` ({@link sandboxDirProblem}), nor a root the host's temp dir
 * ({@link projectRootProblem}); an added one, nothing the sandbox hides, nor
 * a git or project settings dir ({@link addedDirProblem}).
 */

import { type Dirent, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { hooksPathOf } from "./git-watch.js";
import { gitDirShape, gitLayoutOf, PROJECT_CONFIG_DIRS, PROJECT_CONFIG_FILES } from "./policy.js";
import { type DirContext, hostTempRoots, normalizeSandboxDir, PROJECT_ROOT_PARENT, projectRootProblem, sandboxDirProblem } from "./dir-rules.js";
import { mainCheckoutOf, worktreeLocationDirs } from "./worktrees.js";

export { type DirContext, hostTempRoots, normalizeSandboxDir, PROJECT_ROOT_PARENT, projectRootProblem, sandboxDirProblem };

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

function lexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Dirs a scan doesn't go into: dependencies and build caches, too many to look through (docs/sandbox.md, Limits). */
export const SCAN_SKIPPED_DIRS: ReadonlySet<string> = new Set(["node_modules", ".venv", "__pycache__", ".tox", ".gradle", ".next", ".turbo"]);

/** How many directories an added dir's look for repositories and settings goes through ({@link nestedControl}). */
export const ADDED_DIR_SCAN_LIMIT = 20_000;
/** How many directories of each project root the look for credential files goes through ({@link projectRootSecrets}). */
export const PROJECT_ROOT_SCAN_LIMIT = 20_000;

/** The first component of `p` as written (absolute) that is a symbolic link, or null (none, or a missing one first). */
export function linkInPath(p: string): string | null {
  let at = "";
  for (const part of resolve(p).split("/").filter(Boolean)) {
    at += `/${part}`;
    try {
      if (lstatSync(at).isSymbolicLink()) return at;
    } catch {
      return null;
    }
  }
  return null;
}

/** Where `dir` (`~` expanded; absolute) really is, or null when it isn't there: what is stored and bound when it is added. */
export function addedDirReal(dir: string, home: string = process.env.HOME ?? homedir()): string | null {
  const abs = normalizeSandboxDir(dir, home);
  if (abs === null) return null;
  try {
    return realpathSync(abs);
  } catch {
    return null;
  }
}

/**
 * Whether the added dir kept at `stored` (its real path when granted) is
 * still a directory there, reached through no link: one replaced by a link,
 * or removed, is dropped (said on the session), never followed.
 */
export function stillRealDir(stored: string): boolean {
  const at = resolve(stored);
  if (linkInPath(at) !== null) return false;
  try {
    return lstatSync(at).isDirectory() && realpathSync(at) === at;
  } catch {
    return false;
  }
}

/**
 * Why `real` (a real path) is a dir whose contents git or an agent CLI runs
 * outside the sandbox, or null: a project settings dir or one inside it
 * (`.claude/`, `.codex/`, …: PROJECT_CONFIG_DIRS), a `.git` or `.hg`
 * dir or one inside it, a git dir by its shape (a bare repository, a
 * worktree's admin dir, a submodule's), or the repository's `core.hooksPath`
 * dir or one inside it.
 */
export function controlDirProblem(real: string, home: string = process.env.HOME ?? homedir()): string | null {
  const at = resolve(real);
  const parts = at.split("/").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i] as string;
    const path = `/${parts.slice(0, i + 1).join("/")}`;
    if (PROJECT_CONFIG_DIRS.includes(name)) {
      return `${path === at ? `${at} is` : `${at} is in`} a project settings dir (${path}), which agent CLIs run code from outside the sandbox`;
    }
    if (name === ".git" || name === ".hg") return `${path === at ? `${at} is` : `${at} is in`} a repository's ${name} dir (${path}), which git runs code from outside the sandbox`;
  }
  for (let dir = at; ; dir = dirname(dir)) {
    if (gitDirShape(dir)) return `${dir === at ? `${at} is` : `${at} is in`} a git dir (${dir}), which git runs code from outside the sandbox`;
    if (dirname(dir) === dir) break;
  }
  const layout = gitLayoutOf(at, home);
  if (layout?.common) {
    const top = mainCheckoutOf(layout) ?? dirname(layout.dotgit);
    const hooks = hooksPathOf([join(layout.common, "config"), join(layout.common, "config.worktree"), ...(layout.own ? [join(layout.own, "config.worktree")] : [])]);
    if (hooks) {
      const dir = realOr(hooks.startsWith("~/") ? join(home, hooks.slice(2)) : resolve(top, hooks));
      if (within(at, dir)) return `${at === dir ? `${at} is` : `${at} is in`} the repository's hooks dir (core.hooksPath ${hooks}), which git runs outside the sandbox`;
    }
  }
  return null;
}

/** What an added dir holds that runs outside the sandbox: each held read-only as the workspace's own are (policy.ts). */
export interface NestedControl {
  /** The top of each repository inside it (a dir with a `.git`), the added dir's own included when it is one. */
  repos: string[];
  /** Bare repositories (git dirs by their shape) inside it: held read-only whole. */
  gitDirs: string[];
  /** Project settings dirs and files inside it (PROJECT_CONFIG_DIRS, PROJECT_CONFIG_FILES), at any depth. */
  settings: string[];
  /** False when the look stopped at its bound, or at a dir of yours it couldn't read: then the dir isn't added. */
  complete: boolean;
}

/**
 * What `dir` holds that git or an agent CLI runs outside the sandbox: every
 * repository, bare git dir and project settings dir or file in it, looked
 * for through its directories (not through links, not in a repository's
 * git dir, not in {@link SCAN_SKIPPED_DIRS}), at most `limit` of them.
 */
export function nestedControl(dir: string, limit = ADDED_DIR_SCAN_LIMIT): NestedControl {
  const out: NestedControl = { repos: [], gitDirs: [], settings: [], complete: true };
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const queue = [resolve(dir)];
  let seen = 0;
  while (queue.length > 0) {
    const d = queue.shift() as string;
    if (gitDirShape(d)) {
      out.gitDirs.push(d);
      continue;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      // One of yours unreadable now could be made readable (and written) from inside: not looked through, not added.
      try {
        if (uid === null || lstatSync(d).uid === uid) out.complete = false;
      } catch {
        /* gone meanwhile */
      }
      if (!out.complete) return out;
      continue;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const at = join(d, e.name);
      if (e.name === ".git") {
        out.repos.push(d);
        continue;
      }
      if (PROJECT_CONFIG_DIRS.includes(e.name) && e.isDirectory()) {
        out.settings.push(at);
        continue;
      }
      if (PROJECT_CONFIG_FILES.includes(e.name) && e.isFile()) {
        out.settings.push(at);
        continue;
      }
      if (!e.isDirectory() || e.name === ".hg" || SCAN_SKIPPED_DIRS.has(e.name)) continue;
      if (++seen > limit) {
        out.complete = false;
        return out;
      }
      queue.push(at);
    }
  }
  return out;
}

export interface AddedDirContext extends DirContext {
  /** What every sandbox hides (policy.ts `hiddenPathsFor`): an added dir is never in one. */
  hidden?: readonly string[];
  /** The daemon's `PATH`: a dir on it (or holding an entry of it) runs outside the sandbox. */
  path?: string;
  /** {@link nestedControl}'s bound (tests). */
  scanLimit?: number;
}

/**
 * Why `dir` can't be added to a session's writable directories, or null:
 * {@link sandboxDirProblem}, then where it really is must be a directory of
 * the daemon's user, outside everything the sandbox hides, holding no dir of
 * the daemon's `PATH` (a program written there runs outside any sandbox at
 * the user's next command), neither a git nor a project settings dir nor
 * inside one ({@link controlDirProblem}), and small enough that every
 * repository and settings dir in it is found ({@link nestedControl}).
 */
export function addedDirProblem(dir: string, ctx: AddedDirContext = {}): string | null {
  const basic = sandboxDirProblem(dir, ctx);
  if (basic) return basic;
  const home = resolve(ctx.home ?? process.env.HOME ?? homedir());
  const abs = normalizeSandboxDir(dir, home) as string;
  const real = addedDirReal(abs, home);
  if (real === null) return `${dir} doesn't exist`;
  if (real !== abs) {
    const again = sandboxDirProblem(real, ctx);
    if (again) return `${dir} leads to ${real}, which ${again.startsWith(`${real} `) ? again.slice(real.length + 1) : `can't be added: ${again}`}`;
  }
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(real);
  } catch {
    return `${dir} doesn't exist`;
  }
  if (!st.isDirectory()) return `${dir} isn't a directory`;
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) return `${dir} isn't yours (another user owns it)`;
  for (const h of ctx.hidden ?? []) {
    const hr = realOr(h);
    // In one: what is hidden isn't the session's to write. Holding one is fine: it stays hidden inside.
    if (within(abs, h) || within(real, hr)) return `${dir} is in what the sandbox hides (${h})`;
  }
  for (const entry of (ctx.path ?? process.env.PATH ?? "").split(":")) {
    if (!entry || !isAbsolute(entry)) continue;
    if (within(resolve(entry), abs) || within(realOr(entry), real)) return `${dir} holds ${entry}, which is on your PATH: a program written there would run outside the sandbox`;
  }
  const control = controlDirProblem(real, home);
  if (control) return control;
  const limit = ctx.scanLimit ?? ADDED_DIR_SCAN_LIMIT;
  if (!nestedControl(real, limit).complete) {
    return `${dir} holds more than ${limit} directories to look through for repositories and project settings (${[...SCAN_SKIPPED_DIRS].slice(0, 2).join(", ")} and the like aside), or one of yours that can't be read: what is in it couldn't all be protected — add the repositories you need one by one`;
  }
  return null;
}

/**
 * Why the agent's own `request_directory` can't be granted unasked in
 * autonomous mode (an unattended run's too), or null. Beyond
 * {@link addedDirProblem}: the path as written goes through no link
 * (`written`), and where it really is (`real`) is strictly inside one of
 * the session's project roots and inside a repository's checkout (its top,
 * or a dir in it): a folder holding repositories, a root itself, or
 * anything else is the owner's to add.
 */
export function autonomousGrantProblem(written: string, real: string, roots: readonly string[], home: string = process.env.HOME ?? homedir()): string | null {
  const link = linkInPath(written);
  if (link) return `${written} goes through a symbolic link (${link}); in autonomous mode a directory is added only by its real path`;
  const inside = roots.some((r) => {
    const rr = realOr(resolve(r));
    return within(real, rr) && real !== rr;
  });
  if (!inside) return `${real} isn't under this session's project roots (${roots.length > 0 ? roots.join(", ") : "none"}); in autonomous mode nothing else is added`;
  const layout = gitLayoutOf(real, home);
  const top = layout?.common ? (layout.kind === "worktree" || layout.kind === "submodule" ? dirname(layout.dotgit) : (mainCheckoutOf(layout) ?? dirname(layout.dotgit))) : null;
  if (!top || !within(real, realOr(top))) return `${real} isn't in a repository; in autonomous mode only a repository under a project root (or a directory in one) is added`;
  return null;
}

/** A checkout another session works in (its workspace, a worktree folder of its): what an autonomous grant never touches. */
export interface OtherCheckout {
  dir: string;
  /** In words: `session "x"'s workspace`. */
  what: string;
}

/**
 * Why `real` (a real path) touches a checkout that isn't the session's own,
 * or null (#448 round 13): it is, is inside or holds one of `others` (other
 * sessions' workspaces and worktree folders, which their commands write: a
 * swap there would be bound here); it is a checkout in one of its
 * repository's worktree locations (`<repo>-worktrees/<name>`,
 * `<main>/.worktrees/<name>`, `sandbox.worktreeRoots`'s: codeoid's fork,
 * loop and `--worktree` checkouts, other sessions' folders) that isn't one
 * of `ownFolders`, or holds such a location; or it is another checkout of
 * the session's own repository (`workspace`'s: its main checkout, seen from
 * a fork's worktree). An autonomous grant of one is refused; the owner's
 * card says it.
 */
export function checkoutOverlap(
  real: string,
  others: readonly OtherCheckout[],
  opts: { workspace: string; ownFolders?: readonly string[]; worktreeRoots?: readonly string[]; configDir?: string; home?: string },
): string | null {
  const at = resolve(real);
  const home = resolve(opts.home ?? process.env.HOME ?? homedir());
  for (const o of others) {
    const dir = realOr(resolve(o.dir));
    if (within(at, dir)) return `${at} ${at === dir ? "is" : "is in"} ${o.what} (${dir}), which that session's commands write`;
    if (within(dir, at)) return `${at} holds ${o.what} (${dir}), which that session's commands write`;
  }
  const own = (opts.ownFolders ?? []).map((f) => realOr(resolve(f)));
  const layout = gitLayoutOf(at, home);
  if (layout?.common) {
    const main = mainCheckoutOf(layout);
    const locations = [
      ...worktreeLocationDirs(layout, { roots: opts.worktreeRoots ?? [], home, ...(opts.configDir ? { configDir: opts.configDir } : {}) }).locations.map((l) => l.dir),
      ...(main ? [join(main, ".worktrees")] : []),
    ].map((l) => realOr(l));
    for (const l of locations) {
      if (within(at, l) && at !== l && !own.some((f) => within(at, f))) return `${at} is in ${l}, a worktree location: the checkouts there are other sessions' and codeoid's own (forks, loops, --worktree)`;
      if (within(l, at) && lexists(l)) return `${at} holds ${l}, a worktree location: the checkouts there are other sessions' and codeoid's own (forks, loops, --worktree)`;
    }
    const mine = gitLayoutOf(resolve(opts.workspace), home);
    if (mine?.common && realOr(mine.common) === realOr(layout.common)) {
      const top = layout.kind === "worktree" ? dirname(layout.dotgit) : (main ?? dirname(layout.dotgit));
      return `${at} is in another checkout of this session's own repository (${realOr(top)}${top === main ? ", its main checkout" : ""})`;
    }
  }
  return null;
}

/**
 * The default project root for a session working in `workspace`: the
 * parent of its repository's main checkout (a linked worktree's too, so a
 * fork in `<repo>-worktrees/` reads `<repo>`'s siblings). Null when the
 * workspace isn't in a repository: then there is no default root.
 */
export function defaultProjectRoot(workspace: string, home: string = process.env.HOME ?? homedir()): string | null {
  const ws = resolve(workspace);
  const layout = gitLayoutOf(ws, home);
  if (!layout) return null;
  const top = mainCheckoutOf(layout) ?? dirname(layout.dotgit);
  return dirname(resolve(top));
}

export interface ResolvedRoots {
  /** Absolute, existing dirs, deduplicated (by where they really are). */
  roots: string[];
  /** What wasn't used, and why (the sandbox's limits say it). */
  notes: string[];
}

/**
 * `entries` (the session's own, else `sandbox.projectRoots`) for a session
 * working in `workspace`: {@link PROJECT_ROOT_PARENT} as
 * {@link defaultProjectRoot} (none outside a repository, said), a default
 * that would be the home (a repository directly in it), the host's temp
 * dir or another refused place falling back to no root, said; anything else
 * refused by {@link projectRootProblem} or not there, said and not used.
 * Each by its real path (one named through a link is read where it really
 * is, said).
 */
export function resolveProjectRoots(entries: readonly string[], workspace: string, ctx: DirContext = {}): ResolvedRoots {
  const home = resolve(ctx.home ?? process.env.HOME ?? homedir());
  const out: ResolvedRoots = { roots: [], notes: [] };
  const seen = new Set<string>();
  for (const entry of entries) {
    const isDefault = entry === PROJECT_ROOT_PARENT;
    const at = isDefault ? defaultProjectRoot(workspace, home) : normalizeSandboxDir(entry, home);
    if (isDefault && at === null) {
      out.notes.push("no project root: the workspace isn't in a repository, so there is no default (the repository's parent) — set sandbox.projectRoots (or the session's own) to read other directories");
      continue;
    }
    const problem = at === null ? `${entry} isn't an absolute path` : projectRootProblem(at, { ...ctx, home });
    if (problem || at === null) {
      out.notes.push(
        isDefault
          ? `no project root: the default, the repository's parent (${at}), ${problem?.replace(/^\S+ is /, "is ") ?? "can't be one"} — set sandbox.projectRoots (or the session's own) to read other repositories`
          : `project root ${entry}: ${problem}: not used`,
      );
      continue;
    }
    let dir = false;
    try {
      dir = lstatSync(realOr(at)).isDirectory();
    } catch {
      /* not there */
    }
    if (!dir) {
      if (!isDefault) out.notes.push(`project root ${entry} (${at}) isn't a directory here: not used`);
      continue;
    }
    // By where it really is (#448 round 13): what is hidden in it, what is shown around the workspace and its pin
    // are all of the real dirs, never of a link's path (bubblewrap binds a link's path whole, before them).
    const real = realOr(at);
    if (seen.has(real)) continue;
    seen.add(real);
    if (real !== at && !isDefault) out.notes.push(`project root ${entry} is ${real} (where it really is): read there`);
    out.roots.push(real);
  }
  return out;
}

/**
 * Credential files, by name: dotenv files (not their examples), direnv's,
 * registry and netrc tokens, private keys (not `.pub`: `id_*`, `*_rsa`,
 * `*_ed25519`, `*_ecdsa`, `*_dsa`, deploy keys, `*.key`, `*.pem`, PuTTY's
 * `*.ppk`, Apple's `*.p8`), certificates' keystores, kubeconfigs, Terraform
 * state and variables, a vault token, service-account keys, `secrets.*`.
 */
const DATA_EXT = "(?:json|ya?ml|toml|ini|env|txt|conf|cfg|properties|xml|csv)";
const KEY_EXT = "(?:\\.(?:key|pem|ppk|old|bak|orig|backup|[0-9]+))?";
const SECRET_FILE = new RegExp(
  `^(?:${[
    "\\.env(?:\\.(?!(?:example|sample|template)$)[^/]+)?",
    "\\.envrc",
    "\\.npmrc",
    "\\.pypirc",
    "[._]netrc",
    "\\.git-credentials",
    "\\.vault-token",
    "\\.pgpass",
    "[^/]*\\.(?:pem|key|p12|pfx|jks|keystore|ppk|p8)",
    // Key names (`id_ed25519_work`, `github_rsa`, `deploy_key`): no extension, or a key's or a backup's, never `.pub`
    // (nor a source file: `id_generator.ts`, `crypto_rsa.go` aren't keys).
    `id_[^/.]+${KEY_EXT}`,
    `[^/.]*_(?:rsa|dsa|ecdsa|ed25519)(?:_[^/.]*)?${KEY_EXT}`,
    `(?:[^/.]*[_-])?deploy[_-]?key(?:[_-][^/.]*)?${KEY_EXT}`,
    "kubeconfig(?:\\.[^/]+)?",
    "[^/]*\\.kubeconfig",
    "[^/]*\\.tfstate(?:\\.[^/]+)?",
    "[^/]*\\.tfvars(?:\\.json)?",
    `credentials(?:\\.${DATA_EXT})?`,
    "service[-_]account[^/]*\\.json",
    `secrets?\\.${DATA_EXT}`,
  ].join("|")})$`,
  "i",
);
/** Dirs that hold only credentials (a project's own `.aws/`, `.ssh/`, …): hidden whole. */
const SECRET_DIRS: ReadonlySet<string> = new Set([".ssh", ".gnupg", ".aws", ".azure", ".gcloud", ".kube", ".password-store"]);
/** Credential files by where they are: a project's own Claude settings (their `env`), Docker's login. */
const SECRET_SUFFIXES: readonly string[] = ["/.claude/settings.local.json", "/.docker/config.json", "/.mcp.json"];
/**
 * Files that hold a credential only sometimes, judged by what is in them:
 * Yarn's `.yarnrc.yml` (`npmAuthToken`, `npmAuthIdent`) and `.yarnrc`
 * (`_authToken`), Composer's `auth.json`.
 */
const SECRET_BY_CONTENT: Readonly<Record<string, RegExp>> = {
  ".yarnrc.yml": /\bnpm(?:AuthToken|AuthIdent|Password)\s*:/,
  ".yarnrc": /_auth(?:Token)?\b|_password\b/,
  "auth.json": /"(?:http-basic|github-oauth|gitlab-oauth|gitlab-token|bitbucket-oauth|bearer|forgejo-token|custom-headers)"\s*:/,
};

/** A small regular file's text, or null (not one, too big, unreadable). */
function smallText(file: string, max = 1 << 20): string | null {
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.size > max) return null;
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Whether `file` (named `name`) is one of {@link SECRET_BY_CONTENT}'s holding a credential. */
function secretByContent(name: string, file: string): boolean {
  const re = SECRET_BY_CONTENT[name];
  if (!re) return false;
  const text = smallText(file);
  return text !== null && re.test(text);
}

/**
 * Whether a git config file carries a credential: a URL with a user or
 * password in it (an https one, or any with a password), or a token in its
 * query; an http `extraheader` in any syntax git reads (alone on its line,
 * after its section's header on the same line, under `[http "<url>"]`, any
 * case); a credential helper that is a shell snippet printing a password or
 * a token. A file too big to read is taken to carry one.
 */
export function gitConfigHasCredential(file: string): boolean {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(file);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  if (st.size > 1 << 20) return true;
  const text = smallText(file);
  if (text === null) return false;
  return (
    /\b(?:https?|ftps?):\/\/[^\s/"@]+@/i.test(text) ||
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:"@]+:[^\s/"@]*@/i.test(text) ||
    /:\/\/[^\s"]*[?&](?:private[_-]?token|access[_-]?token|token|password|passwd|api[_-]?key|apikey|auth|key)=/i.test(text) ||
    /(?:^|\])[ \t]*extraheader[ \t]*=/im.test(text) ||
    /(?:^|\])[ \t]*helper[ \t]*=[ \t]*"?[ \t]*!.*(?:password|token|secret)/im.test(text)
  );
}

/** The files a git config pulls in (`include.path`, `includeIf.<cond>.path`), absolute: relative to it, `~/` to the home. */
export function gitConfigIncludes(file: string, home: string = process.env.HOME ?? homedir()): string[] {
  const text = smallText(file);
  if (text === null) return [];
  const out: string[] = [];
  let section = "";
  for (const raw of text.split("\n")) {
    let line = raw.trim();
    const head = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"[^"]*")?\s*\]\s*(.*)$/.exec(line);
    if (head) {
      section = (head[1] ?? "").toLowerCase();
      line = head[2] ?? "";
    }
    if (section !== "include" && section !== "includeif") continue;
    const m = /^path\s*=\s*(.*?)\s*$/i.exec(line);
    if (!m?.[1]) continue;
    const value = m[1].replace(/^"(.*)"$/, "$1");
    if (!value) continue;
    out.push(value.startsWith("~/") ? join(home, value.slice(2)) : isAbsolute(value) ? value : resolve(dirname(file), value));
  }
  return out;
}

/** The credential stores a git config's `credential.helper = store --file <f>` names, absolute (relative to `base`). */
function credentialStores(file: string, base: string, home: string): string[] {
  const text = smallText(file);
  if (text === null) return [];
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|\])[ \t]*helper[ \t]*=[ \t]*"?[ \t]*store\b[^\n]*?--file(?:[ \t]*=[ \t]*|[ \t]+)("?)([^"\s]+)\1/gim)) {
    const f = m[2] ?? "";
    if (!f) continue;
    out.push(f.startsWith("~/") ? join(home, f.slice(2)) : isAbsolute(f) ? f : resolve(base, f));
  }
  return out;
}

/** Whether Mercurial's `hgrc` carries a credential: an `[auth]` section, or a URL with a user or password. */
function hgrcHasCredential(file: string): boolean {
  const text = smallText(file);
  if (text === null) return false;
  return /^\s*\[auth\]/im.test(text) || /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:"@]+:[^\s/"@]*@/i.test(text);
}

/**
 * The credentials git may read in the git dir `gitDir` (a repository's
 * `.git`, a bare one, a submodule's): every config git reads there
 * (`config`, `config.worktree`, each worktree's `config.worktree`, each
 * submodule's under `modules/`, bounded) carrying one, every file they
 * include, a `store --file` they name, and a credential file by name at its
 * top (`credentials`, `.git-credentials`). Configs in `configs`.
 */
function gitDirSecrets(gitDir: string, home: string, out: { found: string[]; configs: string[] }, budget = { left: 200 }, depth = 0): void {
  if (depth > 4 || --budget.left < 0) return;
  const top = basename(gitDir) === ".git" ? dirname(gitDir) : gitDir;
  const configs = [join(gitDir, "config"), join(gitDir, "config.worktree")];
  for (const w of listDirNames(join(gitDir, "worktrees"))) configs.push(join(gitDir, "worktrees", w, "config.worktree"), join(gitDir, "worktrees", w, "config"));
  const seen = new Set<string>();
  const look = (config: string, level: number): void => {
    if (seen.has(config) || level > 5) return;
    seen.add(config);
    if (gitConfigHasCredential(config)) {
      out.found.push(config);
      out.configs.push(config);
    }
    for (const store of credentialStores(config, top, home)) out.found.push(store);
    for (const inc of gitConfigIncludes(config, home)) look(inc, level + 1);
  };
  for (const c of configs) look(c, 0);
  for (const name of listFileNames(gitDir)) if (SECRET_FILE.test(name)) out.found.push(join(gitDir, name));
  const walkModules = (dir: string, level: number): void => {
    if (level > 4) return;
    for (const name of listDirNames(dir)) {
      if (--budget.left < 0) return;
      const sub = join(dir, name);
      // A submodule's git dir (one with a config is read by git as one, whatever else it has), and a submodule
      // named with a slash (`libs/a`): its git dir a level down.
      if (gitDirShape(sub) || smallText(join(sub, "config")) !== null) gitDirSecrets(sub, home, out, budget, depth + 1);
      if (!gitDirShape(sub)) walkModules(sub, level + 1);
    }
  };
  walkModules(join(gitDir, "modules"), 0);
}

function listDirNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function listFileNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** What the look through project roots found ({@link projectRootSecrets}). */
export interface RootSecrets {
  /** The credential files and dirs, hidden. */
  hidden: string[];
  /** The git configs among them (a repository's whose remote carries a credential): git there can't read its config. */
  gitConfigs: string[];
  /** Roots too big to look through whole: not used (fail closed). */
  over: string[];
}

/**
 * The credential files anywhere under the `roots` (and the session's own
 * worktree locations, `locations`), hidden like the credential stores are:
 * {@link SECRET_FILE} by name, {@link SECRET_DIRS} whole,
 * {@link SECRET_BY_CONTENT} by what is in them, every git config git may read
 * in a repository's git dir or a bare one carrying a credential (and what
 * it includes, a credential store it names: {@link gitDirSecrets}), a
 * Mercurial `hgrc` with one; but in `writable` (the session's own workspace
 * and the dirs its owner added: its own project's `.env` is its to use).
 * Looked for through directories (not through links, not in
 * {@link SCAN_SKIPPED_DIRS}) when the spec is built: one made later isn't
 * hidden. A root with more than `limit` directories to look through is in
 * `over`, and isn't to be used.
 */
export function projectRootSecrets(roots: readonly string[], writable: readonly string[], limit = PROJECT_ROOT_SCAN_LIMIT, home: string = process.env.HOME ?? homedir()): RootSecrets {
  const out: RootSecrets = { hidden: [], gitConfigs: [], over: [] };
  const mine = writable.flatMap((w) => [resolve(w), realOr(w)]);
  const owned = (p: string) => mine.some((w) => within(p, w));
  const seenRoots = new Set<string>();
  for (const root of roots) {
    const top = resolve(root);
    if (seenRoots.has(top)) continue;
    seenRoots.add(top);
    const git = { found: [] as string[], configs: [] as string[] };
    const found: string[] = [];
    const queue = [top];
    let seen = 0;
    let over = false;
    while (queue.length > 0 && !over) {
      const d = queue.shift() as string;
      if (owned(d) || owned(realOr(d))) continue;
      // A bare repository (or any git dir by its shape): its configs, never walked as files.
      if (gitDirShape(d)) {
        gitDirSecrets(d, home, git);
        continue;
      }
      let entries: Dirent[];
      try {
        entries = readdirSync(d, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isSymbolicLink()) continue;
        const at = join(d, e.name);
        if (e.isDirectory()) {
          if (SECRET_DIRS.has(e.name)) found.push(at);
          else if (e.name === ".git") gitDirSecrets(at, home, git);
          else if (e.name === ".hg") {
            if (hgrcHasCredential(join(at, "hgrc"))) found.push(join(at, "hgrc"));
          } else if (!SCAN_SKIPPED_DIRS.has(e.name)) {
            if (++seen > limit) {
              over = true;
              break;
            }
            queue.push(at);
          }
          continue;
        }
        if (!e.isFile()) continue;
        if (SECRET_FILE.test(e.name) || SECRET_SUFFIXES.some((s) => at.endsWith(s)) || secretByContent(e.name, at)) found.push(at);
      }
    }
    if (over) out.over.push(root);
    else {
      // What git reads that is in the root (an include or a store elsewhere is hidden where the sandbox hides it).
      const inRoot = (p: string) => within(resolve(p), top) || within(realOr(p), realOr(top));
      out.hidden.push(...[...found, ...git.found.filter(inRoot)].filter((p, i, all) => !owned(p) && all.indexOf(p) === i));
      out.gitConfigs.push(...git.configs.filter((p, i, all) => inRoot(p) && !owned(p) && all.indexOf(p) === i));
    }
  }
  return out;
}

/** The repository a hidden git config belongs to (`<repo>/.git/config`, a bare one's, a submodule's or a worktree's), for what is said about it. */
export function repositoryOfConfig(config: string): string {
  const parts = config.split("/");
  const i = parts.lastIndexOf(".git");
  if (i > 0) return parts.slice(0, i).join("/") || "/";
  return dirname(config);
}

/** Whether `p` is in one of `dirs` (as written or where it really is). */
export function inAnyDir(p: string, dirs: readonly string[]): boolean {
  const abs = resolve(p);
  const real = realOr(abs);
  return dirs.some((d) => within(abs, resolve(d)) || within(real, realOr(d)));
}
