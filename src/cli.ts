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
 *   codeoid undo <name|id> [files [yes|force]]  Take back the last message
 *   codeoid fork <name|id> [--at N]       Fork (after prompt N, with its files)
 *   codeoid skill allow <command>          Pre-approve a skill's command (unattended runs)
 *   codeoid destroy <name|id>             Destroy a session
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { type Command, program } from "commander";
// Single source of truth for the CLI version — bun inlines this JSON at build,
// so `codeoid --version` always matches the published package (no hand-synced
// string to drift). release-smoke asserts these two stay equal.
import pkg from "../package.json" with { type: "json" };
import { DaemonServer } from "./daemon/server.js";
import { DefaultProviderError } from "./daemon/providers/registry.js";
import { parseRoleSpec } from "./daemon/collaboration.js";
import { type ModelBinding, roleBindingsFromSpecs } from "./daemon/pipeline/binding.js";
import {
  assertLocalBindAllowed,
  isLoopbackHost,
  LOCAL_TOKEN_ENV,
  mintLocalToken,
  removeLocalTokenFile,
} from "./daemon/local-auth.js";
import {
  CAPABILITIES,
  type CollaborationConfig,
  type RoutineScheduleWire,
  type RoutineSpecWire,
  routineFirePath,
} from "./protocol/types.js";
import { ALL_SCOPES_STRING } from "./protocol/scopes.js";
import { TerminalClient } from "./terminal/client.js";
import { formatAccounts, formatClaudeAccounts, parseHeaderFlags } from "./terminal/claude-accounts.js";
import { formatEndpoints, importPiModels, parseModelFlags, parseTokens } from "./terminal/endpoints.js";
import type { ClientMessage, DaemonMessage, SessionInfo } from "./protocol/types.js";
import { mcpConfig, mcpHeaders } from "./terminal/mcp-control-cli.js";
import { cleartextOffHost, controlUrl, MCP_SCOPE_PRESETS, TokenError } from "./terminal/token.js";
import { parseTargets } from "./terminal/compare.js";
import {
  formatRoutine,
  formatRoutineList,
  formatRun,
  type RoutineFlags,
  relativeTime,
  scheduleFromFlags,
  specFromFlags,
} from "./terminal/routine-format.js";
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

    let daemon: DaemonServer;
    try {
      daemon = new DaemonServer({
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
              embeddings: config.memory.embeddings,
            }
          : undefined,
        // Forward the full config so session-level features (compress, etc.)
        // get the parsed shape rather than re-reading env/file.
        fullConfig: config,
      });
    } catch (err) {
      // A misconfigured default backend is operator error: say what to fix
      // and stop. Anything else is a bug and keeps its stack trace.
      if (!(err instanceof DefaultProviderError)) throw err;
      console.error(`\n[codeoid] ${err.message}\n`);
      process.exit(1);
    }

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

/**
 * The full scope set codeoid asks ZeroID to mint for a session-driving key.
 *
 * DERIVED, never hand-listed. This was previously a literal array that drifted
 * from the canonical set in both directions: it omitted seven real scopes
 * (`settings:read`/`settings:write`, `fleet:read`, and all four `pipeline:*`)
 * and requested four that were never scopes at all (`tools:*`). A login token
 * therefore could not reach the settings screen, the fleet board, or any
 * pipeline verb — which surfaced as a bare "Missing scope: settings:read" on a
 * daemon whose config was otherwise fine, and which no amount of re-login or
 * ZeroID upgrading could fix.
 *
 * `ALL_SCOPES` is the single source of truth (`ALL_SCOPES_STRING` is the same
 * join, already used by the terminal + TUI clients). `login-scope-drift.test.ts`
 * fails if a future scope is added and this silently falls behind again.
 *
 * Note this is an OWNER-tier token: it includes `settings:write` and
 * `pipeline:manage`. That matches the single-operator daemon codeoid is built
 * for — the key is minted by, and for, the person who runs it. Delegated or
 * shared access is expressed by exchanging this token DOWN (the conductor and
 * watcher paths already do exactly that), not by under-minting it here.
 */
const CODEOID_LOGIN_SCOPES = ALL_SCOPES_STRING;

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

// ── Accounts for every backend (accounts.ts; Claude's — claude-accounts.ts) ──

const account = program
  .command("account")
  .description(
    "Accounts for every backend: several credentials per backend (Claude subscriptions, ChatGPT sign-ins, API keys…), a default per backend, and a per-session choice",
  );

/** Run one account request against the daemon and print the result. */
async function accountRequest(build: (id: string) => ClientMessage, onOk?: (resp: DaemonMessage) => void): Promise<void> {
  const config = loadConfig();
  const client = new TerminalClient(config);
  await client.connect();
  const resp = await client.request(build(randomUUID()));
  client.disconnect();
  if (resp.type === "response.error") {
    console.error(`Error: ${resp.error}`);
    process.exitCode = 1;
    return;
  }
  if (resp.type === "claude.accounts.result") console.log(formatClaudeAccounts(resp.accounts, resp.defaultAccount));
  if (resp.type === "accounts.result") console.log(formatAccounts(resp.backends));
  onOk?.(resp);
}

const backendOption = "--backend <id>";
const backendHelp = "the backend the account is for: claude, codex, gemini-cli, openai, gemini, qwen, pi, llamacpp, or oai:<endpoint> (default: claude)";

account
  .command("ls")
  .description("List accounts and defaults — every backend, or one")
  .option(backendOption, "only this backend")
  .action((o: { backend?: string }) => accountRequest((id) => ({ type: "accounts.list", id, ...(o.backend ? { backend: o.backend } : {}) })));

