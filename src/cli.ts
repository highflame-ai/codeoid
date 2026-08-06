#!/usr/bin/env bun
/**
 * Codeoid CLI — terminal interface + daemon launcher.
 *
 * Usage:
 *   codeoid start                         Start daemon (+ Telegram + Web UI)
 *   codeoid ls                            List active sessions
 *   codeoid new <name> <workdir>          Create a new session
 *   codeoid attach <name|id>              Attach to a session (streaming)
 *   codeoid send <name|id> <message>      Send a one-shot message
 *   codeoid interrupt <name|id>           Interrupt a running agent
 *   codeoid approve <name|id> [yes|no]    Approve/deny pending permission
 *   codeoid destroy <name|id>             Destroy a session
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { program } from "commander";
// Single source of truth for the CLI version — bun inlines this JSON at build,
// so `codeoid --version` always matches the published package (no hand-synced
// string to drift). release-smoke asserts these two stay equal.
import pkg from "../package.json" with { type: "json" };
import { DaemonServer } from "./daemon/server.js";
import { parseRoleSpec } from "./daemon/collaboration.js";
import { type ModelBinding, roleBindingsFromSpecs } from "./daemon/pipeline/binding.js";
import {
  assertLocalBindAllowed,
  isLoopbackHost,
  LOCAL_TOKEN_ENV,
  mintLocalToken,
  removeLocalTokenFile,
} from "./daemon/local-auth.js";
import type { CollaborationConfig } from "./protocol/types.js";
import { TerminalClient } from "./terminal/client.js";
import {
  getConfigDir,
  getLocalTokenPath,
  loadConfig,
  loadDotEnv,
  resolveZeroidUrl,
  ZEROID_PRESETS,
} from "./config.js";

program
  .name("codeoid")
  .description("Identity-first remote control plane for AI coding agents")
  .version(pkg.version);

// ── Daemon ────────────────────────────────────────────────────────────────────

program
  .command("start")
  .description("Start the Codeoid daemon with all frontends")
  .option("-p, --port <port>", "Port to listen on", "7400")
  .option("--host <host>", "Host to bind to", "127.0.0.1")
  .option("--no-telegram", "Disable Telegram bot")
  .option("--no-web", "Disable Web UI")
  .option(
    "--local",
    "Run without ZeroID: no account, no login, no network. Mints a token for local clients and binds loopback only. Degraded — no verified identity (see docs/local-mode.md)",
  )
  .option(
    "--local-allow-remote",
    "Permit --local on a non-loopback bind. UNSAFE: the minted token becomes the only thing guarding an agent with shell access",
  )
  .action(async (opts) => {
    // Load ~/.codeoid/.env before anything reads process.env — this is where
    // env-only secrets (TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS) live so
    // they survive daemon restarts regardless of which shell launched it.
    const dotenvKeys = loadDotEnv();
    if (dotenvKeys.length > 0) {
      console.log(
        `[codeoid] loaded ${dotenvKeys.length} var(s) from ~/.codeoid/.env: ${dotenvKeys.join(", ")}`,
      );
    }
    const config = loadConfig();

    // ── Auth posture ──────────────────────────────────────────────
    // Exactly one decision, made here: local mode or the ZeroID path. It
    // reaches the daemon as `localMode` and nothing downstream branches again.
    let localMode: { token: string; tokenFile: string } | undefined;
    const bindHost: string = opts.host;
    const bindPort = Number.parseInt(opts.port, 10);
    if (opts.local) {
      try {
        assertLocalBindAllowed(bindHost, Boolean(opts.localAllowRemote));
      } catch (err) {
        console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
      // An operator-supplied token (CODEOID_LOCAL_TOKEN) lets a container or a
      // script pin it; otherwise mint a fresh one for this process.
      localMode = {
        token: process.env[LOCAL_TOKEN_ENV] || mintLocalToken(),
        // Port-scoped: a second local daemon must not clobber this one's token,
        // nor delete it on its own shutdown.
        tokenFile: getLocalTokenPath(bindPort),
      };
    }

    const daemon = new DaemonServer({
      port: bindPort,
      host: bindHost,
      dbPath: config.dbPath,
      transcriptDir: config.transcriptDir,
      auth: config.auth,
      localMode,
      // ZeroID-dependent subsystems are simply not passed in local mode. (The
      // daemon guards these too — belt and suspenders — so an embedder that
      // builds its own DaemonConfig gets the same offline guarantee.)
      oauth: localMode ? undefined : config.oauth,
      agentIdentity: localMode ? undefined : config.agentIdentity,
      memory: config.memory?.enabled
        ? {
            dbPath: config.memory.dbPath,
            model: config.memory.model,
            modelCacheDir: config.memory.modelCacheDir,
          }
        : undefined,
      // Forward the full config so session-level features (compress, etc.)
      // get the parsed shape rather than re-reading env/file.
      fullConfig: config,
    });

    // ── Register frontends ────────────────────────────────────────

    // Web UI (always enabled unless --no-web) — the SolidJS app at /ui,
    // single-origin so one HTTPS tunnel also serves as a Telegram Mini App.
    if (opts.web !== false) {
      const { WebUiFrontend } = await import("./frontends/web-ui/index.js");
      // In local mode on a loopback bind, hand the browser the token directly so
      // /ui needs no sign-in at all. On a wide bind we deliberately do NOT — the
      // HTML would be readable by anything that can reach the port — so the
      // operator pastes the token into the sign-in box instead.
      const injectToken =
        localMode && isLoopbackHost(bindHost) ? localMode.token : undefined;
      // Thread the embed-SSO allowlist so the served index.html publishes it to
      // the web UI's trusted-framing-origin gate. Empty ⇒ hash handoff disabled.
      daemon.use(new WebUiFrontend(config.embed?.allowedOrigins ?? [], injectToken));
    }

    // Telegram (enabled when TELEGRAM_BOT_TOKEN is set)
    if (opts.telegram !== false) {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      const allowedIds = (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
        .split(",")
        .map(Number)
        .filter(Boolean);

      if (botToken && localMode) {
        // Telegram is reached through Telegram's servers — a remote surface.
        // Local mode's trust model is "whoever can read a file on this box".
        // Those two do not belong together, so this is a hard skip, not a
        // warning-and-continue. (The frontend itself also refuses.)
        console.warn(
          "[codeoid] local mode: Telegram frontend NOT started (it needs ZeroID identities). " +
            "Run `codeoid login` and start without --local to use it.",
        );
      } else if (botToken && allowedIds.length > 0) {
        const { TelegramFrontend } = await import("./frontends/telegram/index.js");
        daemon.use(new TelegramFrontend(botToken, allowedIds));
      } else if (botToken) {
        console.log("[codeoid] TELEGRAM_BOT_TOKEN set but TELEGRAM_ALLOWED_USER_IDS missing — skipping Telegram");
      }
    }

    await daemon.start();

    // ZeroID mode: sweep a stale local-mode token for THIS port. Reaching here
    // means we successfully bound it, so no local-mode daemon can be listening
    // on it, so any token file left by one (killed -9, power loss — the graceful
    // path removes its own) is definitively dead. Without this, clients would
    // keep presenting it and get an opaque 4003 against a ZeroID daemon.
    // Deliberately AFTER the bind — doing it before would delete a live
    // daemon's credential when our own bind then failed with EADDRINUSE.
    if (!localMode) {
      removeLocalTokenFile(getLocalTokenPath(bindPort));
    }

    const displayHost = bindHost === "0.0.0.0" || bindHost === "::" ? "localhost" : bindHost;
    if (opts.web !== false) {
      console.log(`[codeoid] web UI: http://${displayHost}:${opts.port}/ui/`);
    }

    if (localMode) {
      printLocalModeBanner({
        token: localMode.token,
        tokenFile: localMode.tokenFile,
        host: displayHost,
        port: String(opts.port),
        loopback: isLoopbackHost(bindHost),
        web: opts.web !== false,
      });
    }
  });

/**
 * The post-start local-mode banner.
 *
 * Prints what the operator needs to do next and what they gave up, in that
 * order. The token is printed on purpose (the Jupyter model): it is a
 * loopback-scoped, process-lifetime credential, and printing it is what makes
 * the mode usable from a second terminal without any setup step.
 */
