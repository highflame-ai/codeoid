/**
 * Terminal client — connects to the daemon over WebSocket.
 *
 * Uses Bun's native WebSocket (no ws dependency).
 */

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { resolveLocalToken } from "../config.js";
import type { CodeoidConfig } from "../config.js";
import { PIPELINE_INPUT_REQUEST_PREFIX, PROTOCOL_VERSION } from "../protocol/types.js";
import type {
  ClientMessage,
  CollaborationConfig,
  CompareState,
  CompareTargetSpec,
  DaemonMessage,
  PipelineWire,
  SessionInfo,
} from "../protocol/types.js";
import { ALL_SCOPES_STRING } from "../protocol/scopes.js";
import { sanitizeTerminalOutput } from "../tui/ansi/codes.js";
import { formatPackList, formatPackShow } from "./pack-format.js";
import { formatPipeline, haltedRequestId } from "./pipeline-format.js";
import { type PendingDialog, parseDialogAnswer } from "./dialog.js";
import { formatRewind, parseUndoArgs } from "./rewind.js";
import { awaitingApproval, compareSettled, formatCompare } from "./compare.js";

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
  /** messageId of the tool call `latestApprovalId` belongs to — cleared when it leaves waiting_confirmation (answered anywhere). */
  latestApprovalMsgId?: string | null;
  /**
   * Provider dialogs waiting for an answer (#348), oldest first. Only the
   * oldest is shown; the next typed line answers it, and when it is resolved
   * (here or on another surface) the next one is shown.
   */
  dialogs: Array<{ dialog: PendingDialog; prompt: string }>;
  /** Which prompt was printed last — a typed yes/no answers THAT one. */
  lastPrompt: "tool" | "dialog" | null;
  /** The first full replay has been printed (its last chunk arrived). */
  replayDone?: boolean;
  /** Inside a later full replay (a refresh after going back): its chunks aren't reprinted. */
  suppressingReplay?: boolean;
}

/** A tool approval was settled (anywhere): stop routing yes/no to it, and
 *  return the waiting question's prompt to show again, if it was behind it. */
function forgetToolPrompt(state: StreamRenderState): string {
  state.latestApprovalId = null;
  state.latestApprovalMsgId = null;
  if (state.lastPrompt !== "tool") return "";
  const head = state.dialogs[0];
  state.lastPrompt = head ? "dialog" : null;
  return head ? head.prompt : "";
}

