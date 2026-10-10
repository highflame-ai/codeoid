/**
 * Turns (#354): every prompt, and everything the agent does in reply, belongs
 * to one turn with a stable `turnId` (carried on each `SessionMessage`). At the
 * start of each turn the daemon also snapshots the working directory (in its
 * own storage, git repo or not), so later features can put the files back where they were at that turn
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
  /**
   * The workspace snapshot taken when the turn started, when one exists.
   * `late`: the snapshot was still being taken when the agent started, so it
   * may already include the agent's first edits.
   */
  checkpoint?: { sha: string; late?: boolean };
}

export interface SessionTurnsResultMsg {
  type: "session.turns.result";
  requestId: string;
  sessionId: string;
  turns: TurnSummary[];
  /**
   * Whether this session takes workspace snapshots (`session.checkpoints`
   * enabled; works in any directory, git or not). False → turns still have
   * ids, but no files to go back to.
   */
  checkpointsSupported: boolean;
}

// ── Going back a turn (#355) ──────────────────────────────────────────────────

/**
 * Take back turn `turnId` and every turn after it. The agent no longer
 * remembers them — on every backend, after a restart too. With
 * `restoreFiles`, the working directory also goes back to how it was when
 * that turn started (its snapshot). `dryRun` reports what would happen and
 * changes nothing; a real restore that would overwrite files changed by
 * hand since the agent's last turn is refused unless `force`.
 *
 * A running turn is stopped first. Scope: `session:send`.
 */
export interface SessionRewindMsg {
  type: "session.rewind";
  id: string;
  sessionId: string;
  turnId: string;
  restoreFiles?: boolean;
  dryRun?: boolean;
  force?: boolean;
  /**
   * The `planId` of the dry run being confirmed: the real run refuses (and
   * changes nothing) if anything changed since that preview.
   */
  planId?: string;
}

/** Something a taken-back turn did that going back can't undo. */
export interface RewindIrreversible {
  /** The tool, as the backend named it (e.g. "Bash", "mcp__github__create_pr"). */
  tool: string;
  /** What it did (a shell command, an MCP call), shortened. */
  detail: string;
}

export interface RewindFiles {
  /** Files that get their snapshot content back (changed or deleted since). */
  restore: string[];
  /** Files created since the snapshot, which get deleted. */
  remove: string[];
  /**
   * Of those, files changed by hand since the agent's last turn ended —
   * overwriting them loses work the agent didn't do.
   */
  conflicts: string[];
  /** The snapshot was still being taken when that turn's agent started. */
  late?: boolean;
  /**
   * The agent's edits couldn't be told apart from hand edits (a snapshot is
   * missing), so every file that would change is counted as a conflict.
   */
  unverified?: boolean;
  /** True once the files were actually put back (never on a dry run). */
  applied: boolean;
}

export interface SessionRewindResultMsg {
  type: "session.rewind.result";
  requestId: string;
  sessionId: string;
  turnId: string;
  dryRun: boolean;
  /** Identifies exactly this plan; send it back with the real run. */
  planId: string;
  /** How many turns were (or would be) taken back. */
  removedTurns: number;
  /** The prompt of the turn taken back — to edit and send again. */
  restoredPrompt: string;
  /** Present when `restoreFiles` was asked for. */
  files?: RewindFiles;
  /**
   * When files were asked for but can't be restored (no snapshot for that
   * turn, checkpoints disabled): why. The conversation still goes back.
   */
  filesUnavailable?: string;
  /** Effects of the taken-back turns that going back can't undo. */
  irreversible: RewindIrreversible[];
  /**
   * Set when nothing changed because going back would overwrite files
   * changed by hand since the agent's last turn (see `files.conflicts`).
   * Send again with `force` to go ahead.
   */
  refused?: string;
}