account
  .command("login <name>")
  .description(
    "Sign in as account <name>: a Claude Pro/Max subscription (claude setup-token), a ChatGPT account for codex (device code), or a Google account for gemini-cli. Never touches your own login.",
  )
  .option(backendOption, "claude (default), codex, or gemini-cli")
  .option("--replace", "replace an existing account of that name")
  .action(async (name: string, o: { backend?: string; replace?: boolean }) => {
    const backend = (o.backend ?? "claude") as "claude" | "codex" | "gemini-cli";
    const config = loadConfig();
    const client = new TerminalClient(config);
    await client.connect();
    const started = await client.request({ type: "backend.login.start", id: randomUUID(), backend, account: name, ...(o.replace ? { replace: true } : {}) });
    if (started.type !== "backend.login.start.result") {
      client.disconnect();
      console.error(`Error: ${started.type === "response.error" ? started.error : started.type}`);
      process.exit(1);
    }
    const { login } = started;
    let done: DaemonMessage;
    if (login.mode === "device") {
      console.log(`\nOpen this link in a browser and sign in to the account you want as "${name}":\n\n  ${login.verificationUrl}\n\nThen enter this code there:  ${login.userCode}\n`);
      console.log("Waiting for you to approve…");
      done = await client.request({ type: "backend.login.wait", id: randomUUID(), loginId: login.loginId });
    } else {
      console.log(`\nOpen this URL in a browser signed in to the account you want as "${name}":\n\n  ${login.verificationUrl}\n`);
      console.log(login.codeHint);
      const code = await readSecret("Code: ");
      done = await client.request({ type: "backend.login.submit", id: randomUUID(), loginId: login.loginId, code });
    }
    client.disconnect();
    if ((done.type === "backend.login.submit.result" || done.type === "backend.login.wait.result") && done.ok) {
      console.log(`Signed in. The ${backend} account "${name}" is ready — use it with: codeoid account use <session> ${name}`);
    } else {
      const error =
        done.type === "backend.login.submit.result" || done.type === "backend.login.wait.result"
          ? (done.error ?? "sign-in failed")
          : done.type === "response.error"
            ? done.error
            : done.type;
      console.error(`Error: ${error}`);
      process.exit(1);
    }
  });

