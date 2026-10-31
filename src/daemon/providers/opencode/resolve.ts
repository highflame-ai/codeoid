/**
 * opencode binary resolution and the version range codeoid supports.
 *
 * opencode 2.x replaced the whole server API (1.x's `/event`,
 * `permission.updated`, `@opencode-ai/sdk` are gone), so codeoid speaks 2.x
 * only and pins a range. The version is read from the running server's
 * `GET /api/info` (the only authoritative place: a wrapper script can't lie
 * about it), and a server outside the range is refused with this hint.
 */

import { existsSync } from "node:fs";
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
  return join(config?.dbPath ? dirname(config.dbPath) : getConfigDir(), "opencode", "opencode.db");
}

export const OPENCODE_INSTALL_HINT =
  "no opencode binary found — install opencode 2.2 (https://opencode.ai) " +
  "or point providers.opencode.command at a binary";

/** The opencode releases this provider was written and tested against (`>=2.2.0 <2.3.0`). */
export const OPENCODE_SUPPORTED_RANGE = { major: 2, minor: 2 } as const;
export const OPENCODE_SUPPORTED_LABEL = "2.2.x";

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
 * pre-release of a supported minor (`2.2.3-beta.1`) is accepted: the API is
 * the minor's. Anything unparseable is refused — guessing would mean speaking
 * an API the server may not have.
 */
export function opencodeVersionProblem(version: string | undefined): string | null {
  const m = typeof version === "string" ? /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim()) : null;
  if (!m) {
    return `opencode reported version ${JSON.stringify(version ?? null)}, which codeoid can't read; codeoid supports opencode ${OPENCODE_SUPPORTED_LABEL}`;
  }
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major === OPENCODE_SUPPORTED_RANGE.major && minor === OPENCODE_SUPPORTED_RANGE.minor) return null;
  const why =
    major < 2
      ? "opencode 1.x has a different server API"
      : major === OPENCODE_SUPPORTED_RANGE.major && minor < OPENCODE_SUPPORTED_RANGE.minor
        ? "it predates the API codeoid speaks"
        : "codeoid hasn't been checked against it yet";
  return `opencode ${version} is installed, but codeoid supports opencode ${OPENCODE_SUPPORTED_LABEL} (${why}) — install a 2.2 release or point providers.opencode.command at one`;
}
