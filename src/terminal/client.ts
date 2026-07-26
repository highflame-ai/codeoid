/**
 * Terminal client — connects to the daemon over WebSocket.
 *
 * Uses Bun's native WebSocket (no ws dependency).
 */

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { CodeoidConfig } from "../config.js";
import { PROTOCOL_VERSION } from "../protocol/types.js";
import type {
  ClientMessage,
  CollaborationConfig,
  DaemonMessage,
  PipelineWire,
  SessionInfo,
} from "../protocol/types.js";
import { ALL_SCOPES_STRING } from "../protocol/scopes.js";
import { sanitizeTerminalOutput } from "../tui/ansi/codes.js";
import { formatPackList, formatPackShow } from "./pack-format.js";
import { formatPipeline, haltedRequestId } from "./pipeline-format.js";

// ── Stream rendering (pure, exported for tests) ───────────────────────────────

/** SGR framing codes the client emits around content. These are trusted
 *  constants; only the interpolated (untrusted) values are sanitized. */
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/** Strip terminal-control escapes from an untrusted field before it reaches
 *  the TTY (OSC 52 clipboard, cursor moves, DCS, etc. — see #91/#92). */
const S = (s: string | undefined): string => sanitizeTerminalOutput(s ?? "");

/** Streaming/approval bookkeeping carried across messages by the attach loop. */
export interface StreamRenderState {
  /** messageId last seen via a delta, so the committed assistant message that
   *  follows doesn't double-print content already streamed chunk-by-chunk. */
  streamingAssistantMsgId: string | null;
  /** approvalId of the most recent waiting_confirmation tool call, so a typed
   *  yes/no can be routed to it. */
  latestApprovalId: string | null;
}

export function newStreamRenderState(): StreamRenderState {
  return { streamingAssistantMsgId: null, latestApprovalId: null };
}

/**
 * Render one daemon stream message to the exact bytes the legacy readline
 * client writes to stdout, with every untrusted field (`content`,
 * `identity.name`, `tool.name`, `tool.state.description`, `contentAppend`)
 * run through `sanitizeTerminalOutput`. Mutates `state` for the streaming /
 * approval bookkeeping the caller carries between messages. Pure otherwise —
 * no I/O — so a test can drive it and assert escapes are stripped.
 *
 * A prior `console.log(x)` becomes `x + "\n"`; a prior `process.stdout.write(x)`
 * becomes `x` — byte-for-byte identical to the previous inline rendering.
 */
export function renderStreamMessage(msg: DaemonMessage, state: StreamRenderState): string {
  switch (msg.type) {
    case "scrollback.replay": {
      const m = msg as { messages?: Array<{ type: string; role?: string; content?: string; tool?: { name?: string }; identity?: { name?: string } }> };
      const list = m.messages ?? [];
      let out = `\n--- scrollback (${list.length} messages) ---\n`;
      for (const e of list) {
        if (e.type !== "session.message") continue;
        const id = e.identity?.name ? `${DIM}${S(e.identity.name)}${RESET} ` : "";
        switch (e.role) {
          case "user": out += `\n${id}${CYAN}> ${S(e.content)}${RESET}\n`; break;
          case "assistant": if (e.content) out += `${S(e.content)}\n`; break;
          case "tool_call": out += `\n${id}${YELLOW}⚡ ${S(e.tool?.name ?? e.content)}${RESET}\n`; break;
          case "system": out += `${RED}${S(e.content)}${RESET}\n`; break;
          case "info": out += `${DIM}${S(e.content)}${RESET}\n`; break;
        }
      }
      out += "\n--- end scrollback ---\n\n";
      return out;
    }

    case "session.message": {
      const sm = msg as { role?: string; content?: string; messageId?: string; tool?: { name?: string; state?: { phase?: string; approvalId?: string; description?: string } }; identity?: { name?: string; type?: string } };
      const id = sm.identity?.name ? `${DIM}${S(sm.identity.name)}${RESET} ` : "";
      switch (sm.role) {
        case "user":
          return `\n${id}${CYAN}> ${S(sm.content)}${RESET}\n`;
        case "assistant": {
          const msgId = sm.messageId;
          if (msgId && msgId === state.streamingAssistantMsgId) {
            state.streamingAssistantMsgId = null;
            return "\n";
          }
          if (sm.content) return `${S(sm.content)}\n`;
          return "";
        }
        case "thinking":
          return `${DIM}${S(sm.content)}${RESET}`;
        case "tool_call": {
          const phase = sm.tool?.state?.phase ?? "executing";
          const name = S(sm.tool?.name ?? sm.content);
          if (phase === "waiting_confirmation") {
            state.latestApprovalId = sm.tool?.state?.approvalId ?? null;
            return `\n${id}${RED}⚡ ${name}: ${S(sm.tool?.state?.description)}${RESET}\n  Type 'yes' to approve, 'no' to deny\n`;
          }
          return `\n${id}${YELLOW}⚡ ${name} [${phase}]${RESET}\n`;
        }
        case "system":
          return `\n${RED}${S(sm.content)}${RESET}\n`;
        case "info":
          return `${DIM}${S(sm.content)}${RESET}\n`;
      }
      return "";
    }

    case "session.message.delta": {
      const delta = msg as { contentAppend?: string; messageId?: string; toolStateUpdate?: { phase?: string } };
      if (delta.messageId) state.streamingAssistantMsgId = delta.messageId;
      let out = "";
      if (delta.contentAppend) out += S(delta.contentAppend);
      if (delta.toolStateUpdate) out += `${YELLOW}  → ${delta.toolStateUpdate.phase}${RESET}\n`;
      return out;
    }

    case "session.status_change": {
      const sc = msg as { status?: string };
      return `\n[status] ${sc.status}\n`;
    }
  }
  return "";
}

