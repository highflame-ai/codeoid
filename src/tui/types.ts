/**
 * TUI-facing types.
 *
 * These are projections of protocol types into what the UI actually renders:
 * a per-session state with an append-only message list, an active streaming
 * assistant message (if any), and aggregate UX signals (unread count,
 * pending approval).
 */

import type { ProviderInfo, SessionInfo, SessionMessage, ToolState } from "../protocol/types.js";

/** UI-facing session state — derived from daemon events. */
export interface TuiSession {
  info: SessionInfo;
  /**
   * Finalized messages that will never mutate again. Rendered once into the
   * terminal's native scrollback via Ink's <Static>.
   */
  committed: SessionMessage[];
  /**
   * Actively-updating messages — streaming assistant/thinking content, or
   * tool_calls still in `executing`/`waiting_confirmation`. Rendered inside
   * the re-rendering live region.
   */
  live: SessionMessage[];
  /** Streaming buffer (parallel to the live message) — helps the live spinner. */
  streaming: { messageId: string; text: string } | null;
  /** Count of committed messages since user last viewed this session. */
  unread: number;
  /** Currently pending approval (first one wins — daemon-side constraint). */
  pendingApproval: {
    approvalId: string;
    toolName: string;
    description: string;
  } | null;
}

/** Top-level TUI state. */
export interface TuiState {
  providers: ProviderInfo[];
  /** All sessions by id. */
  sessions: Map<string, TuiSession>;
  /** Ordered list of session ids for rendering. */
  order: string[];
  /** Currently focused session id (null = no session selected / empty state). */
  focused: string | null;
  /** Connection state. */
  connection: "connecting" | "connected" | "reconnecting" | "error";
  /** Last error to surface in the status bar. */
  lastError: string | null;
  /** Input buffer (per focused session). */
  input: string;
  /** Cursor position within the input buffer, 0..input.length. */
  cursor: number;
  /** Prompt history — most recent first. */
  history: string[];
  /** Current index into history (null = editing new prompt, 0 = most recent). */
  historyIdx: number | null;
  /** Stashed draft when user starts cycling history (so we can restore). */
  draft: string | null;
  /** Modal overlay state. */
  modal: ModalState | null;
}

export type ModalState =
  | { kind: "new-session" }
  | { kind: "switch-session"; query: string }
  | { kind: "confirm-destroy"; sessionId: string }
  | { kind: "help" }
  | { kind: "search"; query: string }
  /**
   * Backend pickers carry the session they were opened for, so a focus
   * change while one is open (reconnect, sessions.set) cannot retarget it.
   */
  | { kind: "model" | "provider" | "effort"; sessionId: string }
  /**
   * The account picker also carries the backend whose accounts it lists: if
   * the session moves to another backend while it is open, it closes rather
   * than quietly offering (or applying) another backend's accounts.
   */
  | { kind: "account"; sessionId: string; backend: string };

/** UI action type — reducer fan-in. */
export type TuiAction =
  | { type: "providers.set"; providers: ProviderInfo[] }
  | { type: "connection.change"; state: TuiState["connection"] }
  | { type: "error"; message: string }
  | { type: "sessions.set"; sessions: SessionInfo[] }
  | { type: "session.add"; session: SessionInfo }
  | { type: "session.remove"; sessionId: string }
  | { type: "session.status"; sessionId: string; status: SessionInfo["status"] }
  | { type: "session.info"; session: SessionInfo }
  | { type: "session.message"; sessionId: string; message: SessionMessage }
  | {
      type: "session.delta";
      sessionId: string;
      messageId: string;
      contentAppend?: string;
      toolStateUpdate?: ToolState;
    }
  | { type: "session.scrollback"; sessionId: string; messages: SessionMessage[] }
  | { type: "focus"; sessionId: string | null }
  | { type: "input.set"; value: string; cursor?: number }
  | { type: "input.append"; value: string }
  | { type: "input.clear" }
  | { type: "cursor.set"; position: number }
  | { type: "history.push"; entry: string }
  | { type: "history.cycle"; direction: "prev" | "next" }
  | { type: "modal.open"; modal: ModalState }
  | { type: "modal.close" }
  | { type: "approval.clear"; sessionId: string };