account
  .command("add-key <name>")
  .description(
    "Add an API-key account for a backend — the key is asked for without echo (or read from stdin), never taken from the command line. pi takes --key-var per provider key; an endpoint may take headers instead of, or with, a key.",
  )
  .requiredOption(backendOption, backendHelp)
  .option("--base-url <url>", "qwen: the endpoint — a preset (dashscope-intl, dashscope-cn, bailian-plan-intl) or an https URL")
  .option("--header <header>", 'endpoint accounts: extra request header, repeatable: "Name" (value asked for without echo) or "Name: value"', (v: string, prev: string[] = []) => [...prev, v], [] as string[])
  .option("--no-key", "endpoint accounts: headers only, no API key")
  .option("--key-var <name>", "pi: a provider key variable to set (e.g. OPENROUTER_API_KEY), repeatable; its value is asked for", (v: string, prev: string[] = []) => [...prev, v], [] as string[])
  .option("--replace", "replace an existing account of that name")
  .action(
    async (
      name: string,
      o: { backend: string; baseUrl?: string; header: string[]; key: boolean; keyVar: string[]; replace?: boolean },
    ) => {
      try {
        const parsed = parseHeaderFlags(o.header ?? []);
        const secretsAsked = parsed.ask.length + (o.keyVar?.length ?? 0) + (o.key && !o.keyVar?.length ? 1 : 0);
        if (secretsAsked > 1 && !process.stdin.isTTY) {
          throw new Error('With piped input only one secret can be read; pass non-secret headers as "Name: value".');
        }
        const headers = parsed.headers;
        for (const h of parsed.ask) headers[h] = (await readSecret(`Value for header ${h}: `)).trim();
        const env: Record<string, string> = {};
        for (const v of o.keyVar ?? []) env[v] = (await readSecret(`${v}: `)).trim();
        const isPi = (o.keyVar?.length ?? 0) > 0;
        const token = !isPi && o.key ? (await readSecret("API key: ")).trim() : undefined;
        if (!isPi && o.key && !token) throw new Error("no API key entered");
        await accountRequest((id) => ({
          type: "accounts.set",
          id,
          backend: o.backend,
          name,
          kind: isPi ? "api-keys" : "api-key",
          ...(token ? { token } : {}),
          ...(o.baseUrl ? { baseUrl: o.baseUrl } : {}),
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
          ...(isPi ? { env } : {}),
          ...(o.replace ? { replace: true } : {}),
        }));
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    },
  );

account
  .command("add-gateway <name>")
  .description("Claude: add an Anthropic-compatible gateway account (its token is read from a prompt or stdin, never the command line)")
  .requiredOption("--base-url <url>", "the gateway's base URL (https)")
  .option("--header <header>", 'extra request header, repeatable: "Name" (value asked for without echo — keeps it out of shell history and ps) or "Name: value" for a non-secret one', (v: string, prev: string[] = []) => [...prev, v], [] as string[])
  .action(async (name: string, o: { baseUrl: string; header: string[] }) => {
    let parsed: ReturnType<typeof parseHeaderFlags>;
    try {
      parsed = parseHeaderFlags(o.header ?? []);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
    if (parsed.ask.length > 0 && !process.stdin.isTTY) {
      console.error('A header value can only be asked for on a terminal; with piped input, pipe the token and pass "Name: value".');
      process.exit(1);
    }
    const headers = parsed.headers;
    for (const h of parsed.ask) headers[h] = (await readSecret(`Value for header ${h}: `)).trim();
    const token = (await readSecret("Gateway token: ")).trim();
    await accountRequest((id) => ({
      type: "claude.accounts.set",
      id,
      name,
      kind: "gateway",
      token,
      baseUrl: o.baseUrl,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    }));
  });

account
  .command("add-token <name>")
  .description("Claude: add an account from a token you already have: a subscription token (sk-ant-oat01-…, from claude setup-token) or, with --api-key, an Anthropic API key. Read from a prompt or stdin.")
  .option("--api-key", "the token is an Anthropic API key, not a subscription token")
  .action(async (name: string, o: { apiKey?: boolean }) => {
    const token = (await readSecret(o.apiKey ? "Anthropic API key: " : "Subscription token (sk-ant-oat01-…): ")).trim();
    await accountRequest((id) => ({ type: "claude.accounts.set", id, name, kind: o.apiKey ? "api-key" : "subscription", token }));
  });

account
  .command("rm <name>")
  .description("Remove an account (sessions on it refuse to run until switched)")
  .option(backendOption, backendHelp)
  .action((name: string, o: { backend?: string }) => accountRequest((id) => ({ type: "accounts.remove", id, backend: o.backend ?? "claude", name })));

account
  .command("default <name>")
  .description('Set a backend\'s default account — every session on that backend that hasn\'t chosen its own switches on its next turn ("default" = the daemon\'s own environment)')
  .option(backendOption, backendHelp)
  .action((name: string, o: { backend?: string }) => accountRequest((id) => ({ type: "accounts.set_default", id, backend: o.backend ?? "claude", name })));

account
  .command("use <session> [name]")
  .description(
    'Switch a session to account <name> from its next turn, keeping the conversation — for the backend it is on now, or --backend ("default" = the daemon\'s own login; --follow-default = track the backend default)',
  )
  .option("--follow-default", "follow the backend default instead of pinning an account (omit <name>)")
  .option(backendOption, "the backend whose choice to set (default: the session's current backend)")
  .action(async (session: string, name: string | undefined, o: { followDefault?: boolean; backend?: string }) => {
    if ((name === undefined) === !o.followDefault) {
      console.error("Give an account name, or --follow-default — not both.");
      process.exit(1);
    }
    const config = loadConfig();
    const client = new TerminalClient(config);
    await client.connect();
    const sessionId = await client.resolveSessionId(session);
    if (!sessionId) {
      client.disconnect();
      process.exit(1);
    }
    const resp = await client.request({
      type: "session.set_account",
      id: randomUUID(),
      sessionId,
      account: o.followDefault ? null : (name as string),
      ...(o.backend ? { backend: o.backend } : {}),
    });
    client.disconnect();
    if (resp.type === "response.error") {
      console.error(`Error: ${resp.error}`);
      process.exit(1);
    }
    const info = (resp as { data?: SessionInfo }).data;
    const on = o.backend ?? info?.providerId ?? "its backend";
    const effective = o.backend && o.backend !== info?.providerId ? (name ?? "the default") : (info?.effectiveAccount ?? name);
    console.log(`Session "${session}" runs on the ${on} account "${effective}"${o.followDefault ? " (following the default)" : ""} from its next turn${o.backend && o.backend !== info?.providerId ? ` on ${o.backend}` : ""}.`);
  });

// ── OpenAI-compatible endpoints (local LLMs, gateways — openai-endpoints.ts) ──

const endpoint = program
  .command("endpoint")
  .description("OpenAI-compatible endpoints (llama.cpp, vLLM, Ollama, LM Studio, OpenRouter, gateways): each is a backend, oai:<name>");

/** Run one endpoint request against the daemon; print the list it answers with. */
async function endpointRequest(build: (id: string) => ClientMessage): Promise<DaemonMessage | undefined> {
  const config = loadConfig();
  const client = new TerminalClient(config);
  await client.connect();
  const resp = await client.request(build(randomUUID()));
  client.disconnect();
  if (resp.type === "response.error") {
    console.error(`Error: ${resp.error}`);
    process.exitCode = 1;
    return undefined;
  }
  if (resp.type === "endpoints.result") console.log(formatEndpoints(resp.endpoints));
  return resp;
}

function printTestResult(resp: DaemonMessage | undefined): void {
  if (!resp || resp.type !== "endpoints.test.result") return;
  if (!resp.ok) {
    console.error(`✗ ${resp.error ?? "the endpoint did not answer"}`);
    process.exitCode = 1;
    return;
  }
  const models = resp.models ?? [];
  console.log(`✓ answered in ${resp.latencyMs ?? "?"} ms — ${models.length} model${models.length === 1 ? "" : "s"}${resp.contextWindow ? `, context ${resp.contextWindow} tokens` : ""}`);
  for (const m of models.slice(0, 30)) console.log(`    ${m}`);
  if (models.length > 30) console.log(`    … and ${models.length - 30} more`);
}

const collect = (v: string, prev: string[] = []) => [...prev, v];

endpoint
  .command("ls")
  .description("List endpoints (never a key or header value)")
  .action(async () => {
    await endpointRequest((id) => ({ type: "endpoints.list", id }));
  });

endpoint
  .command("set <name>")
  .alias("add")
  .description(
    "Add an endpoint, or change one. Fields you leave out keep their stored values — the key and headers only while the base URL stays on the same server (scheme, host, port); moving it elsewhere needs --key/--clear-key and --header/--clear-headers. Key and header values are asked for without echo, never taken from the command line",
  )
  .requiredOption("--base-url <url>", "the OpenAI-compatible base URL, usually ending in /v1 (https, or http for localhost / a private network)")
  .option("--display-name <label>", "label in pickers")
  .option("--flavor <flavor>", "openai | llamacpp (llama-server: live context window from /props, strict tool schemas)")
  .option("--model <id[:context[:maxTokens]]>", "a model it serves, repeatable (e.g. qwen3-coder:128k); none = whatever the server lists", collect, [] as string[])
  .option("--default-model <id>", "the model new sessions use")
  .option("--context <tokens>", "context window for models without their own (e.g. 32k)")
  .option("--key", "set the API key (asked for without echo, or read from stdin)")
  .option("--clear-key", "remove the stored API key")
  .option("--header <header>", 'extra request header, repeatable: "Name" (value asked for without echo) or "Name: value" for a non-secret one; replaces all stored headers', collect, [] as string[])
  .option("--clear-headers", "remove all stored headers")
  .option("--mcp <servers>", "external MCP servers offered: all | none | name,name")
  .option("--no-stream-usage", "don't send stream_options.include_usage (for servers that reject it)")
  .option("--strict-tools", "make tool schemas strict (default for llamacpp)")
  .option("--no-strict-tools", "send tool schemas unchanged")
  .option("--max-tokens-field <field>", "max_tokens | max_completion_tokens")
  .action(
    async (
      name: string,
      o: {
        baseUrl: string;
        displayName?: string;
        flavor?: string;
        model: string[];
        defaultModel?: string;
        context?: string;
        key?: boolean;
        clearKey?: boolean;
        header: string[];
        clearHeaders?: boolean;
        mcp?: string;
        streamUsage?: boolean;
        strictTools?: boolean;
        maxTokensField?: string;
      },
    ) => {
      try {
        if (o.key && o.clearKey) throw new Error("--key and --clear-key don't go together");
        if (o.header?.length && o.clearHeaders) throw new Error("--header and --clear-headers don't go together");
        if (o.flavor !== undefined && o.flavor !== "openai" && o.flavor !== "llamacpp") throw new Error("--flavor is openai or llamacpp");
        if (o.maxTokensField !== undefined && o.maxTokensField !== "max_tokens" && o.maxTokensField !== "max_completion_tokens") {
          throw new Error("--max-tokens-field is max_tokens or max_completion_tokens");
        }
        const models = parseModelFlags(o.model ?? []);
        const parsedHeaders = parseHeaderFlags(o.header ?? []);
        if ((parsedHeaders.ask.length > 0 || o.key) && !process.stdin.isTTY && parsedHeaders.ask.length + (o.key ? 1 : 0) > 1) {
          throw new Error('With piped input only one secret can be read (the key); pass non-secret headers as "Name: value".');
        }
        const headers = parsedHeaders.headers;
        for (const h of parsedHeaders.ask) headers[h] = (await readSecret(`Value for header ${h}: `)).trim();
        const apiKey = o.key ? (await readSecret("API key: ")).trim() : o.clearKey ? null : undefined;
        if (o.key && !apiKey) throw new Error("no API key entered — use --clear-key to remove one");
        const mcpServers =
          o.mcp === undefined ? undefined : o.mcp === "all" ? ("all" as const) : o.mcp === "none" ? [] : o.mcp.split(",").map((x) => x.trim()).filter(Boolean);
        await endpointRequest((id) => ({
          type: "endpoints.set",
          id,
          name,
          baseUrl: o.baseUrl,
          ...(o.displayName !== undefined ? { displayName: o.displayName } : {}),
          ...(o.flavor ? { flavor: o.flavor as "openai" | "llamacpp" } : {}),
          ...(apiKey !== undefined ? { apiKey } : {}),
          ...(o.header?.length ? { headers } : o.clearHeaders ? { headers: {} } : {}),
          ...(models.length ? { models } : {}),
          ...(o.defaultModel ? { defaultModel: o.defaultModel } : {}),
          ...(o.context ? { contextWindow: parseTokens(o.context) } : {}),
          ...(mcpServers !== undefined ? { mcpServers } : {}),
          ...(o.streamUsage === false ? { streamUsage: false } : {}),
          ...(o.strictTools !== undefined ? { strictToolSchemas: o.strictTools } : {}),
          ...(o.maxTokensField ? { maxTokensField: o.maxTokensField as "max_tokens" | "max_completion_tokens" } : {}),
        }));
        if (!process.exitCode) console.log(`Use it with: codeoid new <session> <dir> --provider oai:${name}`);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    },
  );

endpoint
  .command("rm <name>")
  .description("Remove an endpoint (sessions on it refuse to run until switched to another backend)")
  .action(async (name: string) => {
    await endpointRequest((id) => ({ type: "endpoints.remove", id, name }));
  });

endpoint
  .command("test [name]")
  .description("Check an endpoint answers and list its models — a stored one, or a draft with --base-url")
  .option("--base-url <url>", "test this URL (with a stored endpoint's key and headers when <name> is given and the URL is on the same server)")
  .option("--key", "test with an API key (asked for without echo)")
  .option("--no-stored-key", "test without the stored API key")
  .option("--no-stored-headers", "test without the stored headers")
  .action(async (name: string | undefined, o: { baseUrl?: string; key?: boolean; storedKey?: boolean; storedHeaders?: boolean }) => {
    if (!name && !o.baseUrl) {
      console.error("Give an endpoint name, or --base-url.");
      process.exitCode = 1;
      return;
    }
    const apiKey = o.key ? (await readSecret("API key: ")).trim() : o.storedKey === false ? null : undefined;
    printTestResult(
      await endpointRequest((id) => ({
        type: "endpoints.test",
        id,
        ...(name ? { name } : {}),
        ...(o.baseUrl ? { baseUrl: o.baseUrl } : {}),
        ...(apiKey !== undefined && apiKey !== "" ? { apiKey } : {}),
        // Explicit, so a draft on another server can be tested (stored ones stay home).
        ...(o.storedHeaders === false ? { headers: {} } : {}),
      })),
    );
  });

endpoint
  .command("import-pi")
  .description("Add the OpenAI-compatible providers from pi's models.json as endpoints ($VAR keys are resolved from this shell; !command keys are not run)")
  .option("--file <path>", "models.json to read (default: $PI_CODING_AGENT_DIR/models.json, else ~/.pi/agent/models.json)")
  .option("--replace", "overwrite endpoints that already exist with the same name")
  .option("--dry-run", "show what would be imported, change nothing")
  .action(async (o: { file?: string; replace?: boolean; dryRun?: boolean }) => {
    const file = o.file ?? join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "models.json");
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      console.error(`Error: can't read ${file}: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
    const { entries, skipped } = importPiModels(json, process.env);
    for (const s of skipped) console.log(`  skip ${s.provider}: ${s.reason}`);
    if (entries.length === 0) {
      console.log(`No OpenAI-compatible providers in ${file}.`);
      return;
    }
    const config = loadConfig();
    const client = new TerminalClient(config);
    await client.connect();
    try {
      const listed = await client.request({ type: "endpoints.list", id: randomUUID() });
      const existing = new Set(listed.type === "endpoints.result" ? listed.endpoints.map((e) => e.name) : []);
      for (const { endpoint: e, warnings } of entries) {
        const label = `${e.name} → ${e.baseUrl} (${e.models?.length ?? 0} models)`;
        if (existing.has(e.name) && !o.replace) {
          console.log(`  keep ${label}: already exists (--replace to overwrite)`);
          continue;
        }
        for (const w of warnings) console.log(`  ! ${e.name}: ${w}`);
        if (o.dryRun) {
          console.log(`  would add ${label}`);
          continue;
        }
        const resp = await client.request({ type: "endpoints.set", id: randomUUID(), ...e });
        if (resp.type === "response.error") {
          console.error(`  ✗ ${e.name}: ${resp.error}`);
          process.exitCode = 1;
        } else {
          console.log(`  ✓ ${label}`);
        }
      }
    } finally {
      client.disconnect();
    }
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
    "--account <name>",
    "Account to run this session on, for its backend (see `codeoid account ls`). Default: that backend's default account.",
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
    'Role→backend binding, repeatable: "name:provider[:model][*count][+reads=a,b][+writes=c]" (e.g. orchestrator:claude, reasoning:openai:gpt-5-codex, review:gemini*3, search:claude+reads=spec+writes=research). reads/writes override the role\'s default blackboard scope; "+reads=" declares none. Requires --collaborate.',
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
        account?: string;
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
        account: opts.account,
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
    // Interactive: render provider dialogs (and get pending ones on attach).
    await client.connect({ capabilities: [CAPABILITIES.UI_DIALOGS] });
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
  .command("turns <session>")
  .description("List a session's turns, numbered — the N that `fork --at N` and /fork N take")
  .action(async (session: string) => {
    const config = loadConfig();
    const client = new TerminalClient(config);
    await client.connect();
    await client.listTurns(session);
    client.disconnect();
  });

program
  .command("fork <session>")
  .description("Fork a session into a new one — from its latest point, or after prompt N (with the files as they were then)")
  .option("--at <n>", "fork after prompt N (1 = the first)")
  .option("--backend <id>", "continue on another backend")
  .option("--shared", "share the parent's folder instead of a new git worktree")
  .option("--name <name>", "name for the fork")
  .action(async (session: string, o: { at?: string; backend?: string; shared?: boolean; name?: string }) => {
    const at = o.at !== undefined ? Number(o.at) : undefined;
    if (at !== undefined && (!Number.isInteger(at) || at < 1)) {
      console.error("--at takes a prompt number (1 = the first)");
      process.exit(1);
    }
    const config = loadConfig();
    const client = new TerminalClient(config);
    await client.connect();
    await client.forkSession(session, {
      ...(at !== undefined ? { at } : {}),
      ...(o.backend ? { backend: o.backend } : {}),
      ...(o.shared ? { shared: true } : {}),
      ...(o.name ? { name: o.name } : {}),
    });
    client.disconnect();
  });

const compare = program
  .command("compare")
  .description("Run one prompt on 2–4 backends side by side (each a fork in its own git worktree), then keep the best");

compare
  .command("run <session> <prompt...>")
  .description("Fork one branch per backend from this session (or after prompt N), send each the prompt, show the results")
  .requiredOption("--with <backends>", "2–4 backends, comma-separated; backend:model picks a model (e.g. claude,codex:gpt-5.5)")
  .option("--at <n>", "compare from after prompt N (with the files as they were then)")
  .option("--no-wait", "start the branches and return; see them later with `compare show`")
  .action(async (session: string, words: string[], o: { with: string; at?: string; wait: boolean }) => {
    const targets = parseTargets(o.with);
    if ("error" in targets) {
      console.error(targets.error);
      process.exit(1);
    }
    const at = o.at !== undefined ? Number(o.at) : undefined;
    if (at !== undefined && (!Number.isInteger(at) || at < 1)) {
      console.error("--at takes a prompt number (1 = the first)");
      process.exit(1);
    }
    const config = loadConfig();
    const client = new TerminalClient(config);
    await client.connect();
    await client.compareRun(session, targets, words.join(" "), {
      ...(at !== undefined ? { at } : {}),
      wait: o.wait,
    });
    client.disconnect();
  });

compare
  .command("show <id>")
  .description("A comparison's branches side by side (id or its first characters)")
  .option("--wait", "wait for every branch to finish first")
  .action(async (id: string, o: { wait?: boolean }) => {
    const config = loadConfig();
    const client = new TerminalClient(config);
    await client.connect();
    await client.compareShow(id, { wait: o.wait === true });
    client.disconnect();
  });

compare
  .command("ls <session>")
  .description("A session's comparisons, newest first")
  .action(async (session: string) => {
    const config = loadConfig();
    const client = new TerminalClient(config);
    await client.connect();
    await client.compareList(session);
    client.disconnect();
  });

compare
  .command("keep <id> <branch>")
  .description("Keep branch N as the continuation; --discard-others destroys the rest")
  .option("--discard-others", "destroy the other branches")
  .action(async (id: string, branch: string, o: { discardOthers?: boolean }) => {
    const n = Number(branch);
    if (!Number.isInteger(n) || n < 1) {
      console.error("<branch> is the number shown next to it (1 = the first)");
      process.exit(1);
    }
    const config = loadConfig();
    const client = new TerminalClient(config);
    await client.connect();
    await client.compareKeep(id, n, o.discardOthers === true);
    client.disconnect();
  });

program
  .command("undo <session> [args...]")
  .description("Take back the last message (the agent forgets it); 'files' previews restoring the files, 'files yes' does it")
  .action(async (session: string, args: string[]) => {
    const config = loadConfig();
    const client = new TerminalClient(config);
    await client.connect();
    await client.undoSession(session, args ?? []);
    client.disconnect();
  });

const skill = program
  .command("skill")
  .description("Pre-approve commands that installed skills declare (for unattended runs like `pipeline run`)");

for (const [verb, allowed] of [["allow", true], ["deny", false]] as const) {
  skill
    .command(`${verb} <command>`)
    .description(
      allowed
        ? "Allow a skill-declared command (exactly as in the skill's !`…`) to run in this workdir without asking"
        : "Remember a refusal for a skill-declared command in this workdir",
    )
    .option("--workdir <dir>", "Workspace the grant applies to (default: current directory)")
    .action(async (command: string, opts: { workdir?: string }) => {
      const config = loadConfig();
      const client = new TerminalClient(config);
      await client.connect();
      await client.skillGrant(command, opts.workdir ?? process.cwd(), allowed);
      client.disconnect();
    });
}

program
  .command("approve <session>")
  .description("Approve a pending permission request or yes/no question")
  .option("--deny", "Deny instead of approve")
  .option("--pick <n>", "which waiting tool call, when several are (1 = the oldest)")
  .option("--id <approvalId>", "which waiting tool call, by the id shown — stable, unlike --pick, for scripts")
  .option("--yes", "approve without asking to confirm (needed without a terminal)")
  .action(async (session: string, opts: { deny?: boolean; pick?: string; id?: string; yes?: boolean }) => {
    const pick = opts.pick !== undefined ? Number(opts.pick) : undefined;
    if (pick !== undefined && (!Number.isInteger(pick) || pick < 1)) {
      console.error("--pick takes a number (1 = the oldest waiting)");
      process.exit(1);
    }
    if (opts.id !== undefined && opts.id.trim() === "") {
      // An unset $ID in a script must not fall back to "the oldest waiting".
      console.error("--id needs an approval id");
      process.exit(1);
    }
    if (pick !== undefined && opts.id !== undefined) {
      console.error("--pick and --id both choose the call — give one");
      process.exit(1);
    }
    const config = loadConfig();
    const client = new TerminalClient(config);
    await client.connect();
    await client.approveSession(session, !opts.deny, {
      ...(pick !== undefined ? { pick } : {}),
      ...(opts.id !== undefined ? { approvalId: opts.id } : {}),
      ...(opts.yes ? { yes: true } : {}),
    });
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

// ── Outward control plane (/mcp/control — docs/mcp-control.md) ─────────────

const mcp = program
  .command("mcp")
  .description("Let external agents drive codeoid over MCP (docs/mcp-control.md), and manage a session's MCP servers");

mcp
  .command("headers")
  .description("Print a fresh Authorization header as JSON — an MCP client's headersHelper")
  .option("--scopes <spec>", `scope preset (${Object.keys(MCP_SCOPE_PRESETS).join(" | ")}) or a comma-separated list`, "observe")
  .action(async (opts: { scopes: string }) => {
    try {
      const config = loadConfig();
      const out = await mcpHeaders(config, opts.scopes);
      for (const w of out.warnings) console.error(w);
      if (cleartextOffHost(controlUrl(config.daemonUrl))) {
        console.error("codeoid: warning — the daemon URL is plain http to another host; this token would cross the network unencrypted.");
      }
      process.stdout.write(`${out.stdout}\n`);
    } catch (err) {
      if (!(err instanceof TokenError)) throw err;
      for (const line of err.lines) console.error(line);
      process.exit(1);
    }
  });

mcp
  .command("config")
  .description("Print an MCP client config entry (Claude Code .mcp.json shape) for this daemon")
  .option("--scopes <spec>", `scope preset (${Object.keys(MCP_SCOPE_PRESETS).join(" | ")}) or a comma-separated list`, "observe")
  .option("--name <name>", "server name in the client", "codeoid")
  .action((opts: { scopes: string; name: string }) => {
    try {
      const config = loadConfig();
      console.log(JSON.stringify(mcpConfig(config, opts), null, 2));
      if (cleartextOffHost(controlUrl(config.daemonUrl))) {
        console.error(
          "\nWarning: this URL is plain http to another host — the bearer token would cross the network unencrypted. Put the daemon behind TLS (wss://) first.",
        );
      }
    } catch (err) {
      if (err instanceof TokenError) {
        for (const line of err.lines) console.error(line);
      } else {
        console.error(err instanceof Error ? err.message : String(err));
      }
      process.exit(1);
    }
    console.error(
      "\nThe daemon must have the endpoint on: set mcpControl.enabled (and mcpControl.allowActions to let the client create/send) in ~/.codeoid/config.json, then restart.",
    );
  });

mcp
  .command("adopt <server>")
  .description("Have codeoid sign in to a remote MCP server from Claude's own config, instead of an interactive Claude Code session (#390)")
  .option("--session <session>", "also look in this session's workdir (a .mcp.json, project servers)")
  .option("--url <url>", "the server's URL: required for a project's own server (its address was chosen by the project — naming it is your consent), and when two servers share the name")
  .action((server: string, opts: { session?: string; url?: string }) => withClient((c) => c.mcpAdopt(server, opts.session, opts.url)));

mcp
  .command("signin <server>")
  .description("Sign in to an OAuth MCP server in codeoid's registry (one you adopted, or configured with oauth)")
  .option("--callback-url <url>", "finish a sign-in from the address the browser landed on")
  .action((server: string, opts: { callbackUrl?: string }) => withClient((c) => c.mcpSignin(server, opts.callbackUrl)));

mcp
  .command("reconnect <session> <server>")
  .description("Redial one of a session's MCP servers that's down — e.g. one that failed when the session started and has since been fixed")
  .action((session: string, server: string) => withClient((c) => c.mcpReconnect(session, server)));

mcp
  .command("refresh <session>")
  .description("Use MCP servers added or changed in Claude's config in a session (its backend restarts and resumes the conversation)")
  .action((session: string) => withClient((c) => c.mcpRefresh(session)));

mcp
  .command("approve <session> <server>")
  .description("Approve a project's MCP server (from its .mcp.json or project settings) for every backend in the session's workdir")
  .option("--path <file>", "the file it's declared in, when more than one declares it")
  .option("--yes <fingerprint>", "approve the entry you reviewed (its fingerprint, as the review printed it); without it, the entry is only shown")
  .action((session: string, server: string, opts: { path?: string; yes?: string }) => withClient((c) => c.mcpApprove(session, server, opts)));

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

// ── Routines (docs/routines.md) ─────────────────────────────────────────────

/** Options shared by `routine add` and `routine edit`. */
function routineSpecOptions(cmd: Command, mode: "add" | "edit"): Command {
  cmd
    .option("-w, --workdir <dir>", mode === "add" ? "directory the agent works in (default: here)" : "directory the agent works in")
    .option("-p, --prompt <text>", "what the agent should do — may use {{check}}, {{payload}}, {{last_summary}}, {{trigger}}, {{now}}, {{routine}}")
    .option("--prompt-file <path>", "read the prompt from a file")
    .option("--cron <expr>", 'run on a cron schedule, e.g. "0 9 * * 1-5"')
    .option("--tz <zone>", "IANA timezone for --cron (default: this machine's)")
    .option("--every <interval>", "run every interval, e.g. 15m, 2h, 1d")
    .option("--at <time>", "run once, at ISO 8601 with a zone (Z or +08:00)")
    .option("--check <command>", "pre-run gate: no output = nothing to do (no agent, no cost)")
    .option("--check-timeout <s>", "check timeout in seconds (default 60)")
    .option("--provider <id>", "backend: claude, codex, gemini, qwen, …")
    .option("--model <name>", "model for the backend")
    .option("--guarded", "every non-read tool waits for your approval")
    .option("--autonomous", "tools auto-approve within --tool-budget (default)")
    .option("--tool-budget <n>", "autonomous tool calls per run (default 50)")
    .option("--max-minutes <n>", "wall-clock limit per run (default 15)")
    .option("--max-cost <usd>", "spend ceiling per run")
    .option("--daily-cost <usd>", "spend ceiling per day (UTC)")
    .option("--persistent", "reuse one session across runs (keeps the conversation)")
    .option("--fresh", "a new session per run (default)")
    .option("--worktree", "run in a fresh git worktree each time")
    .option("--overlap <policy>", "if a run is still going: skip (default) or queue")
    .option("--catch-up", "after downtime, run once for a missed fire")
    .option("--jitter <s>", "spread the start by up to this many seconds")
    .option("--notify <policy>", "on_change (default), always, or never")
    .option("--keep <n>", "run sessions to keep (default 5)")
    .option("--api", "enable the routine's API trigger (prints its token once)")
    .option("--failure-pause <n>", "pause after N consecutive failures (default 3, 0 = never)");
  if (mode === "edit") {
    cmd
      .option("--no-schedule", "remove the schedule (run on demand only)")
      .option("--no-check", "remove the check")
      .option("--no-worktree", "stop using a worktree")
      .option("--no-catch-up", "don't catch up missed fires")
      .option("--no-api", "turn the API trigger off (revokes its token)");
  }
  return cmd;
}

/** Print an API token once, with how to call it. */
function printRoutineToken(token: string, routineId: string): void {
  const base = loadConfig().daemonUrl.replace(/^ws/, "http").replace(/\/+$/, "");
  console.log(`\n  API token (shown once — store it now):\n    ${token}`);
  console.log(`\n  Fire it:\n    curl -X POST ${base}${routineFirePath(routineId)} \\\n      -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" \\\n      -d '{"text": "optional payload for {{payload}}"}'\n`);
}

const routine = program
  .command("routine")
  .description("Scheduled and triggered agent runs, with budgets and a check-first gate (docs/routines.md)");

routineSpecOptions(routine.command("add <name>").description("Create a routine"), "add").action((name: string, f: RoutineFlags) =>
  withClient(async (c) => {
    let spec: ReturnType<typeof specFromFlags>;
    try {
      spec = specFromFlags(name, f, "add");
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
    const res = await c.request({ type: "routine.create", id: randomUUID(), spec: spec as RoutineSpecWire });
    if (res.type !== "routine.snapshot") return c.printError(res);
    console.log(formatRoutine(res.routine).join("\n"));
    if (res.apiToken) printRoutineToken(res.apiToken, res.routine.id);
  }),
);

routineSpecOptions(routine.command("edit <name>").description("Change a routine (only the flags you pass)"), "edit").action(
  (name: string, f: RoutineFlags) =>
    withClient(async (c) => {
      let spec: ReturnType<typeof specFromFlags>;
      try {
        spec = specFromFlags(name, f, "edit");
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }
      const res = await c.request({ type: "routine.update", id: randomUUID(), routine: name, spec: spec as never });
      if (res.type !== "routine.snapshot") return c.printError(res);
      console.log(formatRoutine(res.routine).join("\n"));
      if (res.apiToken) printRoutineToken(res.apiToken, res.routine.id);
    }),
);

routine
  .command("ls")
  .description("List routines")
  .action(() =>
    withClient(async (c) => {
      const res = await c.request({ type: "routine.list", id: randomUUID() });
      if (res.type !== "routine.list.result") return c.printError(res);
      console.log(formatRoutineList(res.routines).join("\n"));
    }),
  );

routine
  .command("show <name>")
  .description("A routine's configuration and recent runs")
  .option("--runs <n>", "recent runs to show", "5")
  .action((name: string, o: { runs: string }) =>
    withClient(async (c) => {
      const res = await c.request({ type: "routine.get", id: randomUUID(), routine: name, runs: Number(o.runs) });
      if (res.type !== "routine.snapshot") return c.printError(res);
      console.log(formatRoutine(res.routine, res.runs).join("\n"));
    }),
  );

routine
  .command("runs <name>")
  .description("Run history, newest first")
  .option("--limit <n>", "how many", "20")
  .action((name: string, o: { limit: string }) =>
    withClient(async (c) => {
      const res = await c.request({ type: "routine.runs", id: randomUUID(), routine: name, limit: Number(o.limit) });
      if (res.type !== "routine.runs.result") return c.printError(res);
      if (res.runs.length === 0) console.log("No runs yet.");
      for (const run of res.runs) console.log(formatRun(run).join("\n"));
    }),
  );

routine
  .command("run <name>")
  .description("Run a routine now")
  .option("--payload <text>", "text for the prompt's {{payload}}")
  .option("--wait", "wait for the run to finish and print its outcome")
  .action((name: string, o: { payload?: string; wait?: boolean }) =>
    withClient(async (c) => {
      const res = await c.request({ type: "routine.run", id: randomUUID(), routine: name, ...(o.payload ? { payload: o.payload } : {}) });
      if (res.type !== "routine.run.result") return c.printError(res);
      const runId = res.run.id;
      if (!o.wait || ["skipped", "cancelled"].includes(res.run.status)) {
        console.log(formatRun(res.run).join("\n"));
        return;
      }
      process.stderr.write(`run ${runId.slice(0, 8)} started — waiting`);
      for (;;) {
        await new Promise((r) => setTimeout(r, 2_000));
        // By id, so a busy routine's newer runs can't push this one out of view.
        const got = await c.request({ type: "routine.runs", id: randomUUID(), routine: res.run.routineId, runId });
        if (got.type !== "routine.runs.result") return c.printError(got);
        const run = got.runs[0];
        if (!run) {
          process.stderr.write("\n");
          console.error(`run ${runId.slice(0, 8)} is gone (the routine was deleted, or its history trimmed)`);
          process.exitCode = 1;
          return;
        }
        if (!["queued", "checking", "running"].includes(run.status)) {
          process.stderr.write("\n");
          console.log(formatRun(run).join("\n"));
          if (["failed", "timed_out", "over_budget"].includes(run.status)) process.exitCode = 1;
          return;
        }
        process.stderr.write(".");
      }
    }),
  );

for (const [verb, enabled] of [["pause", false], ["resume", true]] as const) {
  routine
    .command(`${verb} <name>`)
    .description(enabled ? "Resume a paused routine" : "Pause a routine (nothing is deleted)")
    .action((name: string) =>
      withClient(async (c) => {
        const res = await c.request({ type: "routine.update", id: randomUUID(), routine: name, enabled });
        if (res.type !== "routine.snapshot") return c.printError(res);
        console.log(formatRoutineList([res.routine]).slice(1).join("\n"));
      }),
    );
}

routine
  .command("rm <name>")
  .description("Delete a routine and its run history")
  .action((name: string) =>
    withClient(async (c) => {
      const res = await c.request({ type: "routine.delete", id: randomUUID(), routine: name });
      if (res.type !== "response.ok") return c.printError(res);
      console.log(`Deleted routine ${name}.`);
    }),
  );

routine
  .command("cancel <runId>")
  .description("Cancel a queued or running run")
  .action((runId: string) =>
    withClient(async (c) => {
      const res = await c.request({ type: "routine.cancel_run", id: randomUUID(), runId });
      if (res.type !== "response.ok") return c.printError(res);
      console.log(`Cancelled run ${runId}.`);
    }),
  );

routine
  .command("token <name>")
  .description("Mint a new API token (the old one stops working)")
  .action((name: string) =>
    withClient(async (c) => {
      const res = await c.request({ type: "routine.token", id: randomUUID(), routine: name });
      if (res.type !== "routine.token.result") return c.printError(res);
      printRoutineToken(res.apiToken, res.routineId);
    }),
  );

routine
  .command("preview")
  .description("Check a schedule and show its next fire times")
  .option("--cron <expr>", "cron expression")
  .option("--tz <zone>", "IANA timezone for --cron")
  .option("--every <interval>", "interval, e.g. 15m")
  .option("--at <time>", "ISO 8601 with a zone (Z or +08:00)")
  .option("--count <n>", "how many fires", "5")
  .action((o: RoutineFlags & { count: string }) =>
    withClient(async (c) => {
      let schedule: RoutineScheduleWire | null | undefined;
      try {
        schedule = scheduleFromFlags(o);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }
      if (!schedule) {
        console.error("give a schedule: --cron, --every, or --at");
        process.exitCode = 1;
        return;
      }
      const res = await c.request({ type: "routine.preview", id: randomUUID(), schedule, count: Number(o.count) });
      if (res.type !== "routine.preview.result") return c.printError(res);
      for (const f of res.fires) console.log(`  ${f}  (${relativeTime(f)})`);
    }),
  );

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
    'Bind a role to a backend for this run, repeatable: "name:provider[:model]" (e.g. adversary:claude:claude-fable-5). Outranks config maps and pack pins. No *count — pipelines run one session per phase — and no +reads=/+writes=, which a phase does not enforce yet.',
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
