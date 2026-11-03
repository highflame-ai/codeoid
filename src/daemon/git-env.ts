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
import { Readable } from "node:stream";
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

/** Driver names git config may define that we can neutralize safely. */
const SAFE_DRIVER_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** Every hook event git knows (githooks(5)): each turned off by name, which config-defined hooks (`hook.<name>.command`) obey too. */
export const GIT_HOOK_EVENTS: readonly string[] = [
  "applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit", "prepare-commit-msg",
  "commit-msg", "post-commit", "pre-rebase", "post-checkout", "post-merge", "pre-push", "pre-receive", "update",
  "proc-receive", "post-receive", "post-update", "reference-transaction", "push-to-checkout", "pre-auto-gc",
  "post-rewrite", "sendemail-validate", "fsmonitor-watchman", "p4-changelist", "p4-prepare-changelist",
  "p4-post-changelist", "p4-pre-submit", "post-index-change",
];

/**
 * What every git the daemon runs in a repository an agent can write gets,
 * whatever the repository's config says. Each key git's config documents as
 * naming a program it runs (`git help -c`), turned off: hooks (the hooks dir
 * and config-defined ones, by event), fsmonitor, the alternates' ref command,
 * the editors and pager, an external diff, signing and verifying (gpg's
 * programs and ssh's key command), the git protocol's proxy, auto gc (and the
 * hook it runs), submodule recursion; ssh as itself (`core.sshCommand`), no
 * askpass program from config. Drivers and credential helpers, named per
 * repository, are {@link driverOverrides}'; remote helpers, `ext::`,
 * `file://` (`remote.*.uploadpack`) and `git://` are refused by the
 * protocol allowlist (`GIT_ALLOW_PROTOCOL`, which outranks `protocol.*`).
 * Not reached by the daemon's git: `trailer.*.cmd` (no `--trailer`),
 * `submodule.*.update` (no `submodule update`), tools (`difftool`,
 * `mergetool`, `guitool`, `sendemail`), aliases (builtins win), and
 * `uploadpack.packObjectsHook` (read from the user's own config only). Each
 * is read last-wins, so these (command scope, `GIT_CONFIG_COUNT`) outrank
 * the repository's.
 */
const BASE_OVERRIDES: ReadonlyArray<readonly [string, string]> = [
  ["core.hooksPath", "/dev/null"],
  ...GIT_HOOK_EVENTS.map((e) => [`hook.${e}.enabled`, "false"] as const),
  ["core.fsmonitor", "false"],
  ["core.untrackedCache", "false"],
  ["core.alternateRefsCommand", ""],
  ["core.protectHFS", "true"],
  ["core.protectNTFS", "true"],
  ["core.sshCommand", "ssh"],
  ["core.gitProxy", ""],
  ["core.askPass", ""],
  ["core.editor", ":"],
  ["sequence.editor", ":"],
  ["core.pager", "cat"],
  ["diff.external", ""],
  ["commit.gpgSign", "false"],
  ["tag.gpgSign", "false"],
  ["log.showSignature", "false"],
  ["merge.verifySignatures", "false"],
  ["gpg.program", "false"],
  ["gpg.openpgp.program", "false"],
  ["gpg.x509.program", "false"],
  ["gpg.ssh.program", "false"],
  ["gpg.ssh.defaultKeyCommand", ""],
  ["gc.auto", "0"],
  ["maintenance.auto", "false"],
  ["submodule.recurse", "false"],
];

/** The environment's own say over editors and pagers, which outranks config (`pager.<cmd>` included). */
const PROGRAM_ENV = { GIT_EDITOR: ":", GIT_SEQUENCE_EDITOR: ":", GIT_PAGER: "cat" } as const;

/** The protocols a daemon git that may reach a remote may use: no `file`/`ext` (they run programs here), no `git` (`core.gitProxy`). */
export const REMOTE_PROTOCOLS = "https:ssh";

/** Config scopes an agent can't write: what these say is the user's own. */
const USER_SCOPES = new Set(["system", "global"]);

/** What of a driver's config runs a program, per kind. */
const DRIVER_KEYS: Record<string, readonly string[]> = {
  filter: ["clean", "smudge", "process"],
  diff: ["command", "textconv"],
  merge: ["driver"],
};

interface ScopedEntry {
  scope: string;
  key: string;
  value: string;
}

