/**
 * Slash-command parsing + dispatch. Mirrors the TUI verbs:
 *   /new <name> [workdir]    — create a session (workdir defaults to cwd)
 *   /rename <name>           — rename focused session
 *   /destroy                 — destroy focused session
 *   /interrupt               — interrupt current turn
 *   /rotate                  — rotate context (refresh skills/settings)
 *   /mode <i|g|x>            — interactive | guarded | autonomous
 *   /model <id|alias>        — switch model (opus / sonnet / haiku / full id)
 *   /help                    — surface help modal (TODO P6)
 *   /clear                   — clear prompt (handled by caller before dispatch)
 *
 * Pure functions — easy to unit-test. The `dispatch` helper takes a
 * thin context object so we can mock send/newRequestId in tests.
 */

import type {
  ClientMessage,
  SessionInfo,
  SessionMode,
} from "@highflame/codeoid-protocol";

export type SlashCommand =
  | { kind: "new"; name: string; workdir?: string }
  | { kind: "rename"; name: string }
  | { kind: "destroy" }
  | { kind: "interrupt" }
  | { kind: "rotate" }
  | { kind: "mode"; mode: SessionMode; maxTurns?: number }
  | { kind: "model"; model: string; fallback?: string | null }
  | { kind: "model-picker" }
  | { kind: "provider"; providerId: string }
  | { kind: "help" }
  | { kind: "clear" }
  | { kind: "who" }
  | { kind: "capabilities"; tab: "agents" | "skills" | "mcp" | "hooks" }
  | { kind: "settings" }
  | { kind: "packs" }
  | { kind: "pipeline"; goal?: string }
  | { kind: "export" }
  | { kind: "import" }
  | { kind: "fork"; providerId?: string };

export interface ParseSlashOptions {
  /**
   * Provider-command passthrough (`session.commands` catalogs). When the
   * verb is not a built-in and this predicate matches it, `parseSlash`
   * returns null — "not a client command" — so the caller sends the raw
   * text as a normal prompt and the session's provider expands it.
   */
  isProviderCommand?: (name: string) => boolean;
}

export function parseSlash(raw: string, opts?: ParseSlashOptions): SlashCommand | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return null;
  const head = trimmed.slice(1);
  const [verb, ...rest] = head.split(/\s+/);
  if (!verb) return null;

  switch (verb.toLowerCase()) {
    case "new": {
      if (rest.length === 0) {
        throw new Error("/new <name> [workdir]");
      }
      const [name, ...wd] = rest;
      const workdir = wd.length > 0 ? wd.join(" ") : undefined;
      return { kind: "new", name: name!, workdir };
    }
    case "rename": {
      if (rest.length === 0) throw new Error("/rename <name>");
      return { kind: "rename", name: rest.join(" ") };
    }
    case "destroy":
      return { kind: "destroy" };
    case "interrupt":
      return { kind: "interrupt" };
    case "rotate":
      return { kind: "rotate" };
    case "mode": {
      const m = rest[0]?.toLowerCase();
      if (!m) throw new Error("/mode <guarded|interactive|autonomous>");
      const mode: SessionMode | undefined =
        m === "i" || m === "interactive"
          ? "interactive"
          : // `a`/`auto`/`auto-allow` kept as backward-compat aliases for `guarded`.
            m === "g" || m === "guarded" || m === "a" || m === "auto-allow" || m === "auto"
            ? "guarded"
            : m === "x" || m === "autonomous"
              ? "autonomous"
              : undefined;
      if (!mode) throw new Error(`unknown mode: ${m}`);
      const maxTurnsArg = rest[1];
      const maxTurns = maxTurnsArg ? Number.parseInt(maxTurnsArg, 10) : undefined;
      return {
        kind: "mode",
        mode,
        ...(maxTurns !== undefined && Number.isFinite(maxTurns)
          ? { maxTurns }
          : {}),
      };
    }
    case "model": {
      // Bare `/model` opens the model picker (list + current). With an
      // argument it switches directly.
      if (rest.length === 0) return { kind: "model-picker" };
      const [model, fallback] = rest;
      return {
        kind: "model",
        model: model!,
        ...(fallback !== undefined ? { fallback } : {}),
      };
    }
    case "provider": {
      // Switch the focused session's BACKEND (e.g. `/provider pi`). The
      // daemon validates the id fail-closed and rejects mid-turn switches.
      const providerId = rest[0]?.toLowerCase();
      if (!providerId) throw new Error("/provider <id> — e.g. /provider pi");
      return { kind: "provider", providerId };
    }
    case "help":
      return { kind: "help" };
    case "clear":
      return { kind: "clear" };
    case "who":
    case "whoami":
      return { kind: "who" };
    case "agents":
    case "agent":
      return { kind: "capabilities", tab: "agents" };
    case "skills":
    case "skill":
      return { kind: "capabilities", tab: "skills" };
    case "mcp":
      return { kind: "capabilities", tab: "mcp" };
    case "hooks":
    case "hook":
      return { kind: "capabilities", tab: "hooks" };
    case "settings":
    case "config":
    case "prefs":
      return { kind: "settings" };
    case "packs":
    case "pack":
      return { kind: "packs" };
    case "pipeline":
      // `/pipeline` opens the runner; `/pipeline <goal…>` prefills the goal.
      return { kind: "pipeline", ...(rest.length > 0 ? { goal: rest.join(" ") } : {}) };
    case "export":
    case "share":
      return { kind: "export" };
    case "import":
      return { kind: "import" };
    case "fork":
      // `/fork [backend]` — branch the CURRENT session, optionally onto a
      // different backend. (Historically an alias for /import, which
      // silently discarded the argument and opened the bundle dialog.)
      return { kind: "fork", providerId: rest[0]?.toLowerCase() };
    default:
      // Not a built-in. Provider commands (pi extensions, prompt templates,
      // skills) pass through as plain prompt text — the provider expands them.
      if (opts?.isProviderCommand?.(verb.toLowerCase())) return null;
      throw new Error(`unknown slash command: /${verb}`);
  }
}

