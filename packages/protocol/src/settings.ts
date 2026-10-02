/**
 * Settings manifest + snapshot — the daemon's declarative description of every
 * user-configurable knob, plus the current effective values.
 *
 * Every frontend (web, TUI, mobile) renders the SAME manifest fetched at
 * runtime via `settings.schema`, so adding a knob is a single manifest entry
 * in the daemon, not an edit in each client. Clients stay pure renderers.
 *
 * Two backing stores, both hand-editable by the user directly:
 *   - `config` fields → `~/.codeoid/config.json` (zod-validated on write)
 *   - `env`    fields → `~/.codeoid/.env` (KEY=value; secrets + env-only knobs)
 *
 * Secret values are NEVER sent to a client — only whether one is set and from
 * where (`SecretStatus`).
 */

/** How a field's value is typed + rendered. */
export type SettingKind =
  | "string"
  | "boolean"
  | "int"
  | "float"
  | "enum"
  | "string[]"
  | "secret";

/** Which file backs a field. */
export type SettingBacking = "config" | "env";

/** When a saved change takes effect — an honest signal for the UI banner. */
export type SettingApplies = "live" | "next-session" | "restart";

/** One selectable value for an `enum` field. */
export interface SettingOption {
  value: string;
  label: string;
  description?: string;
}

/** A single configurable knob. */
export interface SettingField {
  /** Stable id, unique across the manifest (e.g. "session.defaultModel"). */
  key: string;
  label: string;
  /** One or two sentences shown beneath the control. */
  help: string;
  kind: SettingKind;
  backing: SettingBacking;
  /** Dotted path into config.json — present iff `backing === "config"`. */
  path?: string;
  /**
   * Env var name — present iff `backing === "env"`, and also carried on
   * config-backed fields as the override-hint the UI can surface.
   */
  envVar?: string;
  /** Default shown as placeholder / reset target (display only; zod is authoritative). */
  default?: string | number | boolean | string[];
  /** Allowed values for `kind === "enum"`. */
  options?: SettingOption[];
  /** Numeric bounds — display + optional client-side pre-validation only. */
  min?: number;
  max?: number;
  placeholder?: string;
  /** Hide behind an "advanced" reveal in the UI. */
  advanced?: boolean;
  /** Secret values are never echoed to clients. Implied by `kind === "secret"`. */
  secret?: boolean;
  applies: SettingApplies;
}

export interface SettingsGroup {
  id: string;
  title: string;
  description?: string;
  fields: SettingField[];
}

export interface SettingsTab {
  id: string;
  title: string;
  /** Optional single emoji / short glyph for the tab rail. */
  icon?: string;
  description?: string;
  groups: SettingsGroup[];
}

export interface SettingsManifest {
  /** Bumped when the manifest shape changes; clients may cache by it. */
  version: number;
  tabs: SettingsTab[];
}

/** JSON-serializable value of a non-secret field. */
export type SettingValue = string | number | boolean | string[] | null;

/** Where a field's current effective value came from. */
export type SettingSource = "default" | "config" | "env" | "unset";

/** Non-secret current value + provenance for one field key. */
export interface SettingState {
  value: SettingValue;
  source: SettingSource;
}

/**
 * A secret field's status — never its value. `external` means it is set in the
 * real process environment (not the `.env` file), so a `.env` write would NOT
 * override it (real env always wins over the file).
 */
export interface SecretStatus {
  set: boolean;
  source: "env-file" | "external" | "unset";
}

/** Daemon-observed health of a registry MCP server. Derived from accumulated
 *  use (no live probe on read): `idle` = configured but not yet exercised. */
export type McpServerHealth = "connected" | "error" | "idle" | "disabled";

/** Read-only status of one registry MCP server (the cross-backend mounter's
 *  view), surfaced in the settings drawer. Config comes from the registry; the
 *  health/tools reflect what the daemon-owned client has seen so far. */
export interface McpServerStatus {
  name: string;
  transport: "stdio" | "http" | "in-process";
  trust: "readonly" | "prompt";
  scope: "global" | "workspace" | "session";
  /** Backends this server mounts on; `null` = all. */
  backends: string[] | null;
  enabled: boolean;
  /** `codeoid_memory` — always present, not user-declared. */
  builtin: boolean;
  health: McpServerHealth;
  /** Tools last observed from the server (0 until first used). */
  toolCount: number;
  /** Bare tool names last observed. */
  tools: string[];
  /** Last error text when `health === "error"`. */
  error?: string;
  /** Present for an OAuth server: whether the viewer's tenant has signed in,
   *  and whether the server can be used from every backend yet. */
  oauth?: {
    status: "connected" | "disconnected";
    /** Backends that mount natively and cannot reach an OAuth server yet. */
    unsupportedBackends: string[];
  };
}

/** The current effective settings — the `settings.get` payload. */
export interface SettingsSnapshot {
  /** key → { value, source } for every non-secret field. */
  values: Record<string, SettingState>;
  /** key → status for every secret field (never the value). */
  secrets: Record<string, SecretStatus>;
  /** Resolved absolute path of config.json (for the "edit directly" hint). */
  configPath: string;
  /** Resolved absolute path of the .env file. */
  envPath: string;
  /** Read-only registry MCP servers + live health (daemon-populated; absent
   *  when the daemon has no registry, e.g. hand-built test snapshots). */
  mcpServers?: McpServerStatus[];
}

/** One change requested by `settings.set`, addressed by field `key`. */
export interface SettingPatch {
  key: string;
  /** New value. For a secret, the plaintext to write; `""`/`null` clears it. */
  value: SettingValue;
}

/** A per-patch failure returned by `settings.set` (on which nothing is written). */
export interface SettingError {
  key: string;
  message: string;
}

// ── Messages (client → daemon) ────────────────────────────────────────────────

/** Fetch the settings manifest (static per daemon lifetime). Read-only. */
export interface SettingsSchemaMsg {
  type: "settings.schema";
  id: string;
}

/** Fetch the current effective values + secret presence. Read-only. */
export interface SettingsGetMsg {
  type: "settings.get";
  id: string;
}

/**
 * Apply a batch of field changes. Config patches are validated as a whole
 * against the config schema and written atomically — a single invalid patch
 * rejects the WHOLE batch (nothing is written). Env/secret patches update the
 * `.env` file. Addressed by field `key`, not raw path, so the daemon controls
 * the mapping to config path / env var.
 */
export interface SettingsSetMsg {
  type: "settings.set";
  id: string;
  patches: SettingPatch[];
}

// ── Messages (daemon → client) ────────────────────────────────────────────────

export interface SettingsSchemaResultMsg {
  type: "settings.schema.result";
  requestId: string;
  manifest: SettingsManifest;
}

export interface SettingsGetResultMsg {
  type: "settings.get.result";
  requestId: string;
  snapshot: SettingsSnapshot;
}

export interface SettingsSetResultMsg {
  type: "settings.set.result";
  requestId: string;
  /** True iff every patch validated and was written. On false nothing changed. */
  ok: boolean;
  /** Effective settings AFTER the write (unchanged when `ok === false`). */
  snapshot: SettingsSnapshot;
  /** Per-patch validation errors (empty when `ok`). */
  errors: SettingError[];
  /** True when at least one written field needs a daemon restart to take effect. */
  restartRequired: boolean;
}
