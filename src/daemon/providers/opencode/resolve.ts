/**
 * opencode binary resolution and the version range codeoid supports.
 *
 * opencode 2.x replaced the whole server API (1.x's `/event`,
 * `permission.updated`, `@opencode-ai/sdk` are gone), so codeoid speaks 2.x
 * only and pins a range. The version is read from the running server's
 * `GET /api/info` (the only authoritative place: a wrapper script can't lie
 * about it), and a server outside the range is refused with this hint.
 */

import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readlinkSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { type CodeoidConfig, getConfigDir } from "../../../config.js";

/**
 * Where codeoid's opencode keeps its database: `providers.opencode.dbPath`
 * (loadConfig resolves it), else an `opencode` folder beside codeoid's own
 * database, else beside codeoid's config. Never the user's opencode data dir —
 * codeoid's sessions don't mix with theirs.
 */
export function opencodeDbPath(config: CodeoidConfig | undefined): string {
  const configured = config?.providers?.opencode?.dbPath;
  if (configured) return isAbsolute(configured) ? configured : resolve(getConfigDir(), configured);
  return defaultOpencodeDbPath(config);
}

function defaultOpencodeDbPath(config: CodeoidConfig | undefined): string {
  return join(config?.dbPath ? dirname(config.dbPath) : getConfigDir(), "opencode", "opencode.db");
}

/**
 * Every place codeoid's opencode credential files and database can be: the
 * configured database's, the default one's, and every one a server of this
 * config ran with before (`recordOpencodeDbPath`: where they stay after
 * `providers.opencode.dbPath` moves); `dirs` are the credential roots. They
 * outlive the daemon that wrote them, so they're refused to file tools, and
 * a gone daemon's are cleared at the daemon's start
 * (`clearStaleOpencodeCredentials`), whether or not opencode is enabled or
 * found this time.
 */
export function opencodeSecretLocations(config: CodeoidConfig | undefined): { dirs: string[]; files: string[] } {
  const files = [...new Set([opencodeDbPath(config), defaultOpencodeDbPath(config), ...recordedOpencodeDbPaths(config)])];
  return { dirs: files.map(opencodeCredentialsRoot), files };
}

/**
 * codeoid's record of the opencode databases its servers ran with (a JSON
 * string per line), beside codeoid's own database: a location stays covered
 * after the config moves away from it.
 */
export function opencodeLocationsFile(config: CodeoidConfig | undefined): string {
  return join(config?.dbPath ? dirname(config.dbPath) : getConfigDir(), "opencode-locations.jsonl");
}

function recordedOpencodeDbPaths(config: CodeoidConfig | undefined): string[] {
  let text: string;
  try {
    text = readFileSync(opencodeLocationsFile(config), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[opencode-server] couldn't read the opencode locations codeoid used: ${err instanceof Error ? err.message : String(err)}`);
    }
    return [];
  }
  const paths: string[] = [];
  for (const line of text.split("\n")) {
    try {
      const path: unknown = JSON.parse(line);
      if (typeof path === "string" && isAbsolute(path)) paths.push(path);
    } catch {
      // An empty or torn line.
    }
  }
  return paths;
}

/**
 * Add `dbPath` to the record in `file` (`opencodeLocationsFile`), before a
 * server keeps anything there. Throws when it can't: a location left
 * unrecorded would be neither refused nor cleared once the config moves.
 */
