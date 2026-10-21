/**
 * TUI state store — plain React context + reducer. No external state lib.
 *
 * The reducer takes the flat daemon-event stream and updates per-session
 * message lists, streaming buffers, and unread counts. The focus logic makes
 * sure incoming messages for non-focused sessions bump the unread badge so
 * users can tell which session needs attention.
 */

import React, {
  createContext,
  useContext,
  useReducer,
  type ReactNode,
  type Dispatch,
} from "react";
import type {
  SessionMessage,
  ToolState,
  ToolWaitingConfirmationState,
} from "../protocol/types.js";
import type { TuiAction, TuiSession, TuiState } from "./types.js";

/**
 * True if the arriving message is starting a stream (empty body, role that
 * the daemon will fill via deltas). These go into `live` until their
 * re-broadcast finalizes them.
 */
function isStreamStart(msg: SessionMessage): boolean {
  return (
    (msg.role === "assistant" || msg.role === "thinking") &&
    msg.content === ""
  );
}

/**
 * True if the message is a tool_call that's still in-flight. Tool calls
 * start life in `live` and migrate to `committed` on completion/cancellation.
 */
function isActiveToolCall(msg: SessionMessage): boolean {
  if (msg.role !== "tool_call" || !msg.tool) return false;
  const phase = msg.tool.state.phase;
  return phase === "executing" || phase === "waiting_confirmation" || phase === "streaming";
}

const initialState: TuiState = {
  providers: [],
  sessions: new Map(),
  order: [],
  focused: null,
  connection: "connecting",
  lastError: null,
  input: "",
  cursor: 0,
  history: [],
  historyIdx: null,
  draft: null,
  modal: null,
};

function blankSession(info: TuiSession["info"]): TuiSession {
  return {
    info,
    committed: [],
    live: [],
    streaming: null,
    unread: 0,
    pendingApproval: null,
  };
}

function reducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case "providers.set":
      return { ...state, providers: action.providers };
    case "connection.change":
      return { ...state, connection: action.state };

    case "error":
      return { ...state, lastError: action.message };

    case "sessions.set": {
      const sessions = new Map<string, TuiSession>();
      const order: string[] = [];
      for (const info of action.sessions) {
        const existing = state.sessions.get(info.id);
        sessions.set(info.id, existing ? { ...existing, info } : blankSession(info));
        order.push(info.id);
      }
      const focused =
        state.focused && sessions.has(state.focused) ? state.focused : order[0] ?? null;
      return { ...state, sessions, order, focused };
    }

    case "session.add": {
      const sessions = new Map(state.sessions);
      const order = state.order.includes(action.session.id)
        ? state.order
        : [...state.order, action.session.id];
      sessions.set(action.session.id, blankSession(action.session));
      return {
        ...state,
        sessions,
        order,
        focused: state.focused ?? action.session.id,
      };
    }

    case "session.remove": {
      const sessions = new Map(state.sessions);
      sessions.delete(action.sessionId);
      const order = state.order.filter((id) => id !== action.sessionId);
      const focused =
        state.focused === action.sessionId ? (order[0] ?? null) : state.focused;
      return { ...state, sessions, order, focused };
    }

    case "session.status": {
      const s = state.sessions.get(action.sessionId);
      if (!s) return state;
      const sessions = new Map(state.sessions);
      // Safety net: when a session goes idle, any message still sitting in
      // the live region without having been committed is stale — the
      // turn ended, no more deltas are coming. Clear live so we don't
      // accumulate orphan `thinking…` spinners across turns. The daemon
      // also finalizes these on its side; this is belt-and-suspenders for
      // cases where the daemon's final broadcast dropped or lagged.
      const shouldClearLive =
        action.status === "idle" || action.status === "error";
      sessions.set(action.sessionId, {
        ...s,
        info: { ...s.info, status: action.status },
        pendingApproval:
          action.status === "waiting_approval" ? s.pendingApproval : null,
        live: shouldClearLive ? [] : s.live,
        streaming: shouldClearLive ? null : s.streaming,
      });
      return { ...state, sessions };
    }

    case "session.info": {
      const existing = state.sessions.get(action.session.id);
      if (!existing) return state;
      const sessions = new Map(state.sessions);
      sessions.set(action.session.id, { ...existing, info: action.session });
      return { ...state, sessions };
    }

    case "session.message":
      return applyMessage(state, action.sessionId, action.message);

    case "session.delta":
      return applyDelta(
        state,
        action.sessionId,
        action.messageId,
        action.contentAppend,
        action.toolStateUpdate,
      );

    case "session.scrollback": {
      const s = state.sessions.get(action.sessionId);
      if (!s) return state;
      const sessions = new Map(state.sessions);
      // Scrollback replay is authoritative. All replayed messages are
      // committed (already finalized on the daemon side).
      sessions.set(action.sessionId, {
        ...s,
        committed: action.messages,
        live: [],
        streaming: null,
      });
      return { ...state, sessions };
    }

    case "focus": {
      if (action.sessionId === state.focused) return state;
      // Clear unread on newly-focused session.
      let sessions = state.sessions;
      if (action.sessionId) {
        const s = state.sessions.get(action.sessionId);
        if (s && s.unread > 0) {
          sessions = new Map(state.sessions);
          sessions.set(action.sessionId, { ...s, unread: 0 });
        }
      }
      return { ...state, sessions, focused: action.sessionId, input: "" };
    }

    case "input.set":
      return {
        ...state,
        input: action.value,
        cursor: action.cursor ?? Math.min(state.cursor, action.value.length),
        historyIdx: null,
        draft: null,
      };
    case "input.append":
      return {
        ...state,
        input: state.input + action.value,
        cursor: state.cursor + action.value.length,
      };
    case "input.clear":
      return {
        ...state,
        input: "",
        cursor: 0,
        historyIdx: null,
        draft: null,
      };
    case "cursor.set":
      return {
        ...state,
        cursor: Math.max(0, Math.min(state.input.length, action.position)),
      };
    case "history.push": {
      if (!action.entry.trim()) return state;
      // De-dupe adjacent repeats.
      if (state.history[0] === action.entry) return state;
      const history = [action.entry, ...state.history].slice(0, 200);
      return { ...state, history };
    }
    case "history.cycle": {
      if (state.history.length === 0) return state;
      const dir = action.direction;
      let newIdx: number | null;
      let newDraft = state.draft;
      if (state.historyIdx === null) {
        // Entering history from a fresh edit — stash the draft.
        if (dir === "next") return state; // Nothing newer than the draft.
        newIdx = 0;
        newDraft = state.input;
      } else {
        const candidate = state.historyIdx + (dir === "prev" ? 1 : -1);
        if (candidate < 0) {
          // Back to draft.
          newIdx = null;
        } else if (candidate >= state.history.length) {
          // Can't go older.
          return state;
        } else {
          newIdx = candidate;
        }
      }
      const newValue = newIdx === null ? (newDraft ?? "") : state.history[newIdx]!;
      return {
        ...state,
        historyIdx: newIdx,
        draft: newIdx === null ? null : newDraft,
        input: newValue,
        cursor: newValue.length,
      };
    }

    case "modal.open":
      return { ...state, modal: action.modal };
    case "modal.close":
      return { ...state, modal: null };

    case "approval.clear": {
      const s = state.sessions.get(action.sessionId);
      if (!s) return state;
      const sessions = new Map(state.sessions);
      sessions.set(action.sessionId, { ...s, pendingApproval: null });
      return { ...state, sessions };
    }
  }
}

