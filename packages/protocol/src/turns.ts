/**
 * Turns (#354): every prompt, and everything the agent does in reply, belongs
 * to one turn with a stable `turnId` (carried on each `SessionMessage`). At the
 * start of each turn in a git workdir, the daemon also snapshots the working
 * tree, so later features can put the files back where they were at that turn
 * (go back a turn, fork from here, per-turn diffs). Backend-agnostic: the turn
 * list and the snapshots come from codeoid's own records, never from a
 * backend's native session.
 */

// ── Messages (client → daemon) ────────────────────────────────────────────────

/** List a session's turns, oldest first. Scope: `session:watch`. */
export interface SessionTurnsMsg {
  type: "session.turns";
  id: string;
  sessionId: string;
}

// ── Messages (daemon → client) ────────────────────────────────────────────────

export interface TurnSummary {
  turnId: string;
  /** 1-based position among the session's turns. */
  index: number;
  /**
   * `prompt` — a message someone sent. `background` — the agent continued on
   * its own after background work finished (no prompt).
   */
  kind: "prompt" | "background";
  /** The prompt's first line, trimmed to a short preview. */
  preview: string;
  /** When the turn started (ISO), when known. */
  startedAt?: string;
  /** The workspace snapshot taken when the turn started, when one exists. */
  checkpoint?: { sha: string };
}

export interface SessionTurnsResultMsg {
  type: "session.turns.result";
  requestId: string;
  sessionId: string;
  turns: TurnSummary[];
  /**
   * Whether this session's workdir can be snapshotted (a git work tree with
   * checkpoints enabled). False → turns still have ids, but no files to go
   * back to.
   */
  checkpointsSupported: boolean;
}