export function recordOpencodeDbPath(file: string, dbPath: string): void {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const line = JSON.stringify(dbPath);
  if (text.split("\n").includes(line)) return;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`, { mode: 0o600 });
}

/**
 * Where opencode keeps its data, logs, state and caches (its XDG base dirs):
 * `providers.opencode.dataDir` (loadConfig resolves it), else an `opencode`
 * folder beside codeoid's transcript directory, else beside codeoid's
 * config. Never the user's `~/.local/share/opencode` or `~/.cache/opencode`.
 */
export function opencodeDataDir(config: CodeoidConfig | undefined): string {
  const configured = config?.providers?.opencode?.dataDir;
  if (configured) return isAbsolute(configured) ? configured : resolve(getConfigDir(), configured);
  return config?.transcriptDir ? join(dirname(config.transcriptDir), "opencode") : join(getConfigDir(), "opencode");
}

/**
 * Where every codeoid daemon using the database `dbPath` keeps the credential
 * files its opencode config names: beside the database, under a name only
 * codeoid uses (the database may be put in a project, whose own
 * `config/credentials/` isn't codeoid's to empty).
 */
export function opencodeCredentialsRoot(dbPath: string): string {
  return join(dirname(dbPath), "codeoid-credentials");
}

/**
 * Where this process's pid means something: its host, boot and pid
 * namespace, hashed. Another daemon sharing the config from a container, or
 * from another host over a shared home, has another, and its pid can't be
 * checked from here (it may not exist here, or be this process's own).
 */
function pidNamespace(): string {
  const parts = [hostname()];
  for (const read of [() => readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), () => readlinkSync("/proc/self/ns/pid")]) {
    try {
      parts.push(read());
    } catch {
      // Not Linux: the host is what tells processes apart.
    }
  }
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 12);
}

/** This process's `pidNamespace()`. */
export const OPENCODE_PID_NAMESPACE = pidNamespace();

/**
 * This daemon process's dir in a credentials root: `<namespace>-<pid>-<nonce>`.
 * Two daemons sharing a config (a second `codeoid start`, another port, a
 * container) each have their own, and only remove their own and a gone
 * daemon's. The nonce tells this process from an earlier one that had its
 * pid; the namespace tells which pids can be checked here.
 */
export const OPENCODE_CREDENTIALS_PROCESS_DIR = `${OPENCODE_PID_NAMESPACE}-${process.pid}-${randomBytes(6).toString("hex")}`;

/** The 0700 dir of the credential files this daemon's opencode config names. */
export function opencodeCredentialsDir(dbPath: string): string {
  return join(opencodeCredentialsRoot(dbPath), OPENCODE_CREDENTIALS_PROCESS_DIR);
}

export const OPENCODE_INSTALL_HINT =
  "no opencode binary found — install opencode 2.2.5 or later 2.2 (https://opencode.ai) " +
  "or point providers.opencode.command at a binary";

/**
 * The opencode releases this provider was written and tested against
 * (`>=2.2.5 <2.3.0`). The floor is a patch release: opencode 2.2.2 runs a
 * shell line made only of redirections (`> file`, `2>file`, `<> file`)
 * without a permission request — it finds no command in it to ask about —
 * so the line creates or truncates any file past codeoid's gate. 2.2.5 asks
 * for every one of them; 2.2.3 and 2.2.4 weren't checked.
 */
export const OPENCODE_SUPPORTED_RANGE = { major: 2, minor: 2, patch: 5 } as const;
export const OPENCODE_SUPPORTED_LABEL = "2.2.5 or a later 2.2.x";

export interface OpencodeCommandResolution {
  command: string;
  argsPrefix: string[];
  source: "config" | "path";
}

export function resolveOpencodeCommand(
  configured: string | undefined,
  env: Record<string, string | undefined> = process.env,
): OpencodeCommandResolution | null {
  // An explicit override is verified so a typo is loud at startup, not a
  // first-turn spawn failure.
  if (configured !== undefined && configured !== "opencode") {
    if (configured.includes("/")) {
      return existsSync(configured) ? { command: configured, argsPrefix: [], source: "config" } : null;
    }
    const found = Bun.which(configured, { PATH: env.PATH ?? "" });
    return found ? { command: found, argsPrefix: [], source: "config" } : null;
  }
  const onPath = Bun.which("opencode", { PATH: env.PATH ?? "" });
  return onPath ? { command: onPath, argsPrefix: [], source: "path" } : null;
}

/**
 * Why a server reporting `version` can't be used, or null when it can. A
 * pre-release past the floor (`2.2.6-beta.1`) is accepted: the API is the
 * minor's. Anything unparseable is refused — guessing would mean speaking
 * an API the server may not have.
 */
export function opencodeVersionProblem(version: string | undefined): string | null {
  const m = typeof version === "string" ? /^v?(\d+)\.(\d+)\.(\d+)(-[^+]*)?(?:\+.*)?$/.exec(version.trim()) : null;
  if (!m) {
    return `opencode reported version ${JSON.stringify(version ?? null)}, which codeoid can't read; codeoid supports opencode ${OPENCODE_SUPPORTED_LABEL}`;
  }
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  const { major: MAJOR, minor: MINOR, patch: PATCH } = OPENCODE_SUPPORTED_RANGE;
  // A pre-release of the floor itself (`2.2.5-beta.1`) may predate the fix.
  const prerelease = m[4] !== undefined;
  const sameMinor = major === MAJOR && minor === MINOR;
  if (sameMinor && (patch > PATCH || (patch === PATCH && !prerelease))) return null;
  const why =
    major < 2
      ? "opencode 1.x has a different server API"
      : sameMinor
        ? "it runs some shell commands without asking codeoid"
        : major === MAJOR && minor < MINOR
          ? "it predates the API codeoid speaks"
          : "codeoid hasn't been checked against it yet";
  return `opencode ${version} is installed, but codeoid supports opencode ${OPENCODE_SUPPORTED_LABEL} (${why}) — install 2.2.5 or later, or point providers.opencode.command at one`;
}