function printLocalModeBanner(o: {
  token: string;
  tokenFile: string;
  host: string;
  port: string;
  loopback: boolean;
  web: boolean;
}): void {
  const lines: string[] = [
    "",
    "  Codeoid is running in LOCAL MODE — no ZeroID, no account, no login.",
    "",
    "  Connect from another terminal (the token is picked up automatically):",
    "      codeoid tui",
    "      codeoid new demo .        # then: codeoid send demo \"summarize this repo\"",
    "",
  ];
  if (o.web) {
    lines.push(
      o.loopback
        ? `  Or open the web UI — already signed in:  http://${o.host}:${o.port}/ui/`
        : `  Or open the web UI and paste the token below:  http://${o.host}:${o.port}/ui/`,
      "",
    );
  }
  lines.push(
    `  Token:  ${o.token}`,
    `          (also at ${o.tokenFile}, removed on shutdown; set CODEOID_LOCAL_TOKEN to pin it)`,
    "",
    "  What is OFF in this mode: per-agent and sub-agent identity, delegation,",
    "  scope attenuation, revocation, cryptographic audit attribution, sharing.",
    "  Audit still records every action, but the principal is self-asserted.",
    "",
    "  What still works: memory + recall, every backend, cross-backend fork,",
    "  conductor + dispatch, compression, worktrees, cost telemetry, TUI + web.",
    "",
    "  Sessions here live in the reserved `local/local` tenant, so they will NOT",
    "  appear after a later `codeoid login`. That is isolation, not data loss.",
    "",
    "  Ready for real identities?  codeoid login    (docs/local-mode.md)",
    "",
  );
  console.log(lines.join("\n"));
}