export interface SlashContext {
  sessionId: string;
  send: (msg: ClientMessage) => void;
  newRequestId: () => string;
  removeSession: (id: string) => void;
  /**
   * Send a command and await the daemon's response, rejecting on
   * `response.error`. When provided, fallible commands route through this so
   * the daemon's error (e.g. "Unknown model") surfaces via `report`. Falls
   * back to fire-and-forget `send` when absent (e.g. in tests).
   */
  request?: (msg: ClientMessage) => Promise<unknown>;
  /** Surface a command error to the user (wired to the prompt's error line). */
  report?: (message: string) => void;
  /** Optional UI hooks — caller provides as needed. */
  showHelp?: () => void;
  showModelPicker?: () => void;
  showIdentity?: () => void;
  showCapabilities?: (tab: "agents" | "skills" | "mcp" | "hooks") => void;
  showSettings?: () => void;
  /** Open the pack browser (dynamic pack loading — docs/pack-loading.md). */
  showPacks?: () => void;
  /** Open the pipeline runner, optionally prefilling the goal
   *  (governed SDLC run — docs/pipeline-run.md). */
  showPipeline?: (goal?: string) => void;
  showExport?: () => void;
  showImport?: () => void;
  /**
   * Called with the fork's SessionInfo after a successful `/fork`, so the
   * frontend can add it to its store and focus it. Absent = the daemon's
   * `session.list` broadcast is the only signal.
   */
  onSessionForked?: (session: SessionInfo) => void;
}

export function dispatchSlash(cmd: SlashCommand, ctx: SlashContext): void {
  // Send a daemon command, surfacing any `response.error` via `report` so
  // the user gets feedback (e.g. `/model o` → "Unknown model"). Falls back
  // to fire-and-forget when no request channel is wired.
  const fire = (msg: ClientMessage): void => {
    if (ctx.request) {
      ctx.request(msg).catch((e) =>
        ctx.report?.(e instanceof Error ? e.message : String(e)),
      );
    } else {
      ctx.send(msg);
    }
  };

  switch (cmd.kind) {
    case "new":
      fire({
        type: "session.create",
        id: ctx.newRequestId(),
        name: cmd.name,
        workdir: cmd.workdir ?? ".",
      });
      return;
    case "rename":
      fire({
        type: "session.rename",
        id: ctx.newRequestId(),
        sessionId: ctx.sessionId,
        name: cmd.name,
      });
      return;
    case "destroy":
      fire({
        type: "session.destroy",
        id: ctx.newRequestId(),
        sessionId: ctx.sessionId,
      });
      // Optimistically drop locally; the daemon's broadcast will confirm.
      ctx.removeSession(ctx.sessionId);
      return;
    case "interrupt":
      fire({
        type: "session.interrupt",
        id: ctx.newRequestId(),
        sessionId: ctx.sessionId,
      });
      return;
    case "rotate":
      fire({
        type: "session.rotate",
        id: ctx.newRequestId(),
        sessionId: ctx.sessionId,
      });
      return;
    case "mode":
      fire({
        type: "session.set_mode",
        id: ctx.newRequestId(),
        sessionId: ctx.sessionId,
        mode: cmd.mode,
        ...(cmd.maxTurns !== undefined ? { maxTurns: cmd.maxTurns } : {}),
      });
      return;
    case "model":
      fire({
        type: "session.set_model",
        id: ctx.newRequestId(),
        sessionId: ctx.sessionId,
        model: cmd.model,
        ...(cmd.fallback !== undefined ? { fallbackModel: cmd.fallback } : {}),
      });
      return;
    case "model-picker":
      ctx.showModelPicker?.();
      return;
    case "provider":
      fire({
        type: "session.set_provider",
        id: ctx.newRequestId(),
        sessionId: ctx.sessionId,
        providerId: cmd.providerId,
      });
      return;
    case "help":
      ctx.showHelp?.();
      return;
    case "clear":
      // Pure UI side-effect handled by the caller.
      return;
    case "who":
      ctx.showIdentity?.();
      return;
    case "capabilities":
      ctx.showCapabilities?.(cmd.tab);
      return;
    case "settings":
      ctx.showSettings?.();
      return;
    case "packs":
      ctx.showPacks?.();
      return;
    case "pipeline":
      ctx.showPipeline?.(cmd.goal);
      return;
    case "export":
      ctx.showExport?.();
      return;
    case "import":
      ctx.showImport?.();
      return;
    case "fork": {
      const msg: ClientMessage = {
        type: "session.fork",
        id: ctx.newRequestId(),
        sessionId: ctx.sessionId,
        ...(cmd.providerId ? { providerId: cmd.providerId } : {}),
      };
      if (ctx.request) {
        ctx
          .request(msg)
          .then((data) => {
            if (data && typeof data === "object" && "id" in data) {
              ctx.onSessionForked?.(data as SessionInfo);
            }
          })
          .catch((e) => ctx.report?.(e instanceof Error ? e.message : String(e)));
      } else {
        ctx.send(msg);
      }
      return;
    }
  }
}