export class TerminalClient {
  #config: CodeoidConfig;
  #ws: WebSocket | null = null;
  #pending = new Map<string, (msg: DaemonMessage) => void>();
  #streamHandler: ((msg: DaemonMessage) => void) | null = null;

  constructor(config: CodeoidConfig) {
    this.#config = config;
  }

  async connect(): Promise<void> {
    const token = await this.#getToken();

    return new Promise((resolve, _reject) => {
      this.#ws = new WebSocket(this.#config.daemonUrl);

      this.#ws.onopen = () => {
        // `type: "auth"` is REQUIRED — the daemon validates the pre-auth frame
        // against `authMsgSchema` and closes 4001 on anything else. A bare
        // `{ token }` frame (what this sent before) is rejected outright, which
        // made every one-shot CLI command fail with "Authentication timeout".
        this.#ws!.send(
          JSON.stringify({
            type: "auth",
            token,
            protocolVersion: PROTOCOL_VERSION,
            client: "codeoid-cli",
          }),
        );
      };

      this.#ws.onmessage = (event) => {
        const msg = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data)) as DaemonMessage & { type: string; requestId?: string };

        if (msg.type === "auth.ok") {
          resolve();
          return;
        }

        if (msg.requestId && this.#pending.has(msg.requestId)) {
          const handler = this.#pending.get(msg.requestId)!;
          this.#pending.delete(msg.requestId);
          handler(msg as DaemonMessage);
          return;
        }

        if (this.#streamHandler) {
          this.#streamHandler(msg as DaemonMessage);
        }
      };

      this.#ws.onerror = () => {
        console.error(`Cannot connect to Codeoid daemon at ${this.#config.daemonUrl}`);
        console.error("  Is the daemon running? Try: codeoid start (or `bun src/cli.ts start` from source)\n");
        process.exit(1);
      };
      this.#ws.onclose = (event) => {
        if (event.code === 4001) {
          console.error("Authentication timeout — daemon did not accept credentials.\n");
          process.exit(1);
        }
        if (event.code === 4003) {
          console.error("Authentication failed — token is invalid or expired.");
          console.error(`  ${event.reason}`);
          console.error("  Try logging in again or check your API key.\n");
          process.exit(1);
        }
      };
    });
  }

  disconnect(): void {
    this.#ws?.close();
    this.#ws = null;
  }

  // ── Commands ──────────────────────────────────────────────────────────

  async listSessions(): Promise<void> {
    const resp = await this.#request({ type: "session.list", id: randomUUID() });

    if (resp.type === "session.list.result") {
      if (resp.sessions.length === 0) {
        console.log("No active sessions.");
        return;
      }
      console.log("\n  Sessions:\n");
      for (const s of resp.sessions) {
        const status = this.#formatStatus(s.status);
        console.log(`  ${s.name.padEnd(20)} ${status.padEnd(20)} ${s.workdir}`);
        console.log(`  ${"".padEnd(20)} id: ${s.id}  clients: ${s.attachedClients}`);
        console.log();
      }
    } else {
      this.#printError(resp);
    }
  }

  // ── Packs (dynamic pack loading — docs/pack-loading.md) ──────────────────

  async packList(): Promise<void> {
    this.#renderPacks(await this.#request({ type: "pipeline.pack.list", id: randomUUID() }));
  }

  async packRegistryAdd(url: string, opts: { name?: string; ref?: string }): Promise<void> {
    this.#renderPacks(
      await this.#request({ type: "pipeline.registry.add", id: randomUUID(), url, name: opts.name, ref: opts.ref }),
    );
  }

  async packInstall(ref: string, opts: { trusted?: boolean; dir?: boolean }): Promise<void> {
    const msg = opts.dir
      ? ({ type: "pipeline.pack.install", id: randomUUID(), dir: ref, trusted: opts.trusted } as const)
      : ({ type: "pipeline.pack.install", id: randomUUID(), packId: ref, trusted: opts.trusted } as const);
    this.#renderPacks(await this.#request(msg));
  }

  async packRemove(id: string): Promise<void> {
    this.#renderPacks(await this.#request({ type: "pipeline.pack.remove", id: randomUUID(), packId: id }));
  }

  async packTrust(id: string, trusted: boolean): Promise<void> {
    this.#renderPacks(await this.#request({ type: "pipeline.pack.trust", id: randomUUID(), packId: id, trusted }));
  }

  async packSelect(id: string | null): Promise<void> {
    this.#renderPacks(await this.#request({ type: "pipeline.pack.select", id: randomUUID(), packId: id }));
  }

  async packShow(id: string): Promise<void> {
    const resp = await this.#request({ type: "pipeline.pack.list", id: randomUUID() });
    if (resp.type !== "pipeline.pack.list.result") {
      this.#printError(resp);
      return;
    }
    const lines = formatPackShow(resp, id);
    if (lines === null) {
      console.error(`Pack "${id}" not found (installed or available).`);
      return;
    }
    for (const line of lines) console.log(line);
  }

  #renderPacks(resp: DaemonMessage): void {
    if (resp.type !== "pipeline.pack.list.result") {
      this.#printError(resp);
      return;
    }
    for (const line of formatPackList(resp)) console.log(line);
  }

  async createSession(
    name: string,
    workdir: string,
    opts: { pack?: string; packRole?: string; collaboration?: CollaborationConfig } = {},
  ): Promise<void> {
    const resp = await this.#request({
      type: "session.create",
      id: randomUUID(),
      name,
      workdir,
      ...(opts.pack ? { pack: opts.pack } : {}),
      ...(opts.packRole ? { packRole: opts.packRole } : {}),
      ...(opts.collaboration ? { collaboration: opts.collaboration } : {}),
    });

    if (resp.type === "response.ok") {
      const data = resp.data as SessionInfo;
      const profile = data.profile ? ` [pack: ${data.profile}]` : "";
      console.log(`Session created: ${data.name} (${data.id})${profile}`);
      if (data.collaboration) {
        // Echo the RESOLVED bindings, not the requested ones: the daemon
        // normalizes (count defaults, model resolved against its own
        // backend), so this is the user's confirmation of what they got.
        console.log(`  goal: ${data.collaboration.goal}`);
        for (const r of data.collaboration.roles) {
          const model = r.model ? `:${r.model}` : "";
          const fanout = (r.count ?? 1) > 1 ? ` ×${r.count}` : "";
          console.log(`  role: ${r.name} → ${r.providerId}${model}${fanout}`);
        }
      }
    } else {
      this.#printError(resp);
    }
  }

  async attachSession(sessionIdOrName: string): Promise<void> {
    const sessionId = await this.#resolveSession(sessionIdOrName);
    if (!sessionId) return;

    const resp = await this.#request({
      type: "session.attach",
      id: randomUUID(),
      sessionId,
    });

    if (resp.type !== "response.ok") {
      this.#printError(resp);
      return;
    }

    console.log("\nAttached to session. Type messages below. Ctrl+C to detach.\n");

    // Streaming/approval bookkeeping, carried across messages. `latestApprovalId`
    // is read below to route a typed yes/no; both fields are mutated by
    // renderStreamMessage, which also sanitizes every untrusted field before it
    // reaches the TTY (OSC/CSI/DCS escapes — see #91/#92).
    const renderState = newStreamRenderState();

    this.#streamHandler = (msg) => {
      const out = renderStreamMessage(msg, renderState);
      if (out) process.stdout.write(out);
    };

    const rl = createInterface({ input: process.stdin, output: process.stdout });

    const cleanup = () => {
      this.#streamHandler = null;
      rl.close();
      this.#request({ type: "session.detach", id: randomUUID(), sessionId }).catch(() => {});
      console.log("\nDetached.");
      this.disconnect();
      process.exit(0);
    };

    process.on("SIGINT", cleanup);

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed === "/detach" || trimmed === "/quit") {
        cleanup();
        break;
      }

      if (trimmed === "/interrupt") {
        await this.#request({ type: "session.interrupt", id: randomUUID(), sessionId });
        continue;
      }

      if ((trimmed === "yes" || trimmed === "no") && renderState.latestApprovalId) {
        await this.#request({
          type: "session.approve",
          id: randomUUID(),
          sessionId,
          approvalId: renderState.latestApprovalId,
          approved: trimmed === "yes",
        });
        renderState.latestApprovalId = null;
        continue;
      }

      await this.#request({
        type: "session.send",
        id: randomUUID(),
        sessionId,
        text: trimmed,
      });
    }
  }

  async sendMessage(sessionIdOrName: string, message: string): Promise<void> {
    const sessionId = await this.#resolveSession(sessionIdOrName);
    if (!sessionId) return;

    const resp = await this.#request({
      type: "session.send",
      id: randomUUID(),
      sessionId,
      text: message,
    });

    if (resp.type === "response.ok") {
      console.log("Message sent.");
    } else {
      this.#printError(resp);
    }
  }

  async interruptSession(sessionIdOrName: string): Promise<void> {
    const sessionId = await this.#resolveSession(sessionIdOrName);
    if (!sessionId) return;

    const resp = await this.#request({
      type: "session.interrupt",
      id: randomUUID(),
      sessionId,
    });

    if (resp.type === "response.ok") {
      console.log("Session interrupted.");
    } else {
      this.#printError(resp);
    }
  }

  async approveSession(sessionIdOrName: string, approved: boolean): Promise<void> {
    const sessionId = await this.#resolveSession(sessionIdOrName);
    if (!sessionId) return;

    const resp = await this.#request({
      type: "session.approve",
      id: randomUUID(),
      sessionId,
      approvalId: "", // Will fall back to first pending
      approved,
    });

    if (resp.type === "response.ok") {
      console.log(approved ? "Approved." : "Denied.");
    } else {
      this.#printError(resp);
    }
  }

  async destroySession(sessionIdOrName: string): Promise<void> {
    const sessionId = await this.#resolveSession(sessionIdOrName);
    if (!sessionId) return;

    const resp = await this.#request({
      type: "session.destroy",
      id: randomUUID(),
      sessionId,
    });

    if (resp.type === "response.ok") {
      console.log("Session destroyed.");
    } else {
      this.#printError(resp);
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────

  async #resolveSession(nameOrId: string): Promise<string | null> {
    // `attach conductor` create-or-gets THE conductor session (idempotent on
    // the daemon), so you can reach it from any client without knowing its id
    // or creating it first. Match by role too — the conductor's display name
    // is configurable.
    if (nameOrId === "conductor") {
      const created = await this.#request({
        type: "session.create",
        id: randomUUID(),
        name: "conductor",
        workdir: ".",
        role: "conductor",
      });
      if (created.type === "response.ok") {
        return (created.data as SessionInfo).id;
      }
      this.#printError(created);
      return null;
    }

    if (nameOrId.includes("-") && nameOrId.length > 30) {
      return nameOrId;
    }

    const resp = await this.#request({ type: "session.list", id: randomUUID() });
    if (resp.type === "session.list.result") {
      const match =
        resp.sessions.find((s) => s.name === nameOrId) ??
        resp.sessions.find((s) => s.role === nameOrId);
      if (match) return match.id;
      console.error(`Session not found: ${nameOrId}`);
    } else {
      this.#printError(resp);
    }
    return null;
  }

  // ── Pipeline runs (docs/pipeline-run.md) ─────────────────────────────────

  async #getPipeline(id: string): Promise<PipelineWire | undefined> {
    const resp = await this.#request({ type: "pipeline.get", id: randomUUID(), pipelineId: id });
    if (resp.type !== "pipeline.snapshot") {
      this.#printError(resp);
      return undefined;
    }
    return resp.pipeline;
  }

  async pipelineRun(pack: string, goal: string, workdir: string): Promise<void> {
    const resp = await this.#request({
      type: "pipeline.create",
      id: randomUUID(),
      name: goal.slice(0, 60) || "run",
      pack,
      spec: goal,
      workdir,
    });
    if (resp.type !== "pipeline.snapshot") {
      this.#printError(resp);
      return;
    }
    const p = resp.pipeline;
    // Kick the run off — advance drives all phases server-side (minutes), so
    // fire it and let the user poll status rather than block the CLI.
    this.#fire({ type: "pipeline.advance", id: randomUUID(), pipelineId: p.id });
    for (const line of formatPipeline(p)) console.log(line);
  }

  async pipelineStatus(id: string): Promise<void> {
    const p = await this.#getPipeline(id);
    if (p) for (const line of formatPipeline(p)) console.log(line);
  }

  async pipelineList(): Promise<void> {
    const resp = await this.#request({ type: "pipeline.list", id: randomUUID() });
    if (resp.type !== "pipeline.list.result") {
      this.#printError(resp);
      return;
    }
    if (resp.pipelines.length === 0) {
      console.log("No pipelines.");
      return;
    }
    console.log("\n  Pipelines:\n");
    for (const p of resp.pipelines) console.log(`  ${p.id}  [${p.status}]  ${p.name}`);
    console.log();
  }

  async pipelineDecide(id: string, kind: "approve" | "reject" | "revise", text?: string): Promise<void> {
    const p = await this.#getPipeline(id);
    if (!p) return;
    const reqId = haltedRequestId(p);
    if (!reqId) {
      console.error(`Pipeline ${id} is not awaiting a decision (status: ${p.status}).`);
      return;
    }
    if (kind === "revise") {
      if (!text || !text.trim()) {
        console.error("revise needs feedback text.");
        return;
      }
      this.#fire({ type: "pipeline.revise", id: randomUUID(), pipelineId: id, requestId: reqId, feedback: text });
    } else {
      this.#fire({
        type: "pipeline.answer",
        id: randomUUID(),
        pipelineId: id,
        requestId: reqId,
        approved: kind === "approve",
        value: text,
      });
    }
    console.log(`${kind} sent — watch: codeoid pipeline status ${id}`);
  }

  #request(msg: ClientMessage): Promise<DaemonMessage> {
    return new Promise((resolve, reject) => {
      if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected"));
        return;
      }

      const timeout = setTimeout(() => {
        this.#pending.delete(msg.id);
        reject(new Error("Request timeout"));
      }, 30_000);

      this.#pending.set(msg.id, (resp) => {
        clearTimeout(timeout);
        resolve(resp);
      });

      this.#ws.send(JSON.stringify(msg));
    });
  }

  /** Fire a message without awaiting a reply. For pipeline advance/answer/revise:
   *  they run SERVER-SIDE for minutes (a phase turn), far past the 30s request
   *  timeout — the daemon completes + persists them regardless of the client, so
   *  the CLI fires them and polls `pipeline.status` instead of blocking. */
  #fire(msg: ClientMessage): void {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) throw new Error("Not connected");
    this.#ws.send(JSON.stringify(msg));
  }

  async #getToken(): Promise<string> {
    const token = this.#config.apiKey;
    if (!token) {
      console.error("No API key configured.\n");
      console.error("  Set CODEOID_API_KEY environment variable");
      console.error("  Or add apiKey to ~/.codeoid/config.json");
      console.error("  Or run: codeoid login\n");
      process.exit(1);
    }

    if (token.startsWith("zid_sk_")) {
      let resp: Response;
      try {
        resp = await fetch(`${this.#config.zeroidUrl}/oauth2/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "api_key",
            api_key: token,
            scope: ALL_SCOPES_STRING,
          }),
        });
      } catch (err) {
        console.error(`Cannot reach ZeroID at ${this.#config.zeroidUrl}`);
        console.error(`  Is ZeroID running? Try: curl ${this.#config.zeroidUrl}/health\n`);
        process.exit(1);
      }

      if (!resp.ok) {
        const body = await resp.json().catch(() => ({})) as { error?: string; error_description?: string };
        if (resp.status === 400 || resp.status === 401) {
          console.error("Authentication failed — API key is invalid or expired.\n");
          if (body.error_description) console.error(`  ${body.error_description}`);
          console.error("  Re-register your agent in ZeroID or check CODEOID_API_KEY\n");
        } else {
          console.error(`Token exchange failed (${resp.status}): ${body.error_description ?? body.error ?? "unknown"}`);
        }
        process.exit(1);
      }

      const data = (await resp.json()) as { access_token: string };
      return data.access_token;
    }

    return token;
  }

  #formatStatus(status: string): string {
    switch (status) {
      case "idle":
        return "\x1b[32midle\x1b[0m";
      case "working":
        return "\x1b[33mworking\x1b[0m";
      case "waiting_approval":
        return "\x1b[31mwaiting approval\x1b[0m";
      case "error":
        return "\x1b[31merror\x1b[0m";
      default:
        return status;
    }
  }

  #printError(resp: DaemonMessage): void {
    if (resp.type === "response.error") {
      console.error(`Error: ${resp.error} (${resp.code})`);
    }
  }
}
