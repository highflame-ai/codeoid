/**
 * Keeps codeoid's per-session tokens out of the commands Codex runs (#396).
 *
 * Codex hands its MCP clients their tokens by env var (`bearer_token_env_var`:
 * the proxy, memory and blackboard tokens), and every command it runs
 * inherits its environment unless `shell_environment_policy` drops a
 * variable. Its default excludes (names containing KEY, SECRET or TOKEN)
 * would — but a user can turn those off. So codeoid always names its own
 * token variables in `exclude`. `-c` replaces the whole list, so the user's
 * own entries are read from their config and passed back with it.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Every per-session token variable codeoid gives Codex. */
export const CODEOID_TOKEN_ENV_GLOB = "CODEOID_*_TOKEN";

/**
 * The `-c` override, or null when the user's config can't be read here (a
 * TOML feature Bun's parser lacks, say): then their own list can't be kept,
 * and replacing it would hand the agent variables they excluded — so nothing
 * is overridden, and the caller mounts nothing that needs it.
 */
export function codexShellEnvExcludeArgs(
  env: Record<string, string | undefined> = process.env,
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
): string[] | null {
  const home = env.CODEX_HOME || join(env.HOME || homedir(), ".codex");
  let text: string;
  try {
    text = read(join(home, "config.toml"));
  } catch {
    text = ""; // no config: nothing of the user's to keep
  }
  let user: string[] = [];
  try {
    const cfg = Bun.TOML.parse(text) as { shell_environment_policy?: { exclude?: unknown } };
    const exclude = cfg.shell_environment_policy?.exclude;
    if (Array.isArray(exclude)) user = exclude.filter((x): x is string => typeof x === "string");
  } catch {
    return null;
  }
  const list = user.includes(CODEOID_TOKEN_ENV_GLOB) ? user : [...user, CODEOID_TOKEN_ENV_GLOB];
  return ["-c", `shell_environment_policy.exclude=${JSON.stringify(list)}`];
}

/** A server name usable as a `-c mcp_servers.<name>` key segment: Codex splits
 *  the key on dots, so a name with one (or a space, a quote) would land
 *  somewhere else in its config. */
export function codexKeySafe(name: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(name);
}
