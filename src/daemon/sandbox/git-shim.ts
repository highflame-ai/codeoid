/**
 * The git a backend CLI runs for itself (#448). The Claude CLI runs
 * `git status`, `git log`, `git remote` in the workspace at every start, on
 * the host, and `git worktree add`/`remove` and commits for its worktree
 * features; opencode's shared server runs git for its project and
 * snapshots. A sandboxed command can write a repository there (`git init`
 * in a workspace with no `.git` of its own, then a filter driver in its
 * config and `.gitattributes`), and a git started outside the sandbox runs
 * what that config names: guarantee (c) broken by a program codeoid starts.
 *
 * So that CLI finds codeoid's `git` first on its `PATH`: a script in a
 * daemon-private dir (under the launchers', hidden from every sandbox, never
 * in the workspace or the caches, so nothing inside can rewrite it) that
 *
 *   - runs the real git inside the session's sandbox (a launcher for
 *     {@link gitShimSpec}: the session's command sandbox, the git structure
 *     held, the home hidden, no network, a fresh `/tmp` of its own for each
 *     git, gone when it exits), stdio, exit code, cwd and arguments the
 *     caller's; a driver a planted config names runs there, contained, able
 *     to do what a sandboxed command can and no more;
 *   - or, with no launcher (a shared server, which no one session's sandbox
 *     fits) or when the launcher's provider is gone, runs git with every
 *     program-running key turned off ({@link BASE_OVERRIDES}, appended to
 *     the caller's own `GIT_CONFIG_COUNT`), every filter, diff and merge
 *     driver and credential helper defined outside the user's global and
 *     system config reset (read from `git config --show-scope`, which runs
 *     nothing; a listing that fails runs nothing), the working tree's
 *     attributes not read (`attr.tree`: an empty tree), no nested
 *     repository gone into (its own config's drivers can't be reset by name:
 *     {@link SUBMODULE_OVERRIDES}), and only https and ssh as protocols.
 *
 * Either way git gets an environment built from {@link SHIM_ENV_NAMES}, never
 * the caller's: the Claude CLI's has its API key or OAuth token, a gateway's
 * credential, opencode's server its password.
 *
 * What runs inside a sandbox never finds it: Claude's env file takes the
 * shim's dir off `PATH` for its sandboxed commands (claude-native.ts), and
 * the dir is hidden there anyway.
 */

