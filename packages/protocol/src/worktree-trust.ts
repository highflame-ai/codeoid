/**
 * Trusting a repository's worktree setup recipe (`.codeoid/setup.yaml`,
 * src/daemon/workspace-setup.ts) — direnv-allow style.
 *
 * A recipe's `command` runs in every worktree codeoid creates for that
 * repository, as the daemon's user, so it runs only while the recipe's git
 * blob is the one the owner trusted. Trusting is two steps: `dryRun` shows
 * the command at the primary checkout's committed HEAD and its blob id; a
 * second request with that `recipeHash` records it — refused if the recipe
 * changed in between, so what was reviewed is what is trusted.
 *
 * Needs `settings:write` from an undelegated token.
 */

// ── Messages (client → daemon) ────────────────────────────────────────────────

export interface WorktreeTrustMsg {
  type: "worktree.trust";
  id: string;
  /** Any directory of the repository; its primary checkout is what's trusted. */
  dir: string;
  /** Only report the recipe and its trust; change nothing. */
  dryRun?: boolean;
  /** Withdraw trust for the repository (every recorded recipe). */
  off?: boolean;
  /** The blob id `dryRun` reported — required to record trust. */
  recipeHash?: string;
}

// ── Messages (daemon → client) ────────────────────────────────────────────────

export interface WorktreeTrustResultMsg {
  type: "worktree.trust.result";
  requestId: string;
  /** The primary checkout. */
  path: string;
  /** The recipe at its committed HEAD, when there is one. */
  recipeHash?: string;
  command?: string;
  /** The current recipe's command may run (also needs runCommands = trusted-repos). */
  trusted: boolean;
  /** This request changed the recorded trust. */
  changed: boolean;
  runCommands: "never" | "trusted-repos";
}
