/**
 * How the daemon runs git in a repository an agent can write.
 *
 * An agent can write the repository's config (and its home's), and config can
 * make git run commands: filter drivers, a promisor remote's lazy fetch over
 * `core.sshCommand`. Whatever git runs inherits git's environment, so git never
 * gets the daemon's: it gets the safe basics an agent's own commands get
 * (providers/env.ts), never a credential. Replace refs are ignored, so an
 * object id means its content. Without `network`, no protocol is allowed and
 * no missing object is fetched, so no remote config can be reached at all.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildSubprocessEnv } from "./providers/env.js";

const execFileAsync = promisify(execFile);

/** git, resolved once at startup: a `git` placed earlier on `PATH` later isn't picked up. */
export const GIT_BIN: string = (typeof Bun !== "undefined" ? Bun.which("git") : null) ?? "git";

/**
 * What git that reaches a remote takes from your environment: how it connects
 * and authenticates (SSH, askpass, TLS trust, Kerberos), and git's own knobs
 * for that. More passes with `CODEOID_AGENT_ENV_ALLOW`, as everywhere.
 */
const NETWORK_EXACT = [
  "GIT_SSH", "GIT_SSH_COMMAND", "GIT_SSH_VARIANT", "GIT_ASKPASS", "SSH_ASKPASS", "SSH_ASKPASS_REQUIRE", "DISPLAY",
  "GIT_SSL_CAINFO", "GIT_SSL_CAPATH", "GIT_SSL_NO_VERIFY", "GIT_PROXY_COMMAND", "GIT_LFS_SKIP_SMUDGE",
  "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM", "KRB5CCNAME", "GNUPGHOME",
] as const;

export function gitEnv(extra: Record<string, string> = {}, opts: { network?: boolean } = {}): Record<string, string> {
  return {
    ...buildSubprocessEnv({ prefixes: ["XDG_"], exact: ["SSH_AUTH_SOCK", ...(opts.network ? NETWORK_EXACT : [])] }),
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    ...(opts.network ? {} : { GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "none" }),
    ...extra,
  };
}

/** Filter driver names git config may define that we can neutralize safely. */
const SAFE_DRIVER_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * git as the daemon runs it in a repository an agent can write, when nothing
 * should run but git itself. The worker can write that
 * repository's config (and its home's), so every way config can make git run a
 * command is shut off: hooks, fsmonitor, and every filter driver any config
 * defines — overridden through GIT_CONFIG_COUNT, which takes keys and values
 * apart (a `-c key=value` splits at the first `=`, so a driver whose name holds
 * one would survive it). A driver name we can't be sure to override fails the
 * command closed. git gets git-env.ts's environment: never the daemon's
 * credentials, no replace refs, and no network — unless `network` names the
 * one protocol it may use (a loop watch's fetch, which runs in a repository
 * the daemon made, never yours: loops/host.ts ensureCommit).
 */
export async function hardenedGit(
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
  opts: { timeoutMs?: number; maxBuffer?: number; input?: string | Buffer; network?: "https" | "file" } = {},
): Promise<string> {
  const base = {
    ...gitEnv({ LANG: "C", GIT_CONFIG_NOSYSTEM: "1", ...extraEnv }, { network: opts.network !== undefined }),
    // Outranks any protocol.* config: this protocol and no other.
    ...(opts.network !== undefined ? { GIT_ALLOW_PROTOCOL: opts.network } : {}),
  };
  const timeout = opts.timeoutMs ?? 60_000;
  const maxBuffer = opts.maxBuffer ?? 16 * 1024 * 1024;
  const run = async (a: string[], env: Record<string, string>, input?: string | Buffer): Promise<string> => {
    if (input === undefined) return (await execFileAsync(GIT_BIN, a, { cwd, env, timeout, maxBuffer })).stdout;
    return new Promise((res, rej) => {
      const child = execFile(GIT_BIN, a, { cwd, env, timeout, maxBuffer }, (err, stdout) => (err ? rej(err) : res(stdout)));
      // git that exits early (a bad repository, a timeout) closes its stdin:
      // that is its error to report, not a crash.
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    });
  };
  const overrides: Array<[string, string]> = [
    ["core.hooksPath", "/dev/null"],
    ["core.fsmonitor", "false"],
    ["core.untrackedCache", "false"],
    ["core.bare", "false"],
    ["core.protectHFS", "true"],
    ["core.protectNTFS", "true"],
    ["commit.gpgsign", "false"],
    ["diff.external", ""],
  ];
  let drivers = "";
  try {
    drivers = await run(["config", "--null", "--name-only", "--get-regexp", "^filter\\."], base);
  } catch {
    // `config --get-regexp` exits 1 when nothing matches.
  }
  const names = new Set<string>();
  for (const key of drivers.split("\0").filter(Boolean)) {
    const m = /^filter\.([\s\S]+)\.[^.]+$/.exec(key);
    if (!m) continue;
    if (!SAFE_DRIVER_NAME.test(m[1]!)) {
      throw new Error(`git config defines a filter driver named ${JSON.stringify(m[1])} — refusing to run git in this workspace`);
    }
    names.add(m[1]!);
  }
  for (const n of names) {
    for (const k of ["clean", "smudge", "process"]) overrides.push([`filter.${n}.${k}`, ""]);
    overrides.push([`filter.${n}.required`, "false"]);
  }
  const env: Record<string, string> = { ...base, GIT_CONFIG_COUNT: String(overrides.length) };
  overrides.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return run(args, env, opts.input);
}
