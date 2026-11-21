/**
 * Which Claude Code CLI the Claude backend runs.
 *
 * By default the one bundled in the Agent SDK's platform package: the version
 * codeoid pins and tests its sandbox against (a CLI update changed what
 * Claude's own sandbox lets a command write, unannounced: #478).
 * `providers.claude.command` opts into another: a name on PATH (`claude`, the
 * system install) or an absolute path. It is used only when its
 * `--version` reads and is no older than the bundled one, so the SDK never
 * talks to a CLI older than it was built for; anything else falls back to
 * the bundled CLI and says why. A newer one runs, with a note that codeoid's
 * sandbox wasn't tested against it.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export interface ClaudeExecutable {
  /** The CLI to hand the SDK (`pathToClaudeCodeExecutable`); null: the bundled one. */
  path: string | null;
  /** Its version as `--version` reports it; for the bundled one, the SDK's. */
  version: string | null;
  /** The bundled CLI's version: what codeoid is tested against. */
  bundledVersion: string | null;
  /** What the session is told: why the configured CLI isn't used, or that it is untested. Null: nothing to say. */
  note: string | null;
}

/** Seams for tests. */
export interface ResolveDeps {
  which?: (name: string) => string | null;
  version?: (path: string) => string | null;
  bundledVersion?: () => string | null;
}

const require_ = createRequire(import.meta.url);

/** `claudeCodeVersion` of the installed Agent SDK (its package.json isn't exported, so read beside its entry). */
export function bundledClaudeVersion(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(require_.resolve("@anthropic-ai/claude-agent-sdk")), "package.json"), "utf8")) as { claudeCodeVersion?: unknown };
    return typeof pkg.claudeCodeVersion === "string" ? pkg.claudeCodeVersion : null;
  } catch {
    return null;
  }
}

const versionCache = new Map<string, string | null>();

/**
 * `<path> --version`, as `2.1.330`. Run in the home with only PATH and HOME,
 * bounded; cached per file (path, size, mtime) so a reinstall is seen.
 */
export function cliVersion(path: string): string | null {
  let key: string;
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    key = `${path}\0${st.size}\0${st.mtimeMs}`;
  } catch {
    return null;
  }
  if (versionCache.has(key)) return versionCache.get(key) ?? null;
  const out = spawnSync(path, ["--version"], {
    cwd: homedir(),
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homedir(), DISABLE_AUTOUPDATER: "1" },
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const version = out.status === 0 ? (/\b(\d+\.\d+\.\d+)\b/.exec(out.stdout ?? "")?.[1] ?? null) : null;
  if (versionCache.size > 32) versionCache.clear();
  versionCache.set(key, version);
  return version;
}

/** Negative, zero or positive as `a` is older, the same as or newer than `b` (dotted numbers). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Where `command` points: `~` expanded, a bare name looked up on PATH. Null: not found or not usable. */
function locate(command: string, which: (name: string) => string | null): { path: string | null; problem: string | null } {
  const cmd = command.startsWith("~/") ? join(homedir(), command.slice(2)) : command;
  if (!cmd.includes("/")) {
    const found = which(cmd);
    return found ? { path: found, problem: null } : { path: null, problem: `\`${cmd}\` isn't on the daemon's PATH` };
  }
  if (!isAbsolute(cmd)) return { path: null, problem: `\`${command}\` is a relative path; give an absolute one or a name on PATH` };
  return { path: cmd, problem: null };
}

/** The CLI to run for `providers.claude.command` (unset or blank: the bundled one). */
export function resolveClaudeExecutable(command: string | undefined, deps: ResolveDeps = {}): ClaudeExecutable {
  const bundledVersion = (deps.bundledVersion ?? bundledClaudeVersion)();
  const bundled = (note: string | null): ClaudeExecutable => ({ path: null, version: bundledVersion, bundledVersion, note });
  const configured = command?.trim();
  if (!configured) return bundled(null);
  const fallback = (why: string) => bundled(`Claude Code: ${why}, so this session runs the bundled CLI${bundledVersion ? ` (${bundledVersion})` : ""} (providers.claude.command).`);
  const { path, problem } = locate(configured, deps.which ?? ((n) => Bun.which(n)));
  if (!path) return fallback(problem ?? `\`${configured}\` wasn't found`);
  const version = (deps.version ?? cliVersion)(path);
  if (!version) return fallback(`\`${path} --version\` didn't report a version`);
  if (bundledVersion && compareVersions(version, bundledVersion) < 0) {
    return fallback(`${path} is ${version}, older than the ${bundledVersion} this codeoid is built for`);
  }
  const note =
    bundledVersion && compareVersions(version, bundledVersion) > 0
      ? `Claude Code: running ${path} (${version}). codeoid is tested with ${bundledVersion}: its sandbox behaviour on ${version} is untested.`
      : null;
  return { path, version, bundledVersion, note };
}