function applyMessage(
  state: TuiState,
  sessionId: string,
  msg: SessionMessage,
): TuiState {
  const s = state.sessions.get(sessionId);
  if (!s) return state;
  const sessions = new Map(state.sessions);

  let committed = s.committed;
  let live = s.live;

  // Is this a rebroadcast of something already in `live`? If so, it's the
  // daemon telling us the stream finalized — move it from live to committed.
  const liveIdx = live.findIndex((m) => m.messageId === msg.messageId);

  if (isStreamStart(msg) || isActiveToolCall(msg)) {
    // In-flight message. Add or update in `live`.
    if (liveIdx >= 0) {
      live = [...live];
      live[liveIdx] = msg;
    } else {
      live = [...live, msg];
    }
  } else {
    // Finalized message. Move from live → committed (if it was streaming)
    // or append to committed directly.
    if (liveIdx >= 0) {
      live = [...live.slice(0, liveIdx), ...live.slice(liveIdx + 1)];
    }
    const commIdx = committed.findIndex((m) => m.messageId === msg.messageId);
    if (commIdx >= 0) {
      // Edge case: same messageId rebroadcast after already committed.
      // Keep the more recent copy.
      committed = [...committed];
      committed[commIdx] = msg;
    } else {
      committed = [...committed, msg];
    }
  }

  // Capture pending approval.
  let pendingApproval = s.pendingApproval;
  if (msg.role === "tool_call" && msg.tool?.state.phase === "waiting_confirmation") {
    const st = msg.tool.state as ToolWaitingConfirmationState;
    pendingApproval = {
      approvalId: st.approvalId,
      toolName: msg.tool.name,
      description: st.description,
    };
  }

  // Streaming buffer — cleared when the final message arrives.
  const streaming =
    s.streaming?.messageId === msg.messageId && !isStreamStart(msg) ? null : s.streaming;

  const unread = sessionId === state.focused ? 0 : s.unread + 1;

  sessions.set(sessionId, {
    ...s,
    committed,
    live,
    streaming,
    pendingApproval,
    unread,
  });
  return { ...state, sessions };
}

function applyDelta(
  state: TuiState,
  sessionId: string,
  messageId: string,
  contentAppend: string | undefined,
  toolStateUpdate: ToolState | undefined,
): TuiState {
  const s = state.sessions.get(sessionId);
  if (!s) return state;
  const sessions = new Map(state.sessions);

  let live = s.live;
  let committed = s.committed;
  let streaming = s.streaming;

  // Locate the target message in either list.
  const liveIdx = live.findIndex((m) => m.messageId === messageId);
  const commIdx =
    liveIdx >= 0 ? -1 : committed.findIndex((m) => m.messageId === messageId);

  // Content delta — only meaningful for live streams.
  if (contentAppend) {
    if (liveIdx >= 0) {
      const orig = live[liveIdx]!;
      live = [...live];
      live[liveIdx] = { ...orig, content: orig.content + contentAppend };
    }
    streaming =
      streaming && streaming.messageId === messageId
        ? { messageId, text: streaming.text + contentAppend }
        : { messageId, text: contentAppend };
  }

  // Tool state update — the big state transition. If the tool reached a
  // terminal phase (completed/cancelled), move from live → committed.
  if (toolStateUpdate) {
    const terminal =
      toolStateUpdate.phase === "completed" ||
      toolStateUpdate.phase === "cancelled";
    if (liveIdx >= 0) {
      const orig = live[liveIdx]!;
      const updated = {
        ...orig,
        tool: orig.tool ? { ...orig.tool, state: toolStateUpdate } : undefined,
      };
      if (terminal) {
        live = [...live.slice(0, liveIdx), ...live.slice(liveIdx + 1)];
        committed = [...committed, updated];
      } else {
        live = [...live];
        live[liveIdx] = updated;
      }
    } else if (commIdx >= 0) {
      // Already-committed tool getting another state update. Rare but
      // harmless — update in place; Static won't re-render but the data
      // model stays consistent.
      const orig = committed[commIdx]!;
      committed = [...committed];
      committed[commIdx] = {
        ...orig,
        tool: orig.tool ? { ...orig.tool, state: toolStateUpdate } : undefined,
      };
    }
  }

  sessions.set(sessionId, { ...s, committed, live, streaming });
  return { ...state, sessions };
}

// ── React context glue ──────────────────────────────────────────────────

interface StoreCtx {
  state: TuiState;
  dispatch: Dispatch<TuiAction>;
}

const StoreContext = createContext<StoreCtx | null>(null);

export function TuiStoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  return (
    <StoreContext.Provider value={{ state, dispatch }}>{children}</StoreContext.Provider>
  );
}

export function useTuiStore(): StoreCtx {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useTuiStore must be used inside TuiStoreProvider");
  return ctx;
}