// ── Auth ──────────────────────────────────────────────────────────────────────

/** The full scope set codeoid asks ZeroID to mint for a session-driving key. */
const CODEOID_LOGIN_SCOPES = [
  "session:create",
  "session:list",
  "session:attach",
  "session:watch",
  "session:send",
  "session:interrupt",
  "session:approve",
  "session:destroy",
  // Conductor scopes — the owner delegates these to its conductor identity
  // (owner → conductor RFC 8693 exchange). Without them in the owner's token
  // the delegation's scope intersection is empty and the conductor can't act.
  "session:read",
  "session:dispatch",
  "fs:read",
  "tools:read",
  "tools:write",
  "tools:execute",
  "tools:agent",
].join(" ");

/** Read a secret from the TTY without echoing it (handles paste + backspace). */
function readSecret(promptText: string): Promise<string> {
  process.stdout.write(promptText);
  const stdin = process.stdin;
  // Non-TTY (piped) input: read a single line plainly.
  if (!stdin.isTTY) {
    return new Promise((resolve) => {
      let buf = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (c: string) => {
        buf += c;
      });
      stdin.on("end", () => resolve(buf.trim()));
    });
  }
  return new Promise((resolve) => {
    stdin.setRawMode(true);
    stdin.resume();
    let buf = "";
    const onData = (chunk: Buffer): void => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(buf.trim());
          return;
        }
        if (ch === "\u0003") process.exit(130); // Ctrl-C
        else if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** Merge-write the raw config.json (preserves existing keys, no defaults baked in). */
function writeConfigKeys(updates: Record<string, unknown>): string {
  const dir = getConfigDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "config.json");
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      // Corrupt file — refuse to clobber silently.
      throw new Error(`Existing ${path} is not valid JSON; fix or remove it first.`);
    }
  }
  const merged = { ...current, ...updates };
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  return path;
}

