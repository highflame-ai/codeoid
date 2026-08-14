/**
 * Codeoid permission scopes — mapped to ZeroID OAuth2 scopes.
 *
 * Scopes follow a resource:action pattern and are enforced at the daemon
 * on every inbound message, not just at connection time.
 */

export const SCOPES = {
  /** Create new agent sessions */
  SESSION_CREATE: "session:create",
  /** Attach to a session and receive streaming output */
  SESSION_ATTACH: "session:attach",
  /** Watch session output without ability to send messages */
  SESSION_WATCH: "session:watch",
  /** Send messages / prompts to an attached session */
  SESSION_SEND: "session:send",
  /** Interrupt a running agent mid-execution */
  SESSION_INTERRUPT: "session:interrupt",
  /** Approve or deny permission prompts from the agent */
  SESSION_APPROVE: "session:approve",
  /** Destroy a session and its agent process */
  SESSION_DESTROY: "session:destroy",
  /** List sessions and their status */
  SESSION_LIST: "session:list",
  /**
   * Read-class fleet visibility for the conductor — list, find, and
   * summarize sessions across the fleet without the ability to act in them.
   */
  SESSION_READ: "session:read",
  /**
   * Send-class fleet routing for the conductor — direct an existing session,
   * interrupt it, or spawn a disposable worker on the owner's behalf.
   */
  SESSION_DISPATCH: "session:dispatch",
  /**
   * Subscribe a CLIENT to the fleet board — the conductor's dispatch tasks,
   * lifecycle events, and aggregate usage (`fleet.subscribe`).
   *
   * Distinct from `session:read`/`session:dispatch`, which are ZeroID scopes
   * delegated to the conductor's own AGENT identity to gate its `fleet_*` MCP
   * tools. This one gates a human's client reading the board over the wire.
   * Separate from `session:list` because the board exposes orchestration
   * internals — what was dispatched, what failed, what it cost — beyond the
   * session enumeration a watcher already gets.
   */
  FLEET_READ: "fleet:read",
  /** Read files and list directories under a session's workdir */
  FS_READ: "fs:read",
  /** Read the settings manifest + current (non-secret) daemon configuration */
  SETTINGS_READ: "settings:read",
  /** Write daemon configuration (config.json + .env), including secrets */
  SETTINGS_WRITE: "settings:write",
  /** Create + drive SDLC pipelines */
  PIPELINE_CREATE: "pipeline:create",
  /** List + read SDLC pipelines */
  PIPELINE_READ: "pipeline:read",
  /** Answer a halted pipeline phase (a human decision) */
  PIPELINE_ANSWER: "pipeline:answer",
  /**
   * Manage SDLC packs + registries — add a registry, install / remove / trust /
   * select a pack. Owner-tier (kept out of OPERATOR_SCOPES): these verbs rewrite
   * config.json and toggle host command-gate execution, the same trust class as
   * settings:write.
   */
  PIPELINE_MANAGE: "pipeline:manage",
} as const;

export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

/** All scopes — convenience for admin/owner tokens */
export const ALL_SCOPES: readonly Scope[] = Object.values(SCOPES);

/** Read-only watcher — can list and watch output, nothing else */
export const WATCHER_SCOPES: readonly Scope[] = [
  SCOPES.SESSION_LIST,
  SCOPES.SESSION_WATCH,
  SCOPES.FS_READ,
];

/**
 * Operator — full control except destroy. Gets settings READ (a settings
 * page is expected to render for an operator) but NOT settings WRITE — the
 * config is owner-only, since a write can rewrite secrets and provider wiring.
 */
export const OPERATOR_SCOPES: readonly Scope[] = [
  SCOPES.SESSION_LIST,
  SCOPES.SESSION_CREATE,
  SCOPES.SESSION_ATTACH,
  SCOPES.SESSION_WATCH,
  SCOPES.SESSION_SEND,
  SCOPES.SESSION_INTERRUPT,
  SCOPES.SESSION_APPROVE,
  // An operator drives the fleet, so the conductor board is part of their job.
  // Deliberately NOT in WATCHER_SCOPES: a read-only watcher can already see
  // sessions, but the board is orchestration state, not session output.
  SCOPES.FLEET_READ,
  SCOPES.FS_READ,
  SCOPES.SETTINGS_READ,
  SCOPES.PIPELINE_CREATE,
  SCOPES.PIPELINE_READ,
  SCOPES.PIPELINE_ANSWER,
];

/** All scopes as a space-delimited string (for OAuth scope parameter) */
export const ALL_SCOPES_STRING: string = ALL_SCOPES.join(" ");

/** Check if a set of granted scopes includes the required scope */
export function hasScope(granted: readonly string[], required: Scope): boolean {
  return granted.includes(required);
}

/** Check if granted scopes include ALL required scopes */
export function hasAllScopes(
  granted: readonly string[],
  required: readonly Scope[],
): boolean {
  return required.every((s) => granted.includes(s));
}