import { chmodSync, lstatSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { BASE_OVERRIDES, GIT_BIN, PROGRAM_ENV, REMOTE_PROTOCOLS } from "../git-env.js";
import { GIT_CONTROL, gitLayoutOf, programLocations } from "./policy.js";
import { makeAt, pinOf } from "./pinned.js";
import type { SandboxSpec } from "./types.js";

/** The empty tree's id: `attr.tree` naming it reads no attributes from the working tree (git ≥ 2.46; an older git ignores the key). */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** What starts git with nothing of the caller's environment but what the shim hands it. */
const ENV_BIN = "/usr/bin/env";

/**
 * The caller's variables the shim's git is given, by name: who the user is,
 * the locale, the terminal and clock, the user's own config files, and git's
 * choice of repository, worktree, index, pathspec and identity, and its
 * caller's narrowing knobs (no protocol, no lazy fetch, no prompt). Never a
 * credential (an API key, an OAuth token, a gateway URL), a program git
 * would run (`GIT_ASKPASS`, `GIT_SSH*`, `GIT_EXTERNAL_DIFF`,
 * `GIT_PROXY_COMMAND`), where git's own programs or templates are
 * (`GIT_EXEC_PATH`, `GIT_TEMPLATE_DIR`), or `GIT_CONFIG_PARAMETERS` (which
 * can't be read apart). `PATH` (its absolute entries), `HOME` and the
 * caller's `-c` list (`GIT_CONFIG_COUNT`) are handed over apart.
 */
export const SHIM_ENV_NAMES: readonly string[] = [
  "USER", "LOGNAME", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_COLLATE", "LC_MESSAGES", "LC_MONETARY",
  "LC_NUMERIC", "LC_TIME", "LC_ADDRESS", "LC_IDENTIFICATION", "LC_MEASUREMENT", "LC_NAME", "LC_PAPER",
  "LC_TELEPHONE", "TERM", "TZ", "XDG_CONFIG_HOME",
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_IMPLICIT_WORK_TREE", "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_DEFAULT_HASH", "GIT_OPTIONAL_LOCKS", "GIT_LITERAL_PATHSPECS",
  "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS", "GIT_FLUSH", "GIT_ADVICE",
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_AUTHOR_DATE", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_DATE", "GIT_REFLOG_ACTION", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM",
  "GIT_ATTR_NOSYSTEM", "GIT_ATTR_SOURCE", "GIT_TERMINAL_PROMPT", "GIT_ALLOW_PROTOCOL", "GIT_PROTOCOL_FROM_USER",
  "GIT_NO_LAZY_FETCH", "GIT_NO_REPLACE_OBJECTS", "GIT_LFS_SKIP_SMUDGE", "GIT_PAGER", "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
];

/**
 * Keys of the caller's `-c` list (`GIT_CONFIG_COUNT`) whose value can carry
 * a credential (a header, a URL with a password, a token): such an entry
 * with a value is not handed to git. An empty one (a reset: opencode's
 * `credential.helper=`) is. As git reads keys, case-insensitively.
 */
const SECRET_CONFIG_KEYS = [
  "credential.*", "http.*", "url.*", "remote.*", "ssh.*", "gpg.*", "sendemail.*", "imap.*",
  "core.askpass", "core.sshcommand", "user.signingkey",
  "*token*", "*password*", "*passwd*", "*secret*", "*cookie*", "*auth*", "*credential*",
];

/** The caller's `-c` list is read up to this many entries; a longer one runs nothing. */
const MAX_CALLER_CONFIG = 1000;

/**
 * What the defused git gets besides {@link BASE_OVERRIDES} (#448 round 5):
 * git runs a git of its own inside a nested repository (the status and diff
 * of a gitlink check its dirt there, a summary or a `diff=diff` shows its
 * log), and that one reads the nested repository's config and
 * `info/attributes`, whose drivers can't be reset by a name the shim never
 * saw. So it never goes into one: submodules ignored (with
 * `submodule.<name>.ignore` set for every name the repository's config and
 * `.gitmodules` know, which outranks `diff.ignoreSubmodules`), no summary,
 * no recursing fetch or push.
 */
export const SUBMODULE_OVERRIDES: ReadonlyArray<readonly [string, string]> = [
  ["diff.ignoreSubmodules", "all"],
  ["diff.submodule", "short"],
  ["status.submoduleSummary", "false"],
  ["fetch.recurseSubmodules", "false"],
  ["push.recurseSubmodules", "no"],
];

/** What git a CLI runs for itself needs writable beyond a command's: the dirs its worktree features write. */
export interface GitShimWorktrees {
  /** Writable, with everything in them: the repository's `worktrees/` and the CLI's own dir of worktree checkouts (`.claude/worktrees`). */
  open: readonly string[];
  /** Read-only inside those all the same: the workspace's own worktree git dir's control (its `commondir`, `gitdir`). */
  keep?: readonly string[];
}

/** A directory itself, not a link to one. */
function realDir(p: string): boolean {
  try {
    const st = lstatSync(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * What the Claude CLI's worktree features write in `workspace`'s repository
 * (`git worktree add --no-track -B <branch> <top>/.claude/worktrees/<name>`,
 * `git worktree remove --force`): the repository's `worktrees/`, and
 * `.claude/worktrees` at the workspace's top (made when `.claude` is there).
 * Only real directories, in a git dir the sandbox holds part by part (one
 * with a link among its control is read-only whole: nothing opened in it).
 */
export function cliWorktrees(workspace: string, home?: string): GitShimWorktrees {
  const ws = resolve(workspace);
  const layout = gitLayoutOf(ws, home);
  const common = layout?.common;
  if (!layout || !common || isLink(common) || GIT_CONTROL.some((n) => isLink(join(common, n)))) return { open: [] };
  const open: string[] = [];
  const worktrees = join(common, "worktrees");
  if (realDir(worktrees)) open.push(worktrees);
  const claude = join(ws, ".claude");
  if (dirname(resolve(layout.dotgit)) === ws && realDir(claude)) {
    const checkouts = join(claude, "worktrees");
    try {
      // Never through a link (pinned.ts: `.claude` pinned for the make, checked again after; #448 round 14).
      makeAt(checkouts, "dir", "making the CLI's worktree dir");
    } catch {
      /* there already (or can't be: then not opened) */
    }
    if (realDir(checkouts)) open.push(checkouts);
  }
  const own = layout.own;
  return { open, ...(own ? { keep: ["commondir", "gitdir", "config.worktree"].map((n) => join(own, n)) } : {}) };
}

function within(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p.endsWith("/") ? p : `${p}/`);
}

/**
 * The spec the shim's git runs under (#448 round 5): the session's command
 * sandbox (the workspace writable with its git structure held, the home
 * hidden), with no network, a fresh temp dir for each git ({@link
 * SandboxSpec.privateTemp}, made in `tempParent` where the provider needs a
 * real dir), never the session's temp dir; and, for the CLI's own worktree
 * features (`git worktree add`/`remove`: a worktree's git dir and its
 * checkout), the dirs in `worktrees.open` writable, the other worktrees'
 * `.git` files in them included.
 */
export function gitShimSpec(spec: SandboxSpec, opts: { tempParent: string; worktrees?: GitShimWorktrees }): SandboxSpec {
  const open = opts.worktrees?.open ?? [];
  const keep = opts.worktrees?.keep ?? [];
  const held = (p: string) => !open.some((o) => within(p, o)) || keep.some((k) => within(p, k));
  // git reaches no container runtime, whatever the session's commands may.
  const { dockerSockets: _sockets, ...rest } = spec;
  const { DOCKER_HOST: _host, ...env } = spec.env ?? {};
  return {
    ...rest,
    ...(spec.env ? { env } : {}),
    tempDir: opts.tempParent,
    privateTemp: true,
    writable: [...spec.writable, ...open],
    readOnly: (spec.readOnly ?? []).filter(held),
    // Bound by name as the rest (pinned.ts, #448 round 14): never followed to where a link put there leads.
    pins: [...(spec.pins ?? []), ...open.map((p) => pinOf(p, "a git worktree dir"))],
    network: { mode: "off" },
  };
}

let locations: string[] | null = null;

/**
 * Where git's own program is (its binary, and `git --exec-path` for the
 * commands it runs as programs): shown read-only in the shim's sandbox when
 * a hidden dir (the home) would cover them; never the home itself.
 */
export function gitProgramLocations(): string[] {
  if (locations) return locations;
  const out = programLocations(GIT_BIN, []);
  try {
    const r = Bun.spawnSync([GIT_BIN, "--exec-path"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    const dir = r.exitCode === 0 ? r.stdout.toString().trim() : "";
    if (dir.startsWith("/")) out.push(...programLocations(join(dir, "git"), []).filter((d) => d === dir));
  } catch {
    /* no exec-path: the binary's dirs only */
  }
  locations = [...new Set(out)];
  return locations;
}

/** POSIX shell single-quoting. */
function q(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** A case-insensitive sh `case` pattern for a glob of lowercase letters, dots and `*`. */
function anyCase(glob: string): string {
  return glob.replace(/[a-z]/g, (ch) => `[${ch}${ch.toUpperCase()}]`);
}

export interface GitShimOptions {
  /** The real git (absolute). */
  git?: string;
  /** A launcher running that git inside the session's sandbox (session-sandbox.ts), or null: defused only. */
  launcher: string | null;
  /** The program the launcher starts first (bwrap, sandbox-exec): gone, the launcher can't sandbox, so git runs defused. */
  provider?: string | null;
  /** `HOME` for the sandboxed git: the home's path, which the sandbox hides (its allowlist, `~/.gitconfig`, shown). The defused git keeps the caller's. */
  home?: string;
  /** For the header: what runs it. */
  caller: string;
}

/** Lines appending `KEY=VALUE` words for `GIT_CONFIG_KEY_$j`/`_VALUE_$j` to the positional list, `j` counting. */
function configWord(key: string, value: string): string {
  return `set -- "$@" "GIT_CONFIG_KEY_$j="${q(key)} "GIT_CONFIG_VALUE_$j="${q(value)}; j=$((j + 1))`;
}

/** Lines that end the script: `program` started by `env -i` with the words gathered, git's own arguments after them. */
function execClean(program: string): string[] {
  // A program word with `=` in it would be read by env as one more variable: started through sh then.
  const run = program.includes("=") ? ["/bin/sh", "-c", 'exec "$0" "$@"', program] : [program];
  return [
    `set -- "$@" "GIT_CONFIG_COUNT=$j" ${run.map(q).join(" ")}`,
    // git's own arguments (the first n0 words) after the variables and the program.
    'while [ "$n0" -gt 0 ]; do set -- "$@" "$1"; shift; n0=$((n0 - 1)); done',
    `exec ${ENV_BIN} -i "$@"`,
  ];
}

/**
 * Lines setting `L`, the start of a command line (for `eval`) running `git`
 * with git's own options before its command (`$o`) and the environment
 * gathered so far (the words after git's arguments, `n0`, and the count of
 * `-c` entries now), never the caller's: reading the index runs
 * `core.fsmonitor`, and these must run nothing. At the top level, never in
 * a function (whose `${1}` is its own): words are named by position.
 */
function listingCommand(git: string): string[] {
  const run = git.includes("=") ? `/bin/sh -c 'exec "$0" "$@"' ${q(git)}` : '\\"\\$g\\"';
  return [
    'v=""',
    "i=$((n0 + 1))",
    'while [ "$i" -le $# ]; do v="$v \\"\\${$i}\\""; i=$((i + 1)); done',
    `L="${ENV_BIN} -i$v GIT_CONFIG_COUNT=$j GIT_PAGER=cat GIT_EDITOR=: ${run}$o --no-pager"`,
  ];
}

/** The shim (a POSIX sh script). Pure. */
export function gitShimScript(opts: GitShimOptions): string {
  const git = opts.git ?? GIT_BIN;
  const lines = [
    "#!/bin/sh",
    `# Written by codeoid (#448): the git ${opts.caller} runs for itself, inside the session's sandbox or with nothing of a repository's config run.`,
    // The environment git gets is built here, as words after git's own arguments (the first n0), and started with `env -i`.
    "n0=$#",
    // PATH: its absolute entries only (a relative one names a file in the workspace).
    'r="${PATH-}:"',
    'p=""',
    'while [ -n "$r" ]; do e="${r%%:*}"; r="${r#*:}"; case "$e" in /*) p="${p:+$p:}$e" ;; esac; done',
    'set -- "$@" "PATH=$p"',
    ...SHIM_ENV_NAMES.map((n) => `[ -z "\${${n}+x}" ] || set -- "$@" "${n}=$${n}"`),
    // The caller's `-c` list, renumbered, less an entry whose value could be a credential.
    "j=0",
    "i=0",
    'cnt="${GIT_CONFIG_COUNT-0}"',
    'case "$cnt" in ""|*[!0-9]*) cnt=0 ;; esac',
    `if [ "$cnt" -gt ${MAX_CALLER_CONFIG} ]; then echo "codeoid: too many GIT_CONFIG_COUNT entries, so git was not run" >&2; exit 128; fi`,
    'while [ "$i" -lt "$cnt" ]; do',
    '  eval "ck=\\${GIT_CONFIG_KEY_$i-}; cv=\\${GIT_CONFIG_VALUE_$i-}"',
    "  i=$((i + 1))",
    '  [ -n "$ck" ] || continue',
    '  if [ -n "$cv" ]; then',
    `    case "$ck" in ${SECRET_CONFIG_KEYS.map(anyCase).join("|")}) continue ;; esac`,
    '    case "$cv" in *://*@*) continue ;; esac',
    "  fi",
    '  set -- "$@" "GIT_CONFIG_KEY_$j=$ck" "GIT_CONFIG_VALUE_$j=$cv"',
    "  j=$((j + 1))",
    "done",
  ];
  if (opts.launcher) {
    const ready = [`[ -f ${q(opts.launcher)} ]`, `[ -x ${q(opts.launcher)} ]`, ...(opts.provider ? [`[ -x ${q(opts.provider)} ]`] : [])];
    lines.push(
      `if ${ready.join(" && ")}; then`,
      // The home as the sandbox shows it (hidden, its allowlist shown); TMPDIR is the sandbox's own.
      ...(opts.home ? [`  set -- "$@" ${q(`HOME=${opts.home}`)}`] : []),
      ...execClean(opts.launcher).map((l) => `  ${l}`),
      "fi",
    );
  }
  lines.push(
    // Defused, on the host: the caller's home and temp dir.
    '[ -z "${HOME+x}" ] || set -- "$@" "HOME=$HOME"',
    '[ -z "${TMPDIR+x}" ] || set -- "$@" "TMPDIR=$TMPDIR"',
    `g=${q(git)}`,
    ...BASE_OVERRIDES.map(([k, v]) => configWord(k, v)),
    configWord("attr.tree", EMPTY_TREE),
    ...SUBMODULE_OVERRIDES.map(([k, v]) => configWord(k, v)),
    // git's options before its command (`-C`, `--git-dir`, `-c`): the listings below read the repository git will.
    // Never a pager's (`-p`): nothing here runs one.
    'o=""',
    "i=1",
    'while [ "$i" -le "$n0" ]; do',
    '  eval "a=\\${$i}"',
    '  case "$a" in',
    '    -C|-c|--git-dir|--work-tree|--namespace|--config-env|--attr-source) o="$o \\"\\${$i}\\""; i=$((i + 1)); [ "$i" -gt "$n0" ] || o="$o \\"\\${$i}\\"" ;;',
    '    --git-dir=*|--work-tree=*|--namespace=*|--config-env=*|--attr-source=*|--bare|--no-replace-objects|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--no-optional-locks|--no-lazy-fetch|--no-advice|-P|--no-pager) o="$o \\"\\${$i}\\"" ;;',
    // Any other (`--version`, `--exec-path`, `-p`): not one that picks a repository, and some are a command of their own.
    "    -*) ;;",
    "    *) break ;;",
    "  esac",
    "  i=$((i + 1))",
    "done",
    ...listingCommand(git),
    // Every key git reads here, as `scope<TAB>key` per line (a name holds no newline): those of drivers and helpers are picked below.
    'd=$(eval "$L config --show-scope --name-only --list" </dev/null 2>/dev/null)',
    "r=$?",
    'if [ "$r" -ne 0 ] && [ "$r" -ne 1 ]; then',
    '  echo "codeoid: git config could not be read here, so git was not run" >&2',
    "  exit 128",
    "fi",
    "t=$(printf '\\t')",
    'while IFS= read -r e; do',
    '  [ -n "$e" ] || continue',
    '  s="${e%%"$t"*}"',
    '  k="${e#*"$t"}"',
    '  case "$k" in submodule.*.*) m="${k#submodule.}"; m="${m%.*}"; set -- "$@" "GIT_CONFIG_KEY_$j=submodule.$m.ignore" "GIT_CONFIG_VALUE_$j=all"; j=$((j + 1)) ;; esac',
    '  case "$s" in system|global) continue ;; esac',
    '  case "$k" in',
    '    credential.*helper) set -- "$@" "GIT_CONFIG_KEY_$j=$k" "GIT_CONFIG_VALUE_$j="; j=$((j + 1)) ;;',
    '    filter.*.*) m="${k#filter.}"; m="${m%.*}"; for x in clean smudge process; do set -- "$@" "GIT_CONFIG_KEY_$j=filter.$m.$x" "GIT_CONFIG_VALUE_$j="; j=$((j + 1)); done; set -- "$@" "GIT_CONFIG_KEY_$j=filter.$m.required" "GIT_CONFIG_VALUE_$j=false"; j=$((j + 1)) ;;',
    '    diff.*.*) m="${k#diff.}"; m="${m%.*}"; for x in command textconv; do set -- "$@" "GIT_CONFIG_KEY_$j=diff.$m.$x" "GIT_CONFIG_VALUE_$j="; j=$((j + 1)); done ;;',
    '    merge.*.*) m="${k#merge.}"; m="${m%.*}"; set -- "$@" "GIT_CONFIG_KEY_$j=merge.$m.driver" "GIT_CONFIG_VALUE_$j="; j=$((j + 1)) ;;',
    "  esac",
    "done <<CODEOID_GIT_SHIM_DRIVERS",
    "$d",
    "CODEOID_GIT_SHIM_DRIVERS",
    // The submodules `.gitmodules` names, where git reads it: the working tree's, else the index's, else HEAD's
    // (reading the index runs `core.fsmonitor`: these with every override so far, the drivers' included).
    ...listingCommand(git),
    'w=$(eval "$L rev-parse --show-toplevel" </dev/null 2>/dev/null)',
    'if [ -n "$w" ] && [ -f "$w/.gitmodules" ]; then u=$(eval "$L config -f \\"\\$w/.gitmodules\\" --name-only --list" </dev/null 2>/dev/null)',
    'else u=$(eval "$L config --blob :.gitmodules --name-only --list" </dev/null 2>/dev/null) || u=$(eval "$L config --blob HEAD:.gitmodules --name-only --list" </dev/null 2>/dev/null)',
    "fi",
    'while IFS= read -r k; do',
    '  case "$k" in submodule.*.*) m="${k#submodule.}"; m="${m%.*}"; set -- "$@" "GIT_CONFIG_KEY_$j=submodule.$m.ignore" "GIT_CONFIG_VALUE_$j=all"; j=$((j + 1)) ;; esac',
    "done <<CODEOID_GIT_SHIM_SUBMODULES",
    "$u",
    "CODEOID_GIT_SHIM_SUBMODULES",
    ...Object.entries(PROGRAM_ENV).map(([k, v]) => `set -- "$@" ${q(`${k}=${v}`)}`),
    // The caller's own protocol list stands (opencode's is none); else https and ssh only.
    `set -- "$@" GIT_NO_REPLACE_OBJECTS=1 GIT_TERMINAL_PROMPT=0 "GIT_ALLOW_PROTOCOL=\${GIT_ALLOW_PROTOCOL-${REMOTE_PROTOCOLS}}"`,
    ...execClean(git),
    "",
  );
  return lines.join("\n");
}

/** Write {@link gitShimScript} as `<dir>/git` (0700, atomically: a git started meanwhile gets the old one or the new one) and return `dir`. */
export function writeGitShim(dir: string, opts: GitShimOptions): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "git");
  const part = `${path}.${process.pid}.part`;
  writeFileSync(part, gitShimScript(opts), { mode: 0o700 });
  chmodSync(part, 0o700);
  renameSync(part, path);
  return dir;
}

/** A `PATH`'s absolute entries: a relative one (`.`, `node_modules/.bin`) names a file in each directory a program is started in, the workspace among them. */
export function absolutePathEntries(path: string | undefined): string[] {
  return (path ?? "").split(":").filter((p) => isAbsolute(p));
}

/** `PATH` with `dir` first (and nowhere else), and only absolute entries. */
export function pathWithShim(dir: string, path: string | undefined): string {
  return [dir, ...absolutePathEntries(path).filter((p) => p !== dir)].join(":");
}