/** `git config --show-scope --null` output: `scope\0key\nvalue\0` per entry. */
function parseScoped(out: string): ScopedEntry[] {
  const parts = out.split("\0");
  const entries: ScopedEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const kv = parts[i + 1] as string;
    const nl = kv.indexOf("\n");
    entries.push({ scope: parts[i] as string, key: nl < 0 ? kv : kv.slice(0, nl), value: nl < 0 ? "" : kv.slice(nl + 1) });
  }
  return entries;
}

/**
 * Overrides that shut off every program a repository's config names
 * through a driver or a credential helper.
 *
 *   - `strict` (a loop's repository, which must not depend on one): every
 *     filter, diff and merge driver, whoever defined it;
 *   - otherwise (a user's repository): each key an agent could have set
 *     (in any scope but the user's global and system config) — reset, then
 *     the user's own value of it put back, so `git lfs` installed globally
 *     still works and a repository redefining it doesn't. (Only those keys:
 *     an empty `filter.<n>.process` turns that filter's clean and smudge off
 *     too.)
 *
 * Credential helpers named in an agent-writable scope are reset the same
 * way. A driver name that can't be overridden for certain fails closed.
 */
export function driverOverrides(entries: readonly ScopedEntry[], strict: boolean): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const drivers = new Map<string, { kind: string; name: string; agent: Set<string>; user: ScopedEntry[] }>();
  const helpers = new Map<string, { agent: boolean; user: string[] }>();
  for (const e of entries) {
    const agent = !USER_SCOPES.has(e.scope);
    const helper = /^credential\.(?:[\s\S]+\.)?helper$/i.exec(e.key);
    if (helper) {
      // As git prints it: section and name lowercased, a URL subsection as written (it is case-sensitive).
      const h = helpers.get(e.key) ?? { agent: false, user: [] };
      if (agent) h.agent = true;
      else h.user.push(e.value);
      helpers.set(e.key, h);
      continue;
    }
    const m = /^(filter|diff|merge)\.([\s\S]+)\.([^.]+)$/i.exec(e.key);
    if (!m) continue;
    const kind = (m[1] as string).toLowerCase();
    const name = m[2] as string;
    const id = `${kind}\0${name}`;
    const d = drivers.get(id) ?? { kind, name, agent: new Set<string>(), user: [] };
    if (agent) d.agent.add((m[3] as string).toLowerCase());
    else d.user.push(e);
    drivers.set(id, d);
  }
  for (const d of drivers.values()) {
    const run = [...(DRIVER_KEYS[d.kind] ?? []), ...(d.kind === "filter" ? ["required"] : [])];
    // Strict: every key that runs something. Otherwise only what an agent could have set: an
    // empty `process` turns the driver's clean and smudge off too, so the user's own aren't touched.
    const reset = strict ? run : run.filter((k) => d.agent.has(k));
    if (reset.length === 0) continue;
    if (!SAFE_DRIVER_NAME.test(d.name)) {
      throw new Error(`git config defines a ${d.kind} driver named ${JSON.stringify(d.name)} — refusing to run git in this workspace`);
    }
    for (const k of reset) out.push([`${d.kind}.${d.name}.${k}`, k === "required" ? "false" : ""]);
    // The user's own values of those, last (each is read last-wins). Never for a strict caller.
    if (!strict) for (const e of d.user) if (reset.includes(e.key.slice(e.key.lastIndexOf(".") + 1).toLowerCase())) out.push([e.key, e.value]);
  }
  for (const [key, h] of helpers) {
    if (!h.agent) continue;
    // An empty value resets the list read so far; then the user's own helpers again.
    out.push([key, ""]);
    for (const v of h.user) out.push([key, v]);
  }
  return out;
}

/** {@link BASE_OVERRIDES} plus `extra` as git's environment keys (`GIT_CONFIG_COUNT` takes keys and values apart: a name with `=` stays one). */
function overrideEnv(extra: ReadonlyArray<readonly [string, string]>): Record<string, string> {
  const all = [...BASE_OVERRIDES, ...extra];
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(all.length) };
  all.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return env;
}

const DRIVER_PATTERN = "^(filter|diff|merge)\\.|^credential\\..*helper$";

/** Every driver and credential helper git will read in `cwd`, with its scope; exit 1 is "none". */
async function scopedDrivers(cwd: string, env: Record<string, string>, timeout: number): Promise<ScopedEntry[]> {
  try {
    const { stdout } = await execFileAsync(GIT_BIN, ["config", "--show-scope", "--null", "--get-regexp", DRIVER_PATTERN], { cwd, env, timeout, maxBuffer: 4 * 1024 * 1024 });
    return parseScoped(stdout);
  } catch (err) {
    if ((err as { code?: unknown }).code === 1) return [];
    throw err;
  }
}