program
  .command("login [apiKey]")
  .description(
    "Authenticate with a ZeroID key (mint one in Studio's Code Agents screen). Stores it in ~/.codeoid/config.json.",
  )
  .option(
    "--zeroid <preset-or-url>",
    `ZeroID issuer: ${Object.keys(ZEROID_PRESETS).join(" | ")} | <url> (default: highflame SaaS)`,
  )
  .option("--no-verify", "Skip the token-exchange check and just save the key")
  .action(
    async (
      apiKeyArg: string | undefined,
      opts: { zeroid?: string; verify?: boolean },
    ) => {
      // Resolve the issuer: explicit --zeroid wins, else whatever config resolves to.
      const issuerInput = opts.zeroid;
      const baseUrl = issuerInput
        ? resolveZeroidUrl(issuerInput)
        : loadConfig().zeroidUrl;

      const apiKey =
        apiKeyArg ??
        process.env.CODEOID_API_KEY ??
        (await readSecret("Paste your ZeroID key (zid_sk_...): "));
      if (!apiKey) {
        console.error("No key provided.");
        process.exit(1);
      }

      // Verify by exchanging the key for a token (unless --no-verify).
      if (opts.verify !== false) {
        process.stdout.write(`Verifying against ${baseUrl} ... `);
        try {
          const res = await fetch(`${baseUrl}/oauth2/token`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              grant_type: "api_key",
              api_key: apiKey,
              scope: CODEOID_LOGIN_SCOPES,
            }),
          });
          if (!res.ok) {
            console.error(`failed (HTTP ${res.status}).`);
            console.error(`  ${(await res.text()).slice(0, 300)}`);
            process.exit(1);
          }
          const body = (await res.json()) as { access_token?: string };
          if (!body.access_token) {
            console.error("failed: no access_token in response.");
            process.exit(1);
          }
          const claims = JSON.parse(
            Buffer.from(body.access_token.split(".")[1] ?? "", "base64").toString("utf8"),
          ) as { sub?: string; scope?: string[]; scopes?: string[] };
          console.log("ok.");
          console.log(`  subject: ${claims.sub ?? "(unknown)"}`);
          const scopes = claims.scope ?? claims.scopes ?? [];
          console.log(`  scopes:  ${scopes.length ? scopes.join(", ") : "(none)"}`);
        } catch (err) {
          console.error(`failed: ${err instanceof Error ? err.message : String(err)}`);
          console.error(`  (Is ${baseUrl} reachable? Override with --zeroid.)`);
          process.exit(1);
        }
      }

      // Persist. Store the issuer symbolically (preset name or URL as given) so
      // the file stays readable; only touch zeroidUrl when --zeroid was passed.
      const updates: Record<string, unknown> = { apiKey };
      if (issuerInput) updates.zeroidUrl = issuerInput;
      const path = writeConfigKeys(updates);
      console.log(`Saved to ${path} (mode 600).`);
      console.log(
        "Next: start the daemon with `codeoid start` (or `bun src/cli.ts start` from a source checkout).",
      );
    },
  );

// ── Session commands ──────────────────────────────────────────────────────────

program
  .command("ls")
  .description("List active sessions")
  .action(async () => {
    const config = loadConfig();
    const client = new TerminalClient(config);
    await client.connect();
    await client.listSessions();
    client.disconnect();
  });

program
  .command("new <name> [workdir]")
  .description("Create a new agent session. With --worktree, auto-spawns a git worktree.")
  .option(
    "--worktree <branch>",
    "Create a git worktree for <branch> and run the session there. Requires being inside a git repo (or pass --repo).",
  )
  .option(
    "--repo <path>",
    "Path to the source git repo (defaults to current directory when --worktree is set).",
  )
  .option(
    "--worktree-dir <path>",
    "Override the worktree directory (default: <repo>.wt-<branch>).",
  )
  .option(
    "--provider <id>",
    "Agent backend for this session (claude | codex | gemini-cli | pi | openai | gemini). Default: the daemon's default.",
  )
  .option(
    "--model <id>",
    "Model for this session (validated against --provider). Omitted with --pack/--pack-role, the model resolves through the role's binding chain (config override → role pin → tier map).",
  )
  .option(
    "--pack <id>",
    "Activate an installed SDLC pack on the session (inject its constitution, expose its skills/subagents). With --collaborate, the collaboration ADOPTS the pack: role names bind strictly to the pack's declared roles.",
  )
  .option(
    "--pack-role <role>",
    "Run the session under a capability role the pack declares (e.g. reviewer = read-only). Requires --pack; not valid with --collaborate.",
  )
  .option(
    "--collaborate <goal>",
    "Make this a collaborative session working <goal> with several role-children on their own backends. Requires at least one --role, including an orchestrator.",
  )
  .option(
    "--role <spec>",
    'Role→backend binding, repeatable: "name:provider[:model][*count]" (e.g. orchestrator:claude, reasoning:openai:gpt-5-codex, review:gemini*3). Requires --collaborate.',
    (value: string, previous: string[] = []) => [...previous, value],
    [] as string[],
  )
  .action(
    async (
      name: string,
      workdir: string | undefined,
      opts: {
        worktree?: string;
        repo?: string;
        worktreeDir?: string;
        provider?: string;
        model?: string;
        pack?: string;
        packRole?: string;
        collaborate?: string;
        role: string[];
      },
    ) => {
      const config = loadConfig();
      let resolvedWorkdir = workdir;
      if (opts.worktree) {
        const { createWorktree } = await import("./worktree.js");
        resolvedWorkdir = await createWorktree({
          branch: opts.worktree,
          repo: opts.repo ?? process.cwd(),
          workdir: opts.worktreeDir,
        });
        console.log(`[codeoid] worktree ready: ${resolvedWorkdir}`);
      }
      if (!resolvedWorkdir) {
        console.error("workdir is required (pass as argument or use --worktree).");
        process.exit(1);
      }

      // Collaborative session (docs/collaborative-session-design.md). Parsed
      // here for a fast, local error; the daemon re-validates the semantics
      // (provider registered, exactly one orchestrator, claude-only
      // orchestrator in v1) so the CLI and the wire path fail identically.
      let collaboration: CollaborationConfig | undefined;
      const roleSpecs = opts.role ?? [];
      if (opts.collaborate) {
        if (roleSpecs.length === 0) {
          console.error(
            '--collaborate requires at least one --role (e.g. --role orchestrator:claude --role review:gemini*3).',
          );
          process.exit(1);
        }
        try {
          collaboration = {
            goal: opts.collaborate,
            roles: roleSpecs.map(parseRoleSpec),
          };
        } catch (e) {
          console.error(e instanceof Error ? e.message : String(e));
          process.exit(1);
        }
      } else if (roleSpecs.length > 0) {
        console.error("--role requires --collaborate <goal>.");
        process.exit(1);
      }

      const client = new TerminalClient(config);
      await client.connect();
      await client.createSession(name, resolvedWorkdir, {
        providerId: opts.provider,
        model: opts.model,
        pack: opts.pack,
        packRole: opts.packRole,
        collaboration,
      });
      client.disconnect();
    },
  );

