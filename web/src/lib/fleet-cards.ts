/**
 * Fleet tool calls → a typed card model.
 *
 * The conductor drives the fleet through `mcp__codeoid_fleet__*` tools, and
 * today they render like any other tool: a name and a `<details>` blob of raw
 * JSON. That is the correct default for an arbitrary tool and the wrong one
 * here, because these few verbs ARE the conductor's whole vocabulary — "which
 * session did it pick, what did it send, where did it spawn" is the thing you
 * are reading the transcript to find out (conductor-frontends-design §5).
 *
 * This module is the pure half: classification and field extraction, with no
 * Solid and no JSX, so the part worth testing needs no reactive root — the same
 * split `lib/fleet.ts` uses for grouping.
 *
 * Two rules shape everything below.
 *
 * **`input` is model-generated and typed `unknown`.** Every field is narrowed
 * rather than cast; a malformed or hallucinated input degrades to a card with
 * missing fields, never a crash and never a confident lie.
 *
 * **Unknown verbs fail safe.** The read/send split is a SECURITY-relevant
 * classification that the daemon enforces (`FLEET_SEND_TOOL_NAMES` in
 * `src/daemon/fleet.ts` — send-class verbs can never be auto-approved). This
 * module cannot import daemon code, so the vocabulary is duplicated below and
 * can drift. A verb this module does not recognise is therefore classified
 * `"unknown"` — never `"observe"` — so a future send-class verb added daemon-
 * side can never be rendered as a harmless read here.
 */

import type { ToolInfo } from "../protocol/types";

/** The daemon's in-process fleet MCP server key. */
const FLEET_TOOL_PREFIX = "mcp__codeoid_fleet__";

/**
 * Read-class verbs — observe only, auto-approved daemon-side.
 * Mirrors `FLEET_TOOL_NAMES`; see the fail-safe note in the module header.
 */
const READ_VERBS = [
  "fleet_list",
  "fleet_find",
  "fleet_summary",
  "fleet_recall",
  "fleet_tasks",
  "machine_map",
] as const;

/**
 * Send-class verbs — act on the fleet, and never auto-approved daemon-side.
 * Mirrors `FLEET_SEND_TOOL_NAMES`.
 */
const SEND_VERBS = [
  "fleet_send",
  "fleet_spawn",
  "fleet_interrupt",
  "fleet_panel",
] as const;

export type FleetVerb = (typeof READ_VERBS)[number] | (typeof SEND_VERBS)[number];

const READ_SET: ReadonlySet<string> = new Set(READ_VERBS);
const SEND_SET: ReadonlySet<string> = new Set(SEND_VERBS);

/**
 * What a fleet call is *for*, which is what decides how loud its card should be.
 *
 * `resolve` is split out of `observe` because it is the one read the owner must
 * actually check: a wrong resolution silently routes a later dispatch at the
 * wrong repo, which §6 of the design calls the failure that would kill trust in
 * the feature.
 */
export type FleetCardKind = "resolve" | "observe" | "dispatch" | "unknown";

export interface FleetCard {
  kind: FleetCardKind;
  /** Bare verb (`fleet_spawn`), with the MCP server prefix stripped. */
  verb: string;
  /**
   * True only for verbs known to be send-class. An unknown verb is NOT
   * reported as safe — see the module header.
   */
  sendClass: boolean;
  /** One-line summary for the card header. Never raw JSON. */
  summary: string;
  /** Ordered detail rows the card renders. Absent fields are omitted, not blanked. */
  fields: FleetCardField[];
}

export interface FleetCardField {
  label: string;
  value: string;
  /**
   * Long free text (a task brief, a message body) that a card should render in
   * a block rather than inline on one row.
   */
  block?: boolean;
}

/** Strip the MCP prefix, or return null when this is not a fleet tool at all. */
export function fleetVerb(toolName: string): string | null {
  return toolName.startsWith(FLEET_TOOL_PREFIX)
    ? toolName.slice(FLEET_TOOL_PREFIX.length)
    : null;
}

/**
 * Build the card model for a fleet tool call, or null when `tool` is an
 * ordinary tool that should keep its existing rendering.
 */
