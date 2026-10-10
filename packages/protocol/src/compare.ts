/**
 * Side-by-side comparisons (#357): send one prompt to 2–4 forks of a
 * session — each on its own backend/model, each in its own worktree,
 * starting from the same conversation and the same files — then compare
 * what each did and keep the best. Built entirely from forks and sends, so
 * it works with every backend.
 */

import type { SessionStatus } from "./types.js";

// ── Messages (client → daemon) ────────────────────────────────────────────────

export interface CompareTargetSpec {
  /** Backend for this branch (e.g. "claude", "codex"). */
  providerId: string;
  /** Model on that backend; absent = its default. */
  model?: string;
}

/**
 * Start a comparison. Scopes: `session:create` (it forks) and `session:send`.
 * Responds with `compare.state`.
 */
export interface SessionCompareMsg {
  type: "session.compare";
  id: string;
  sessionId: string;
  prompt: string;
  /** 2–4 targets. The same backend may appear twice with different models. */
  targets: CompareTargetSpec[];
  /**
   * Compare from an earlier point (see `session.fork` `afterTurnId`). Each
   * branch always gets its own git worktree: agents sharing one folder would
   * edit each other's files, so a comparison needs a git repository.
   */
  afterTurnId?: string;
}

/** A comparison's current state. Scope: `session:attach` or `session:watch`. */
export interface CompareGetMsg {
  type: "compare.get";
  id: string;
  compareId: string;
}

/** A session's comparisons, newest first. Scope: `session:attach` or `session:watch`. */
export interface CompareListMsg {
  type: "compare.list";
  id: string;
  sessionId: string;
}

/**
 * Keep one branch as the continuation. With `discardOthers`, the other
 * branches are destroyed (needs `session:destroy`); otherwise they stay as
 * ordinary forks. Scope: `session:send`. Responds with `compare.state`.
 */
export interface CompareKeepMsg {
  type: "compare.keep";
  id: string;
  compareId: string;
  sessionId: string;
  discardOthers?: boolean;
}

// ── Messages (daemon → client) ────────────────────────────────────────────────

export interface CompareTargetState {
  providerId: string;
  model?: string;
  /** The branch session (absent when it couldn't be created — see `error`). */
  sessionId?: string;
  /**
   * Session status, or "gone" once the branch session was destroyed.
   * `waiting_approval` means it needs someone to open it and decide.
   */
  status: SessionStatus | "gone" | "failed";
  /**
   * The compared turn has settled and its result (reply, files, cost, time)
   * is final — taken from that turn alone, so carrying on in the branch
   * doesn't change it.
   */
  done: boolean;
  /** Why the branch failed to start, or its turn's error. */
  error?: string;
  /** The branch's reply to the prompt (that turn's only; shortened). Set once done. */
  reply?: string;
  costUsd?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  /**
   * What the branch's turn changed in its files (start → end snapshot of
   * that turn), once it has finished.
   */
  files?: { changed: number; insertions: number; deletions: number; paths: string[] };
}

export interface CompareState {
  compareId: string;
  parentSessionId: string;
  prompt: string;
  afterTurnId?: string;
  createdAt: string;
  createdBy: string;
  keptSessionId?: string;
  targets: CompareTargetState[];
}

export interface CompareStateMsg {
  type: "compare.state";
  requestId: string;
  compare: CompareState;
}

export interface CompareListResultMsg {
  type: "compare.list.result";
  requestId: string;
  sessionId: string;
  compares: CompareState[];
}
