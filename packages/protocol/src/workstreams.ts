/**
 * Workstreams (docs/workstreams-design.md): named lines of work that decide
 * which servers, credentials, accounts and models a session gets.
 *
 * A session has exactly one home workstream, chosen at create (explicitly, or
 * by its folder) and kept: resume re-checks it against the config, never
 * re-matches the folder.
 */

/** How a session got its home. */
export type WorkstreamSource =
  /** Chosen at create (`session.create.workstream`). */
  | "explicit"
  /** Its folder matched a rule. */
  | "matched"
  /** Nothing matched; the configured default. */
  | "default"
  /** Chosen past another workstream's exclusive claim on the folder, confirmed (§5.2). */
  | "override"
  /** A session from before workstreams, resolved once by its folder on resume. */
  | "migrated"
  /** A home the daemon assigns itself (the conductor's). */
  | "reserved"
  /** Workstreams are configured, but nothing matched and there's no default. */
  | "none";

/** Where a session's home came from, as `SessionInfo` carries it. */
export interface SessionWorkstreamInfo {
  /** The home workstream's id. Absent = no home (`source: "none"`). */
  id?: string;
  /** Display name and color, as configured, when the workstream still exists. */
  name?: string;
  color?: string;
  source: WorkstreamSource;
  /** The rule that matched, for display. */
  matchedBy?: string;
  /** The home was deleted from the config: the session needs a new one. */
  orphaned?: boolean;
}

export interface WorkstreamServerInfo {
  server: string;
  credential?: string;
  /** The workstream that contributed it: itself, or a base it extends. */
  from: string;
}

/** A workstream as configured, bases merged in. Secret values never appear: env lists names only. */
export interface WorkstreamSummary {
  id: string;
  name: string;
  color?: string;
  abstract: boolean;
  extends: string[];
  claim: "exclusive" | "suggest";
  allowOverride: boolean;
  share: "open" | "ask" | "closed";
  match: { paths: string[]; remotes: string[] };
  servers: WorkstreamServerInfo[];
  accounts: Record<string, string>;
  defaults: { provider?: string; model?: string; effort?: string };
  /** Env var names it sets (values are credential references, resolved by the daemon). */
  env: string[];
  git?: { name?: string; email?: string };
  skillDirs: string[];
}

export interface WorkstreamMatchInfo {
  workstream: string;
  rule: string;
  kind: "path" | "remote";
  via?: "origin" | "upstream";
  claim: "exclusive" | "suggest";
}

/** What a folder (and an optional explicit choice) resolves to. */
export interface WorkstreamResolution {
  /** The home it would get. Absent = none. */
  home?: string;
  source: WorkstreamSource;
  matchedBy?: string;
  /** Every workstream whose rules match the folder, best first. */
  candidates: WorkstreamMatchInfo[];
  /** Workstreams tied for best: no home is picked until one is chosen. */
  ambiguous?: string[];
  /**
   * The explicit choice differs from the workstream holding an exclusive
   * claim on the folder (§5.2). `overridable: false` = that workstream set
   * `allowOverride: false`.
   */
  conflict?: {
    folder: string;
    chosen: string;
    overridable: boolean;
    /** What an override would change: servers and env the chosen home gives, and the folder's withheld. */
    changes?: { gains: string[]; withholds: string[]; env: string[]; git?: string };
    /**
     * On a `session.create` refused for this conflict, when overridable: the
     * token a confirming retry sends as `override.token` (G3). Single use,
     * minutes long, bound to the caller, the folder, the choice and the
     * config revision — a changed config makes it stale.
     */
    overrideToken?: string;
  };
}

// ── Messages (client → daemon) ────────────────────────────────────────────────

/** The configured workstreams. Needs `settings:read`. */
export interface WorkstreamListMsg {
  type: "workstream.list";
  id: string;
}

/** What a folder would resolve to, for the new-session picker. Needs `session:create`. */
export interface WorkstreamResolveMsg {
  type: "workstream.resolve";
  id: string;
  workdir: string;
  /** An explicit choice to check against the folder. */
  workstream?: string;
}

// ── Messages (daemon → client) ────────────────────────────────────────────────

export interface WorkstreamListResultMsg {
  type: "workstream.list.result";
  requestId: string;
  /** Changes with every change to the `workstreams` block. */
  revision: string;
  isolateGlobalServers: boolean;
  default?: string;
  workstreams: WorkstreamSummary[];
}

export interface WorkstreamResolveResultMsg {
  type: "workstream.resolve.result";
  requestId: string;
  /** The folder as the daemon read it (`~` expanded). */
  workdir: string;
  revision: string;
  resolution: WorkstreamResolution;
}