program
  .command("attach <session>")
  .description(
    "Attach to a session by id or name (interactive streaming). Use 'conductor' to open the fleet supervisor (created on first use).",
  )
  .action(async (session: string) => {
    const config = loadConfig();
    const client = new TerminalClient(config);
    await client.connect();
    await client.attachSession(session);
  });

program
  .command("tui")
  .description("Interactive multi-session cockpit (Ink-based TUI)")
  .action(async () => {
    const config = loadConfig();
    const { startTui } = await import("./tui/index.js");
    await startTui(config);
  });

program
  .command("send <session> <message...>")
  .description("Send a message to a session")
  .action(async (session: string, messageParts: string[]) => {
    const config = loadConfig();
    const client = new TerminalClient(config);
    await client.connect();
    await client.sendMessage(session, messageParts.join(" "));
    client.disconnect();
  });

program
  .command("interrupt <session>")
  .description("Interrupt a running agent")
  .action(async (session: string) => {
    const config = loadConfig();
    const client = new TerminalClient(config);
    await client.connect();
    await client.interruptSession(session);
    client.disconnect();
  });

program
  .command("approve <session>")
  .description("Approve a pending permission request")
  .option("--deny", "Deny instead of approve")
  .action(async (session: string, opts: { deny?: boolean }) => {
    const config = loadConfig();
    const client = new TerminalClient(config);
    await client.connect();
    await client.approveSession(session, !opts.deny);
    client.disconnect();
  });

program
  .command("destroy <session>")
  .description("Destroy a session")
  .action(async (session: string) => {
    const config = loadConfig();
    const client = new TerminalClient(config);
    await client.connect();
    await client.destroySession(session);
    client.disconnect();
  });

// ── Packs (dynamic pack loading — docs/pack-loading.md) ─────────────────────

/** Connect, run one pack command, disconnect. */
async function withClient(fn: (c: TerminalClient) => Promise<void>): Promise<void> {
  const client = new TerminalClient(loadConfig());
  await client.connect();
  try {
    await fn(client);
  } finally {
    client.disconnect();
  }
}

const pack = program.command("pack").description("Manage SDLC packs + registries (docs/pack-loading.md)");

pack
  .command("list")
  .description("List installed + available packs and configured registries")
  .action(() => withClient((c) => c.packList()));

const registry = pack.command("registry").description("Manage pack registries (git repos of packs)");
registry
  .command("add <git-url>")
  .description("Clone/cache a pack registry so its packs become installable")
  .option("--name <name>", "Registry name (default: derived from the URL)")
  .option("--ref <ref>", "Git branch/tag/commit to clone")
  .action((url: string, opts: { name?: string; ref?: string }) => withClient((c) => c.packRegistryAdd(url, opts)));

