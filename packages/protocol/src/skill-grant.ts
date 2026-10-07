/**
 * Pre-approving a command an installed skill declares (`!`cmd`` in its
 * SKILL.md), the way `claude -p --allowedTools` does (#348).
 *
 * In an attended session a blocked skill command raises an approval dialog and
 * the answer is remembered. An unattended run (a pipeline phase) never
 * prompts, so a command it needs must be allowed beforehand — this message.
 * The grant is per workspace (the workdir, within the caller's tenant), the
 * same record the dialog writes.
 *
 * Needs `settings:write`: it lets code run, unasked, in every later session
 * on that workdir.
 */

// ── Messages (client → daemon) ────────────────────────────────────────────────

export interface SkillGrantMsg {
  type: "skill.grant";
  id: string;
  /** The workspace the grant applies to — a session's workdir. */
  workdir: string;
  /** The command exactly as the skill declares it (inside `!`…``). */
  command: string;
  /** true = allow; false = deny (the dialog's "no", remembered). */
  allowed: boolean;
}

// ── Messages (daemon → client) ────────────────────────────────────────────────

export interface SkillGrantResultMsg {
  type: "skill.grant.result";
  requestId: string;
  /** The canonical workdir the grant was recorded for. */
  workdir: string;
  command: string;
  allowed: boolean;
}