/**
 * The environment for git the daemon runs in a user's repository an agent
 * can write (a session's workdir or worktree, the repository it was forked
 * from; worktree create and remove, a destroy's snapshot, setup, the
 * status shown in the UI): git-env.ts's environment (never the daemon's
 * credentials, no replace refs), {@link BASE_OVERRIDES}, and the drivers
 * and credential helpers an agent could have defined shut off
 * ({@link driverOverrides}). Without `network` no protocol is allowed and
 * no missing object is fetched; with it, https and ssh only. System config
 * is still read (it is the machine's, not the agent's).
 */
export async function safeGitEnv(cwd: string, opts: { network?: boolean; timeoutMs?: number } = {}): Promise<Record<string, string>> {
  const base = {
    ...gitEnv({ LANG: "C", ...PROGRAM_ENV }, { network: opts.network === true }),
    ...(opts.network ? { GIT_ALLOW_PROTOCOL: REMOTE_PROTOCOLS } : {}),
  };
  return { ...base, ...overrideEnv(driverOverrides(await scopedDrivers(cwd, base, opts.timeoutMs ?? 30_000), false)) };
}

/** git with {@link safeGitEnv}: its stdout. */
export async function safeGit(args: string[], cwd: string, opts: { network?: boolean; timeoutMs?: number; maxBuffer?: number } = {}): Promise<string> {
  const env = await safeGitEnv(cwd, opts);
  const { stdout } = await execFileAsync(GIT_BIN, args, { cwd, env, timeout: opts.timeoutMs ?? 120_000, maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024 });
  return stdout;
}

/**
 * git as the daemon runs it in a repository an agent can write, when nothing
 * should run but git itself (a loop's). The worker can write that
 * repository's config (and its home's), so every way config can make git run
 * a command is shut off: hooks, fsmonitor, and every filter, diff and merge
 * driver any config defines ({@link driverOverrides}, strict), whoever
 * defined it — overridden through GIT_CONFIG_COUNT, which takes keys and
 * values apart (a `-c key=value` splits at the first `=`, so a driver whose
 * name holds one would survive it). A driver name we can't be sure to
 * override fails the command closed. No system config, no bare repository.
 * git gets git-env.ts's environment: never the daemon's credentials, no
 * replace refs, and no network — unless `network` names the one protocol it
 * may use (a loop watch's fetch, which runs in a repository the daemon made,
 * never yours: loops/host.ts ensureCommit).
 */
export async function hardenedGit(
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
  opts: { timeoutMs?: number; maxBuffer?: number; input?: string | Buffer | Readable; network?: "https" | "file" } = {},
): Promise<string> {
  const base = {
    ...gitEnv({ LANG: "C", GIT_CONFIG_NOSYSTEM: "1", ...PROGRAM_ENV, ...extraEnv }, { network: opts.network !== undefined }),
    // Outranks any protocol.* config: this protocol and no other.
    ...(opts.network !== undefined ? { GIT_ALLOW_PROTOCOL: opts.network } : {}),
  };
  const timeout = opts.timeoutMs ?? 60_000;
  const maxBuffer = opts.maxBuffer ?? 16 * 1024 * 1024;
  const run = async (a: string[], env: Record<string, string>, input?: string | Buffer | Readable): Promise<string> => {
    if (input === undefined) return (await execFileAsync(GIT_BIN, a, { cwd, env, timeout, maxBuffer })).stdout;
    return new Promise((res, rej) => {
      let readFailed: Error | null = null;
      const child = execFile(GIT_BIN, a, { cwd, env, timeout, maxBuffer }, (err, stdout) => (readFailed ?? err ? rej(readFailed ?? err) : res(stdout)));
      // git that exits early (a bad repository, a timeout) closes its stdin:
      // that is its error to report, not a crash.
      child.stdin?.on("error", () => {});
      if (input instanceof Readable) {
        // Streamed: a file of any size never sits in memory.
        input.on("error", (err) => {
          readFailed = err;
          child.kill();
        });
        if (child.stdin) input.pipe(child.stdin);
      } else {
        child.stdin?.end(input);
      }
    });
  };
  const env = { ...base, ...overrideEnv([["core.bare", "false"], ...driverOverrides(await scopedDrivers(cwd, base, timeout), true)]) };
  return run(args, env, opts.input);
}