pack
  .command("install <id>")
  .description("Install a pack — by its registry id, or with --dir treat <id> as a local pack directory")
  .option("--trust", "Trust the pack to run host `command` gates (default: untrusted)")
  .option("--dir", "Interpret <id> as a local pack directory path instead of a registry id")
  .action((id: string, opts: { trust?: boolean; dir?: boolean }) =>
    withClient((c) => c.packInstall(id, { trusted: opts.trust, dir: opts.dir })),
  );

pack
  .command("show <id>")
  .description("Show a pack's phases, roles, gates, and trust state")
  .option(
    "--resolve",
    "Also show each role's effective model binding under this daemon's config (the pre-flight view), plus any phase-level pins",
  )
  .action((id: string, opts: { resolve?: boolean }) =>
    withClient((c) => c.packShow(id, { resolve: opts.resolve })),
  );

pack
  .command("trust <id>")
  .description("Trust an installed pack to run host command gates")
  .option("--off", "Remove trust instead of granting it")
  .action((id: string, opts: { off?: boolean }) => withClient((c) => c.packTrust(id, !opts.off)));

pack
  .command("select <id>")
  .description("Set the default pack (a pipeline created without one uses it). Pass 'none' to clear.")
  .action((id: string) => withClient((c) => c.packSelect(id === "none" ? null : id)));

pack
  .command("remove <id>")
  .description("Uninstall a pack")
  .action((id: string) => withClient((c) => c.packRemove(id)));

// ── Pipeline runs (docs/pipeline-run.md) ────────────────────────────────────

const pipeline = program
  .command("pipeline")
  .description("Run a governed SDLC pipeline from an installed pack (spec → ship, gated)");

pipeline
  .command("run")
  .description("Start a run: create from a pack with a goal, then auto-advance through the phases")
  .requiredOption("--pack <id>", "Installed pack to run")
  .requiredOption("--goal <text>", "The feature / goal seeding the run")
  .option("--workdir <path>", "Repo the phases operate in (default: current directory)")
  .option(
    "--role <spec>",
    'Bind a role to a backend for this run, repeatable: "name:provider[:model]" (e.g. adversary:claude:claude-fable-5). Outranks config maps and pack pins. No *count — pipelines run one session per phase.',
    (value: string, previous: string[] = []) => [...previous, value],
    [] as string[],
  )
  .action((opts: { pack: string; goal: string; workdir?: string; role: string[] }) => {
    // Same grammar as collab `--role` (one grammar everywhere —
    // docs/role-model-binding.md §2.3). The *count rejection is CLI-only — the
    // wire `roleBindings` shape has no count field, so a raw wire client can't
    // express one. The semantic checks (role exists, provider registered)
    // re-run daemon-side so the CLI and the wire path fail identically.
    let roleBindings: Record<string, ModelBinding> | undefined;
    if (opts.role.length > 0) {
      try {
        roleBindings = roleBindingsFromSpecs(opts.role.map(parseRoleSpec));
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
      }
    }
    return withClient((c) => c.pipelineRun(opts.pack, opts.goal, opts.workdir ?? process.cwd(), roleBindings));
  });

pipeline
  .command("list")
  .description("List pipeline runs")
  .action(() => withClient((c) => c.pipelineList()));

pipeline
  .command("status <id>")
  .description("Show a run's phase progress + any pending halt")
  .action((id: string) => withClient((c) => c.pipelineStatus(id)));

pipeline
  .command("approve <id>")
  .description("Approve the halted phase and continue to the next")
  .option("--note <text>", "Optional note recorded as the phase summary")
  .action((id: string, opts: { note?: string }) => withClient((c) => c.pipelineDecide(id, "approve", opts.note)));

pipeline
  .command("reject <id>")
  .description("Reject the halted phase and stop the run")
  .option("--note <text>", "Optional reason")
  .action((id: string, opts: { note?: string }) => withClient((c) => c.pipelineDecide(id, "reject", opts.note)));

pipeline
  .command("revise <id> <feedback...>")
  .description("Re-run the halted phase with your feedback (loop until satisfied, then approve)")
  .action((id: string, feedback: string[]) => withClient((c) => c.pipelineDecide(id, "revise", feedback.join(" "))));

program.parse();