export function newStreamRenderState(): StreamRenderState {
  return { streamingAssistantMsgId: null, latestApprovalId: null, dialogs: [], lastPrompt: null };
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
      // A later full snapshot (after going back a turn) refreshes the view;
      // reprinting the whole session into a terminal helps nobody. A large
      // replay arrives in chunks (seq 0…n, final on the last): only a replay
      // that STARTS after the first one finished is a refresh.
      const frame = msg as { mode?: string; seq?: number; final?: boolean };
      if (state.suppressingReplay) {
        if (frame.final) state.suppressingReplay = false;
        return "";
      }
      if (state.replayDone && frame.mode === "snapshot" && (frame.seq === undefined || frame.seq === 0)) {
        state.suppressingReplay = frame.seq === 0 && frame.final === false;
        return `${DIM}(the session view was refreshed)${RESET}\n`;
      }
      if (frame.seq === undefined || frame.final) state.replayDone = true;
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
          // Approved / denied / cancelled elsewhere: a typed yes/no is no longer
          // for it — back to the waiting question, shown again.
          const reshow =
            phase !== "waiting_confirmation" && sm.messageId && sm.messageId === state.latestApprovalMsgId
              ? forgetToolPrompt(state)
              : "";
          if (phase === "waiting_confirmation") {
            state.latestApprovalId = sm.tool?.state?.approvalId ?? null;
            state.latestApprovalMsgId = sm.messageId ?? null;
            state.lastPrompt = "tool";
            return `\n${id}${RED}⚡ ${name}: ${S(sm.tool?.state?.description)}${RESET}\n  Type 'yes' to approve, 'no' to deny\n`;
          }
          return `\n${id}${YELLOW}⚡ ${name} [${phase}]${RESET}\n${reshow}`;
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
      if (
        delta.toolStateUpdate?.phase &&
        delta.toolStateUpdate.phase !== "waiting_confirmation" &&
        delta.messageId === state.latestApprovalMsgId
      ) {
        out += forgetToolPrompt(state);
      }
      if (delta.contentAppend) out += S(delta.contentAppend);
      if (delta.toolStateUpdate) out += `${YELLOW}  → ${delta.toolStateUpdate.phase}${RESET}\n`;
      return out;
    }

    case "session.status_change": {
      const sc = msg as { status?: string };
      return `\n[status] ${sc.status}\n`;
    }

    // A provider dialog (#348): a skill-command approval, an agent's
    // question. Re-sent on attach while pending, so one raised while nobody
    // was watching shows up here.
    case "session.ui_request": {
      const req = msg as Extract<DaemonMessage, { type: "session.ui_request" }>;
      if (state.dialogs.some((d) => d.dialog.requestId === req.requestId)) return ""; // re-sent
      let prompt = `\n${RED}? ${S(req.title)}${RESET}\n`;
      if (req.message) prompt += `${S(req.message)}\n`;
      if (req.method === "confirm") prompt += "  Type 'yes' or 'no' (/skip to dismiss)\n";
      else if (req.method === "select") {
        (req.options ?? []).forEach((o, i) => {
          prompt += `  ${i + 1}. ${S(o)}\n`;
        });
        prompt += "  Type a number (/skip to dismiss)\n";
      } else prompt += "  Type your answer (/skip to dismiss)\n";
      state.dialogs.push({
        dialog: { requestId: req.requestId, method: req.method, ...(req.options ? { options: req.options } : {}) },
        prompt,
      });
      // Shown only when it is the one being answered.
      if (state.dialogs.length !== 1) return "";
      state.lastPrompt = "dialog";
      return prompt;
    }

    case "session.ui_resolved": {
      const res = msg as Extract<DaemonMessage, { type: "session.ui_resolved" }>;
      const i = state.dialogs.findIndex((d) => d.dialog.requestId === res.requestId);
      if (i < 0) return "";
      state.dialogs.splice(i, 1);
      if (i > 0) return ""; // a queued one, not yet shown
      let out = res.reason === "answered" ? "" : `${DIM}(question closed: ${S(res.reason)})${RESET}\n`;
      if (state.dialogs[0]) {
        out += state.dialogs[0].prompt;
        state.lastPrompt = "dialog";
      }
      return out;
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

  /**
   * `capabilities`: what this connection declares. An interactive attach
   * declares `ui.dialogs`, so provider dialogs (and pending ones, on attach)
   * are sent to it; one-shot commands declare nothing.
   */
  async connect(opts: { capabilities?: string[] } = {}): Promise<void> {
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
            ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
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
        if (s.pendingDialog) {
          // What it is waiting on, and how to answer it from here (#348).
          const how =
            s.pendingDialog.method === "confirm"
              ? `codeoid approve ${s.name} [--deny], or codeoid attach ${s.name}`
              : `codeoid attach ${s.name}`;
          console.log(`  ${"".padEnd(20)} waiting: ${S(s.pendingDialog.title)} — answer with: ${how}`);
        }
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

  async packShow(id: string, opts: { resolve?: boolean } = {}): Promise<void> {
    const resp = await this.#request({ type: "pipeline.pack.list", id: randomUUID() });
    if (resp.type !== "pipeline.pack.list.result") {
      this.#printError(resp);
      return;
    }
    const lines = formatPackShow(resp, id, opts);
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
    opts: {
      pack?: string;
      packRole?: string;
      providerId?: string;
      model?: string;
      collaboration?: CollaborationConfig;
    } = {},
  ): Promise<void> {
    const resp = await this.#request({
      type: "session.create",
      id: randomUUID(),
      name,
      workdir,
      // The daemon fail-closes on an id it hasn't registered (it advertises the
      // set on auth.ok), so a typo is rejected rather than silently handing back
      // a claude session.
      ...(opts.providerId ? { providerId: opts.providerId } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.pack ? { pack: opts.pack } : {}),
      ...(opts.packRole ? { packRole: opts.packRole } : {}),
      ...(opts.collaboration ? { collaboration: opts.collaboration } : {}),
    });

    if (resp.type === "response.ok") {
      const data = resp.data as SessionInfo;
      const profile = data.profile ? ` [pack: ${data.profile}]` : "";
      const provider = data.providerId ? ` [${data.providerId}]` : "";
      console.log(`Session created: ${data.name} (${data.id})${provider}${profile}`);
      // Non-fatal binding notes (skipped cross-vendor bindings, unmapped
      // tiers) — the daemon adjusted something the operator should know about.
      for (const w of resp.warnings ?? []) console.log(`  ⚠ ${w}`);
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

    // Streaming/approval bookkeeping, carried across messages. `latestApprovalId`
    // is read below to route a typed yes/no; both fields are mutated by
    // renderStreamMessage, which also sanitizes every untrusted field before it
    // reaches the TTY (OSC/CSI/DCS escapes — see #91/#92).
    const renderState = newStreamRenderState();

    // Installed BEFORE the attach request: the daemon replays the scrollback
    // and any pending dialog while handling it, ahead of its reply, and a
    // handler set afterwards dropped them (#348 — a pending question never
    // showed). Buffered until the attach succeeds, so nothing prints for a
    // refused attach and the banner comes first.
    const early: DaemonMessage[] = [];
    let attached = false;
    const render = (msg: DaemonMessage) => {
      const out = renderStreamMessage(msg, renderState);
      if (out) process.stdout.write(out);
    };
    this.#streamHandler = (msg) => {
      if (attached) render(msg);
      else early.push(msg);
    };

    const resp = await this.#request({
      type: "session.attach",
      id: randomUUID(),
      sessionId,
    });

    if (resp.type !== "response.ok") {
      this.#streamHandler = null;
      this.#printError(resp);
      return;
    }

    console.log("\nAttached to session. Type messages below. Ctrl+C to detach.\n");
    attached = true;
    // A pending question last, below the scrollback it belongs after — the
    // daemon replays dialogs first.
    const buffered = early.splice(0);
    for (const msg of buffered) if (msg.type !== "session.ui_request") render(msg);
    for (const msg of buffered) if (msg.type === "session.ui_request") render(msg);

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

      // Go back a turn (#355): the taken-back message comes back to the
      // prompt line, to edit and resend.
      if (trimmed === "/undo" || trimmed.startsWith("/undo ")) {
        const restored = await this.#undo(sessionId, trimmed.split(/\s+/).slice(1));
        // Pre-fill only a single, sanitized line: readline submits every
        // newline it is fed, so a multi-line prompt (or one carrying
        // "/undo files force") would be sent — or run — line by line.
        const oneLine = restored ? S(restored).replace(/[\x00-\x1f\x7f]/g, "") : "";
        if (restored && !/[\r\n]/.test(restored) && oneLine) rl.write(oneLine);
        else if (restored) console.log("(It spans several lines, so it isn't pre-filled — copy it from above to send it again.)");
        continue;
      }

      // A tool approval printed after the question is what a yes/no answers;
      // then the question is shown again.
      const toolPromptLast = renderState.lastPrompt === "tool" && renderState.latestApprovalId;
      // Any yes/no form, so "y" meant for the tool can't grant the question.
      const yesNo = /^(y|yes|n|no)$/i.test(trimmed);
      // A provider dialog is showing: this line answers it. Its resolution
      // (session.ui_resolved) drops it from the queue and shows the next.
      const dialog = renderState.dialogs[0]?.dialog;
      if (dialog && !(toolPromptLast && yesNo)) {
        const answer = parseDialogAnswer(trimmed, dialog);
        if ("error" in answer) {
          console.log(answer.error);
          continue;
        }
        const resp = await this.#request({ type: "session.ui_response", id: randomUUID(), sessionId, requestId: dialog.requestId, ...answer });
        if (resp.type === "response.error" && (resp.code === "not_found" || resp.code === "forbidden")) {
          // Not answerable from here (already resolved, or no session:approve):
          // drop it so the next line isn't parsed as an answer again.
          this.#printError(resp);
          const i = renderState.dialogs.findIndex((d) => d.dialog.requestId === dialog.requestId);
          if (i >= 0) renderState.dialogs.splice(i, 1);
          const next = renderState.dialogs[0];
          if (next && i === 0) {
            process.stdout.write(next.prompt);
            renderState.lastPrompt = "dialog";
          }
        } else if (resp.type === "response.error") {
          this.#printError(resp); // e.g. an answer too long — try again
        }
        continue;
      }

      if (yesNo && renderState.latestApprovalId) {
        await this.#request({
          type: "session.approve",
          id: randomUUID(),
          sessionId,
          approvalId: renderState.latestApprovalId,
          approved: /^y/i.test(trimmed),
        });
        renderState.latestApprovalId = null;
        renderState.latestApprovalMsgId = null;
        renderState.lastPrompt = null;
        // Back to the question that was waiting behind the tool approval.
        const head = renderState.dialogs[0];
        if (head) {
          process.stdout.write(head.prompt);
          renderState.lastPrompt = "dialog";
        }
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

  /**
   * Go back a turn (#355) and print what happened. Returns the taken-back
   * prompt when it was really taken back (not a preview or a refusal).
   */
  async #undo(sessionId: string, args: string[], opts: { confirming?: boolean } = {}): Promise<string | null> {
    const req = parseUndoArgs(args);
    if ("error" in req) {
      console.log(req.error);
      return null;
    }
    // Restoring files acts on exactly what was previewed: the same turn and
    // plan — the daemon refuses if anything changed in between.
    let turnId: string;
    let planId: string | undefined;
    const preview = this.#undoPreview;
    if (req.restoreFiles && !req.dryRun && preview && preview.sessionId === sessionId) {
      ({ turnId, planId } = preview);
    } else if (req.restoreFiles && !req.dryRun) {
      // No preview to confirm (e.g. one-shot `codeoid undo … files yes`):
      // preview now and confirm exactly that plan in the same breath.
      if ((await this.#undo(sessionId, ["files"], { confirming: true })) === null && !this.#undoPreview) return null;
      const fresh = this.#undoPreview as { sessionId: string; turnId: string; planId: string } | null;
      if (!fresh) return null;
      ({ turnId, planId } = fresh);
    } else {
      const list = await this.#request({ type: "session.turns", id: randomUUID(), sessionId });
      if (list.type !== "session.turns.result") {
        this.#printError(list);
        return null;
      }
      const last = list.turns.at(-1);
      if (!last) {
        console.log("Nothing to undo.");
        return null;
      }
      turnId = last.turnId;
    }
    this.#undoPreview = null;
    const res = await this.#request({
      type: "session.rewind",
      id: randomUUID(),
      sessionId,
      turnId,
      ...(req.restoreFiles ? { restoreFiles: true } : {}),
      ...(req.dryRun ? { dryRun: true } : {}),
      ...(req.force ? { force: true } : {}),
      ...(planId ? { planId } : {}),
    });
    if (res.type !== "session.rewind.result") {
      this.#printError(res);
      return null;
    }
    if (req.dryRun) this.#undoPreview = { sessionId, turnId, planId: res.planId };
    console.log(S(formatRewind(res, { hint: !opts.confirming })));
    return !res.dryRun && !res.refused ? res.restoredPrompt : null;
  }

  /** The last `/undo files` preview, which `/undo files yes|force` confirms. */
  #undoPreview: { sessionId: string; turnId: string; planId: string } | null = null;

  /**
   * `codeoid fork <session> [--at N] [--backend id] [--shared] [--name n]`
   * (#356): fork from the latest point, or after prompt N with the files as
   * they were then.
   */
  async forkSession(
    sessionIdOrName: string,
    opts: { at?: number; backend?: string; shared?: boolean; name?: string },
  ): Promise<void> {
    const sessionId = await this.#resolveSession(sessionIdOrName);
    if (!sessionId) return;
    let afterTurnId: string | undefined;
    if (opts.at !== undefined) {
      const list = await this.#request({ type: "session.turns", id: randomUUID(), sessionId });
      if (list.type !== "session.turns.result") {
        this.#printError(list);
        return;
      }
      const t = list.turns[opts.at - 1];
      if (!t) {
        console.log(`There is no prompt ${opts.at} (this session has ${list.turns.length}).`);
        return;
      }
      afterTurnId = t.turnId;
    }
    const resp = await this.#request({
      type: "session.fork",
      id: randomUUID(),
      sessionId,
      ...(afterTurnId ? { afterTurnId } : {}),
      ...(opts.backend ? { providerId: opts.backend } : {}),
      ...(opts.shared ? { isolate: false } : {}),
      ...(opts.name ? { name: opts.name } : {}),
    });
    if (resp.type !== "response.ok") {
      this.#printError(resp);
      return;
    }
    const info = resp.data as { id: string; name: string; workdir: string; providerId?: string };
    console.log(`Forked: ${S(info.name)} (${info.id}) [${S(info.providerId ?? "")}] in ${S(info.workdir)}`);
    console.log(`Attach with: codeoid attach ${info.id}`);
  }

  /** `codeoid turns <session>` — the numbered turns `--at N` / `/fork N` refer to. */
  async listTurns(sessionIdOrName: string): Promise<void> {
    const sessionId = await this.#resolveSession(sessionIdOrName);
    if (!sessionId) return;
    const list = await this.#request({ type: "session.turns", id: randomUUID(), sessionId });
    if (list.type !== "session.turns.result") {
      this.#printError(list);
      return;
    }
    if (list.turns.length === 0) console.log("No turns yet.");
    for (const t of list.turns) {
      const tag = t.kind === "background" ? " (background)" : "";
      const snap = t.checkpoint ? "" : list.checkpointsSupported ? "  [no snapshot]" : "";
      console.log(`${String(t.index).padStart(3)}. ${S(t.preview)}${tag}${snap}`);
    }
  }

  /**
   * `codeoid compare run` (#357): fork one branch per target, send each the
   * prompt, and (unless `wait` is false) wait for all of them, then print them
   * side by side, numbered for `compare keep`.
   */
  async compareRun(
    sessionIdOrName: string,
    targets: CompareTargetSpec[],
    prompt: string,
    opts: { at?: number; wait?: boolean },
  ): Promise<void> {
    const sessionId = await this.#resolveSession(sessionIdOrName);
    if (!sessionId) return;
    let afterTurnId: string | undefined;
    if (opts.at !== undefined) {
      const list = await this.#request({ type: "session.turns", id: randomUUID(), sessionId });
      if (list.type !== "session.turns.result") {
        this.#printError(list);
        return;
      }
      const t = list.turns[opts.at - 1];
      if (!t) {
        console.log(`There is no prompt ${opts.at} (this session has ${list.turns.length}).`);
        return;
      }
      afterTurnId = t.turnId;
    }
    const resp = await this.#request({
      type: "session.compare",
      id: randomUUID(),
      sessionId,
      prompt,
      targets,
      ...(afterTurnId ? { afterTurnId } : {}),
    });
    if (resp.type !== "compare.state") {
      this.#printError(resp);
      return;
    }
    let state = resp.compare;
    if (opts.wait !== false) {
      console.log(`Comparing on ${targets.length} backends — waiting for them to finish (Ctrl-C to stop waiting; they keep running)…`);
      state = await this.#waitForCompare(state);
    }
    console.log(S(formatCompare(state)));
    this.#printApprovalHints(state);
    if (compareSettled(state) && awaitingApproval(state).length === 0) {
      console.log(`\nKeep one: codeoid compare keep ${state.compareId.slice(0, 8)} <branch> [--discard-others]`);
    } else {
      console.log(`\nSee how they're doing: codeoid compare show ${state.compareId.slice(0, 8)} --wait`);
    }
  }

  /** Branches can't go on until someone decides: say who and how. */
  #printApprovalHints(state: CompareState): void {
    const waiting = awaitingApproval(state);
    if (waiting.length === 0) return;
    console.log("");
    for (const w of waiting) {
      console.log(`[${w.branch}] ${S(w.name)} is waiting for your approval: codeoid approve ${w.sessionId}  (or codeoid attach ${w.sessionId} to see it)`);
    }
  }

  async #waitForCompare(state: CompareState): Promise<CompareState> {
    let s = state;
    while (!compareSettled(s)) {
      await new Promise((r) => setTimeout(r, 2_000));
      const next = await this.#request({ type: "compare.get", id: randomUUID(), compareId: s.compareId });
      if (next.type !== "compare.state") break;
      s = next.compare;
    }
    return s;
  }

  /** A comparison by id (or a unique id prefix among the session's, via `compare ls`). */
  async #resolveCompare(idOrPrefix: string): Promise<CompareState | undefined> {
    const direct = await this.#request({ type: "compare.get", id: randomUUID(), compareId: idOrPrefix });
    if (direct.type === "compare.state") return direct.compare;
    // A short prefix: look through the sessions' comparisons.
    const sessions = await this.#request({ type: "session.list", id: randomUUID() });
    if (sessions.type !== "session.list.result") {
      this.#printError(direct);
      return undefined;
    }
    const matches: CompareState[] = [];
    for (const info of sessions.sessions) {
      const list = await this.#request({ type: "compare.list", id: randomUUID(), sessionId: info.id });
      if (list.type !== "compare.list.result") continue;
      matches.push(...list.compares.filter((c) => c.compareId.startsWith(idOrPrefix)));
    }
    if (matches.length === 1) return matches[0];
    console.log(matches.length === 0 ? `No comparison ${idOrPrefix}.` : `${idOrPrefix} matches ${matches.length} comparisons — give more of the id.`);
    return undefined;
  }

  /** `codeoid compare show <id>` — a comparison's branches, side by side. */
  async compareShow(idOrPrefix: string, opts: { wait?: boolean } = {}): Promise<void> {
    let state = await this.#resolveCompare(idOrPrefix);
    if (!state) return;
    if (opts.wait) state = await this.#waitForCompare(state);
    console.log(S(formatCompare(state)));
    this.#printApprovalHints(state);
  }

  /** `codeoid compare ls <session>` — a session's comparisons, newest first. */
  async compareList(sessionIdOrName: string): Promise<void> {
    const sessionId = await this.#resolveSession(sessionIdOrName);
    if (!sessionId) return;
    const list = await this.#request({ type: "compare.list", id: randomUUID(), sessionId });
    if (list.type !== "compare.list.result") {
      this.#printError(list);
      return;
    }
    if (list.compares.length === 0) console.log("No comparisons yet.");
    for (const c of list.compares) {
      const branches = c.targets.map((t) => `${t.providerId}${t.model ? `:${t.model}` : ""}${t.sessionId && t.sessionId === c.keptSessionId ? "★" : ""}`).join(" · ");
      console.log(`${c.compareId.slice(0, 8)}  ${c.createdAt.slice(0, 16).replace("T", " ")}  ${S(branches)}  "${S(c.prompt.replace(/\s+/g, " ").slice(0, 60))}"`);
    }
  }

  /** `codeoid compare keep <id> <branch> [--discard-others]`. */
  async compareKeep(idOrPrefix: string, branch: number, discardOthers: boolean): Promise<void> {
    const state = await this.#resolveCompare(idOrPrefix);
    if (!state) return;
    const target = state.targets[branch - 1];
    if (!target?.sessionId) {
      console.log(`Branch ${branch} isn't a session you can keep (this comparison has ${state.targets.length} branches).`);
      return;
    }
    const resp = await this.#request({
      type: "compare.keep",
      id: randomUUID(),
      compareId: state.compareId,
      sessionId: target.sessionId,
      ...(discardOthers ? { discardOthers: true } : {}),
    });
    if (resp.type !== "compare.state") {
      this.#printError(resp);
      return;
    }
    const left = resp.compare.targets.filter((t) => t.sessionId !== target.sessionId && t.sessionId && t.status !== "gone").length;
    const others = !discardOthers ? "" : left === 0 ? "; the other branches were destroyed" : `; ${left} other branch(es) couldn't be destroyed`;
    console.log(S(`Kept [${branch}] ${target.providerId}${target.model ? `:${target.model}` : ""} — session ${target.sessionId}${others}.`));
    console.log(`Attach with: codeoid attach ${target.sessionId}`);
  }

  /** `codeoid undo <session> [files [yes|force]]` — /undo without attaching. */
  async undoSession(sessionIdOrName: string, args: string[]): Promise<void> {
    const sessionId = await this.#resolveSession(sessionIdOrName);
    if (!sessionId) return;
    const restored = await this.#undo(sessionId, args);
    if (restored) console.log(`\nThe message that was taken back:\n${S(restored)}`);
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

    // A pending yes/no dialog (e.g. a skill-command approval, #348) is answered
    // by its real request id, from the session's info.
    const list = await this.#request({ type: "session.list", id: randomUUID() });
    const dialog =
      list.type === "session.list.result" ? list.sessions.find((s) => s.id === sessionId)?.pendingDialog : undefined;
    if (dialog) {
      if (dialog.method !== "confirm") {
        console.error(`The session is waiting on a question, not a yes/no: ${S(dialog.title)}`);
        console.error(`  Answer it with: codeoid attach ${sessionIdOrName}`);
        return;
      }
      // Show exactly what is being answered — the title names the command,
      // the message says what it does.
      console.log(S(dialog.title));
      if (dialog.message) console.log(S(dialog.message));
      const resp = await this.#request({
        type: "session.ui_response",
        id: randomUUID(),
        sessionId,
        requestId: dialog.requestId,
        confirmed: approved,
      });
      if (resp.type === "response.ok") console.log(approved ? "Approved." : "Denied.");
      else this.#printError(resp);
      return;
    }

    // A tool approval is answered by its own id (the daemon never guesses
    // "the first pending" — see Session#approve): read it off the session.
    const pending = await this.#pendingToolApproval(sessionId);
    if (!pending) {
      console.log("Nothing in that session is waiting for an approval.");
      return;
    }
    console.log(`${S(pending.name)}${pending.description ? `: ${S(pending.description)}` : ""}`);
    const resp = await this.#request({
      type: "session.approve",
      id: randomUUID(),
      sessionId,
      approvalId: pending.approvalId,
      approved,
    });

    if (resp.type === "response.ok") {
      console.log(approved ? "Approved." : "Denied.");
    } else {
      this.#printError(resp);
    }
  }

  /** Pre-approve (or deny) a skill-declared command for a workdir (#348). */
  async skillGrant(command: string, workdir: string, allowed: boolean): Promise<void> {
    const resp = await this.#request({ type: "skill.grant", id: randomUUID(), workdir, command, allowed });
    if (resp.type === "skill.grant.result") {
      console.log(`${resp.allowed ? "Allowed" : "Denied"} for ${resp.workdir}: ${S(resp.command)}`);
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

  async pipelineRun(
    pack: string,
    goal: string,
    workdir: string,
    roleBindings?: Record<string, { provider: string; model?: string }>,
  ): Promise<void> {
    const resp = await this.#request({
      type: "pipeline.create",
      id: randomUUID(),
      name: goal.slice(0, 60) || "run",
      pack,
      spec: goal,
      workdir,
      ...(roleBindings ? { roleBindings } : {}),
    });
    if (resp.type !== "pipeline.snapshot") {
      this.#printError(resp);
      return;
    }
    const p = resp.pipeline;
    // Create-time binding notes (a --role/config binding skipped because it
    // targets a backend other than the run session's, an unmapped tier).
    for (const w of resp.warnings ?? []) console.log(`  ⚠ ${w}`);
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
    if (kind === "approve" && reqId.startsWith(PIPELINE_INPUT_REQUEST_PREFIX)) {
      // The daemon refuses this (it would pass the phase without the answer
      // it asked for), and a fire-and-forget refusal never reaches the user.
      console.error(
        `Pipeline ${id} is waiting for an answer to the phase's question — answer it with: codeoid pipeline revise ${id} "<your answer>"`,
      );
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

  /**
   * The oldest tool call still waiting for a decision in a session, from its
   * scrollback (attach, read the replay, detach) — what an attached client
   * would show as the question.
   */
  async #pendingToolApproval(sessionId: string): Promise<{ approvalId: string; name: string; description?: string } | null> {
    type Row = { type?: string; role?: string; messageId?: string; content?: string; tool?: { name?: string; state?: { phase?: string; approvalId?: string; description?: string } } };
    const rows: Row[] = [];
    let done!: () => void;
    const replayed = new Promise<void>((r) => {
      done = r;
    });
    const prev = this.#streamHandler;
    this.#streamHandler = (msg) => {
      const m = msg as { type: string; sessionId?: string; messages?: Row[]; seq?: number; final?: boolean };
      if (m.type !== "scrollback.replay" || m.sessionId !== sessionId) return;
      rows.push(...(m.messages ?? []));
      if (m.seq === undefined || m.final) done();
    };
    try {
      const attached = await this.#request({ type: "session.attach", id: randomUUID(), sessionId });
      if (attached.type === "response.error") {
        this.#printError(attached);
        return null;
      }
      await Promise.race([replayed, new Promise((r) => setTimeout(r, 3_000))]);
    } finally {
      this.#streamHandler = prev;
      await this.#request({ type: "session.detach", id: randomUUID(), sessionId }).catch(() => undefined);
    }
    // Latest state per tool call, then the oldest still waiting.
    const latest = new Map<string, Row>();
    for (const r of rows) if (r.role === "tool_call" && r.messageId) latest.set(r.messageId, r);
    for (const r of latest.values()) {
      const st = r.tool?.state;
      if (st?.phase === "waiting_confirmation" && st.approvalId) {
        return { approvalId: st.approvalId, name: r.tool?.name ?? r.content ?? "tool", ...(st.description ? { description: st.description } : {}) };
      }
    }
    return null;
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
    // Local mode first: a token published for THIS daemon's port means a
    // `--local` daemon is listening there right now, which is a stronger signal
    // about what it will accept than a durable apiKey in config.json (see
    // resolveLocalToken). Zero setup — this is what makes `codeoid start
    // --local` + `codeoid tui` work with no copy-paste.
    const localToken = resolveLocalToken(this.#config.daemonUrl);
    if (localToken) return localToken;

    const token = this.#config.apiKey;
    if (!token) {
      console.error("No API key configured.\n");
      console.error("  Set CODEOID_API_KEY environment variable");
      console.error("  Or add apiKey to ~/.codeoid/config.json");
      console.error("  Or run: codeoid login");
      console.error("  Or, to try codeoid with no account at all: codeoid start --local\n");
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
      // Errors can quote client- or agent-supplied text (names, model ids).
      console.error(`Error: ${S(resp.error)} (${resp.code})`);
    }
  }
}