export function classifyFleetTool(tool: ToolInfo): FleetCard | null {
  const verb = fleetVerb(tool.name);
  if (verb === null) return null;

  const resolved = resolveToolInput(tool);
  const input = isRecord(resolved) ? resolved : {};
  const sendClass = SEND_SET.has(verb);
  const known = sendClass || READ_SET.has(verb);

  if (!known) {
    // Fail safe: name it, show nothing we cannot vouch for, and do not imply
    // a read/write posture we have no basis for.
    return {
      kind: "unknown",
      verb,
      sendClass: false,
      summary: `${verb} — unrecognised fleet verb`,
      fields: [],
    };
  }

  switch (verb) {
    case "fleet_find": {
      const query = str(input.query);
      return {
        kind: "resolve",
        verb,
        sendClass,
        summary: query ? `Resolving “${query}”` : "Resolving a session reference",
        fields: field("query", query),
      };
    }
    case "fleet_spawn": {
      const shape = shapeOf(input.shape);
      const workdir = str(input.workdir);
      return {
        kind: "dispatch",
        verb,
        sendClass,
        summary: `Spawn ${shape ?? "worker"}${workdir ? ` in ${basename(workdir)}` : ""}`,
        fields: [
          ...field("shape", shape),
          ...field("workdir", workdir),
          ...field("backend", joinBackend(str(input.provider), str(input.model))),
          ...field("task", str(input.task), true),
        ],
      };
    }
    case "fleet_send": {
      const target = sessionRef(input);
      return {
        kind: "dispatch",
        verb,
        sendClass,
        summary: target ? `Send to ${target}` : "Send to a session",
        fields: [
          ...field("target", target),
          ...field("shape", shapeOf(input.shape)),
          ...field("message", str(input.message), true),
        ],
      };
    }
    case "fleet_interrupt": {
      const target = sessionRef(input);
      return {
        kind: "dispatch",
        verb,
        sendClass,
        summary: target ? `Interrupt ${target}` : "Interrupt a session",
        fields: field("target", target),
      };
    }
    case "fleet_panel": {
      const sessions = strArray(input.sessions);
      return {
        kind: "dispatch",
        verb,
        sendClass,
        summary:
          sessions.length > 0
            ? `Panel — ${sessions.length} session${sessions.length === 1 ? "" : "s"}`
            : "Panel dispatch",
        fields: [
          ...field("shape", shapeOf(input.shape)),
          ...field("sessions", sessions.length > 0 ? sessions.join(", ") : null),
          ...field("message", str(input.message), true),
        ],
      };
    }
    default: {
      // The remaining read verbs carry little or no input; a bare, honest
      // header beats inventing structure for them.
      return {
        kind: "observe",
        verb,
        sendClass,
        summary: OBSERVE_SUMMARY[verb] ?? verb,
        fields: [...field("query", str(input.query)), ...field("session", sessionRef(input))],
      };
    }
  }
}

const OBSERVE_SUMMARY: Record<string, string> = {
  fleet_list: "Listing the fleet",
  fleet_summary: "Reading a session digest",
  fleet_recall: "Recalling past context",
  fleet_tasks: "Checking the task board",
  machine_map: "Mapping the machine",
};

// ── narrowing helpers ────────────────────────────────────────────────────────
// Everything below exists because `ToolInfo.input` is `unknown` and produced by
// a model: nothing here may assume a shape it has not checked.

/**
 * The tool's input, wherever this phase keeps it.
 *
 * `ToolInfo.input` is populated for most phases, but a call sitting at
 * `waiting_confirmation` carries its complete input on the STATE instead. That
 * is precisely the phase these cards matter most in — it is the approval
 * prompt, where the owner decides whether to let a dispatch run — so reading
 * only `tool.input` would blank exactly the card that has to be readable.
 * `streaming` is deliberately not consulted: its `partialInput` is a
 * half-generated fragment, and a card built from it would show a target or
 * workdir that the model has not finished writing.
 */
function resolveToolInput(tool: ToolInfo): unknown {
  if (tool.input !== undefined) return tool.input;
  return tool.state.phase === "waiting_confirmation" ? tool.state.input : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A non-empty string, or null. Whitespace-only is treated as absent. */
function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(str).filter((s): s is string => s !== null);
}

function shapeOf(v: unknown): "ship" | "scout" | null {
  return v === "ship" || v === "scout" ? v : null;
}

/**
 * The target session of a single-target verb.
 *
 * `session` is the field every such tool actually declares (`fleet_send`,
 * `fleet_summary`, `fleet_interrupt` — see their zod schemas in
 * `src/daemon/fleet.ts`). The aliases are tolerance, not guesswork: a card can
 * render an input the model PROPOSED, which reaches the approval gate before
 * the tool's schema has validated it — so a near-miss field name should still
 * show the owner what is about to be dispatched rather than a blank target.
 */
function sessionRef(input: Record<string, unknown>): string | null {
  return str(input.session) ?? str(input.name) ?? str(input.target);
}

/** `claude · opus` — either half may be absent. */
function joinBackend(provider: string | null, model: string | null): string | null {
  if (provider && model) return `${provider} · ${model}`;
  return provider ?? model;
}

/**
 * Last path segment, for a compact header. Trailing separators are ignored so
 * `/a/b/` reads as `b`, and a path that is only separators falls back to the
 * original string rather than an empty label.
 */
function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const tail = idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  return tail.length > 0 ? tail : path;
}

/** Zero or one field — absent values are omitted rather than rendered blank. */
function field(label: string, value: string | null, block = false): FleetCardField[] {
  return value === null ? [] : [{ label, value, ...(block ? { block: true } : {}) }];
}
