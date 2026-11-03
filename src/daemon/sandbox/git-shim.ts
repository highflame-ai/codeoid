/**
 * The git a backend CLI runs for itself (#448). The Claude CLI runs
 * `git status`, `git log`, `git remote` in the workspace at every start, on
 * the host; opencode's shared server runs git for its project and
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
 *     {@link gitShimSpec}: the same provider and hidden paths, the workspace
 *     and everything else writable read-only, no network), stdio, exit code,
 *     cwd, arguments and environment the caller's; a driver a planted config
 *     names runs there, contained;
 *   - or, with no launcher (a shared server, which no one session's sandbox
 *     fits) or when the launcher's provider is gone, runs git with every
 *     program-running key turned off ({@link BASE_OVERRIDES}, appended to
 *     the caller's own `GIT_CONFIG_COUNT`), every filter, diff and merge
 *     driver and credential helper defined outside the user's global and
 *     system config reset (read from `git config --show-scope`, which runs
 *     nothing; a listing that fails runs nothing), the working tree's
 *     attributes not read (`attr.tree`: an empty tree), and only https and
 *     ssh as protocols.
 *
 * What runs inside a sandbox never finds it: Claude's env file takes the
 * shim's dir off `PATH` for its sandboxed commands (claude-native.ts), and
 * the dir is hidden there anyway.
 */

import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_OVERRIDES, GIT_BIN, PROGRAM_ENV, REMOTE_PROTOCOLS } from "../git-env.js";
import { programLocations } from "./policy.js";
import type { SandboxSpec } from "./types.js";

/** The empty tree's id: `attr.tree` naming it reads no attributes from the working tree (git ≥ 2.46; an older git ignores the key). */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * The spec the shim's git runs under: the session's, with every writable
 * location read-only (the CLI's own git only reads; a filter it runs must
 * not write the workspace either), nothing pinned (a pinned dir is a
 * writable bind), and no network.
 */
export function gitShimSpec(spec: SandboxSpec): SandboxSpec {
  return {
    ...spec,
    readOnly: [...(spec.readOnly ?? []), spec.workspace, ...spec.writable],
    pinned: [],
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

export interface GitShimOptions {
  /** The real git (absolute). */
  git?: string;
  /** A launcher running that git inside the session's sandbox (session-sandbox.ts), or null: defused only. */
  launcher: string | null;
  /** The program the launcher starts first (bwrap, sandbox-exec): gone, the launcher can't sandbox, so git runs defused. */
  provider?: string | null;
  /** For the header: what runs it. */
  caller: string;
}

/** The shim (a POSIX sh script). Pure. */
export function gitShimScript(opts: GitShimOptions): string {
  const git = opts.git ?? GIT_BIN;
  const lines = [
    "#!/bin/sh",
    `# Written by codeoid (#448): the git ${opts.caller} runs for itself, inside the session's sandbox or with nothing of a repository's config run.`,
  ];
  if (opts.launcher) {
    const ready = [`[ -f ${q(opts.launcher)} ]`, `[ -x ${q(opts.launcher)} ]`, ...(opts.provider ? [`[ -x ${q(opts.provider)} ]`] : [])];
    lines.push(`if ${ready.join(" && ")}; then exec ${q(opts.launcher)} "$@"; fi`);
  }
  lines.push(
    `g=${q(git)}`,
    'n="${GIT_CONFIG_COUNT-0}"',
    'case "$n" in ""|*[!0-9]*) n=0 ;; esac',
    'c() { export "GIT_CONFIG_KEY_$n=$1" "GIT_CONFIG_VALUE_$n=$2"; n=$((n + 1)); }',
    ...BASE_OVERRIDES.map(([k, v]) => `c ${q(k)} ${q(v)}`),
    `c attr.tree ${EMPTY_TREE}`,
    'export GIT_CONFIG_COUNT="$n"',
    ...Object.entries(PROGRAM_ENV).map(([k, v]) => `export ${k}=${q(v)}`),
    // The caller's own protocol list stands (opencode's is none); else https and ssh only.
    `export GIT_NO_REPLACE_OBJECTS=1 GIT_TERMINAL_PROMPT=0 GIT_ALLOW_PROTOCOL="\${GIT_ALLOW_PROTOCOL-${REMOTE_PROTOCOLS}}"`,
    // Every key git reads here, as `scope<TAB>key` per line (a name holds no newline): those of drivers and helpers are picked below.
    'd=$("$g" config --show-scope --name-only --list </dev/null 2>/dev/null)',
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
    '  case "$s" in system|global) continue ;; esac',
    '  case "$k" in',
    '    credential.*helper) c "$k" "" ;;',
    '    filter.*.*) m="${k#filter.}"; m="${m%.*}"; c "filter.$m.clean" ""; c "filter.$m.smudge" ""; c "filter.$m.process" ""; c "filter.$m.required" false ;;',
    '    diff.*.*) m="${k#diff.}"; m="${m%.*}"; c "diff.$m.command" ""; c "diff.$m.textconv" "" ;;',
    '    merge.*.*) m="${k#merge.}"; m="${m%.*}"; c "merge.$m.driver" "" ;;',
    "  esac",
    "done <<CODEOID_GIT_SHIM_DRIVERS",
    "$d",
    "CODEOID_GIT_SHIM_DRIVERS",
    'export GIT_CONFIG_COUNT="$n"',
    'exec "$g" "$@"',
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

/** `PATH` with `dir` first (and nowhere else). */
export function pathWithShim(dir: string, path: string | undefined): string {
  const rest = (path ?? "").split(":").filter((p) => p !== "" && p !== dir);
  return [dir, ...rest].join(":");
}
