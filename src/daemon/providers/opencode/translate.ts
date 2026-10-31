/**
 * opencode → codeoid vocabulary: what a permission request is in the gate's
 * terms, model refs and reasoning variants, and errors.
 *
 * The gate keys off Claude's tool names (`isSafeTool`, `WRITE_TOOLS`, the
 * shell risk judge reads `Bash` with a string `command`), so each opencode
 * permission action is mapped onto them, with the tool call's own input
 * where opencode's request doesn't carry it (a shell request's resources are
 * the parsed sub-commands, not the command line that runs).
 */

import { isAbsolute, resolve } from "node:path";
import { EFFORT_LEVELS, type EffortLevel } from "../../../protocol/types.js";
import type { OcError, OcModelInfo, OcModelRef, OcPermissionRequest } from "./client.js";
import { MCP_MOUNT_PREFIX } from "./policy.js";

/** The tool call a permission request is about, as the session log announced it. */
export interface OcToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface GateCall {
  /** Tool name in the gate's terms. */
  name: string;
  input: Record<string, unknown>;
  /** Set when the request can't be shown faithfully: it is rejected without asking. */
  unshowable?: string;
}

export interface MapContext {
  workdir: string;
  /** This session's own mount prefix (`coid<sfx>_`). */
  ownPrefix: string;
  /** This session's mounts: opencode-normalized server name → codeoid's name for it. */
  mounts: ReadonlyMap<string, string>;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function abs(workdir: string, p: string | undefined): string | undefined {
  if (!p) return undefined;
  return isAbsolute(p) ? p : resolve(workdir, p);
}

/** opencode's resources for a path action may be a directory boundary (`dir/*`). */
function resourcePath(workdir: string, r: string | undefined): string | undefined {
  if (!r) return undefined;
  return abs(workdir, r.endsWith("/*") ? r.slice(0, -2) : r);
}

/**
 * What the gate is asked for a permission request. Unknown actions — a
 * plugin's, an MCP server codeoid didn't mount, another session's mount —
 * come back `unshowable`: rejected, never allowed.
 */
export function gateCallFor(req: OcPermissionRequest, call: OcToolCall | undefined, ctx: MapContext): GateCall {
  const input = call?.input ?? {};
  const meta = req.metadata ?? {};
  const resources = req.resources ?? [];
  switch (req.action) {
    case "shell": {
      const command = str(input.command);
      const gate = {
        name: "Bash",
        input: {
          ...(command ? { command } : {}),
          ...(str(input.workdir) ? { cwd: abs(ctx.workdir, str(input.workdir)) } : {}),
          ...(str(input.description) ? { description: input.description } : {}),
          ...(input.background === true ? { run_in_background: true } : {}),
          ...(typeof input.timeout === "number" ? { timeout: input.timeout } : {}),
        },
      };
      // The resources are opencode's parse of the command, not what runs.
      return command ? gate : { ...gate, unshowable: "opencode didn't say what the command is" };
    }
    case "edit": {
      const tool = call?.name;
      // The resource is what opencode authorizes; the input only says it too.
      const path = resourcePath(ctx.workdir, resources[0]) ?? abs(ctx.workdir, str(input.path));
      if (tool === "write") {
        return { name: "Write", input: { file_path: path, ...(typeof input.content === "string" ? { content: input.content } : {}) } };
      }
      if (tool === "edit") {
        return {
          name: "Edit",
          input: {
            file_path: path,
            ...(typeof input.oldString === "string" ? { old_string: input.oldString } : {}),
            ...(typeof input.newString === "string" ? { new_string: input.newString } : {}),
            ...(input.replaceAll === true ? { replace_all: true } : {}),
            ...(Array.isArray(input.files) ? { files: input.files } : {}),
          },
        };
      }
      const files = resources.map((r) => resourcePath(ctx.workdir, r)).filter((p): p is string => !!p);
      if (files.length === 0) return { name: "Edit", input: {}, unshowable: "opencode didn't say which file it wants to change" };
      return {
        name: "Edit",
        input: {
          file_path: files[0],
          ...(files.length > 1 ? { files } : {}),
          ...(typeof input.patchText === "string" ? { patch: input.patchText } : {}),
          ...(Array.isArray(meta.files) ? { changes: meta.files } : {}),
          ...(tool ? { tool } : {}),
        },
      };
    }
    case "read": {
      const path = resourcePath(ctx.workdir, resources[0]) ?? abs(ctx.workdir, str(input.path));
      return path ? { name: "Read", input: { file_path: path } } : { name: "Read", input: {}, unshowable: "opencode didn't say what it wants to read" };
    }
    case "glob":
    case "grep": {
      const pattern = str(input.pattern) ?? str(resources[0]);
      const gate = {
        name: req.action === "glob" ? "Glob" : "Grep",
        input: {
          ...(pattern ? { pattern } : {}),
          ...(str(input.path) ? { path: abs(ctx.workdir, str(input.path)) } : {}),
          ...(str(input.include) ? { glob: input.include } : {}),
        },
      };
      return pattern ? gate : { ...gate, unshowable: "opencode didn't say what it's searching for" };
    }
    case "webfetch": {
      const url = str(input.url) ?? str(meta.url) ?? str(resources[0]);
      return url ? { name: "WebFetch", input: { url } } : { name: "WebFetch", input: {}, unshowable: "opencode didn't say which URL" };
    }
    case "websearch": {
      const query = str(input.query) ?? str(meta.query) ?? str(resources[0]);
      return query ? { name: "WebSearch", input: { query } } : { name: "WebSearch", input: {}, unshowable: "opencode didn't say what it's searching for" };
    }
    case "subagent":
      return {
        name: "Task",
        input: {
          subagent_type: resources[0] ?? str(input.agent) ?? "",
          ...(str(input.description) ? { description: input.description } : {}),
          ...(str(input.prompt) ? { prompt: input.prompt } : {}),
          ...(input.background === true ? { run_in_background: true } : {}),
          ...(str(input.model) ? { model: input.model } : {}),
        },
      };
    case "skill":
      return { name: "Skill", input: { skill: resources[0] ?? str(input.id) ?? "" } };
    case "todowrite":
      return { name: "TodoWrite", input: { todos: input.todos ?? [] } };
    case "question":
      // The questions themselves come as a form (requestUserInput) once allowed.
      return { name: "opencode_question", input: { questions: input.questions ?? [] } };
    case "external_directory":
      return {
        name: "opencode_external_directory",
        input: { directories: resources.map((r) => resourcePath(ctx.workdir, r) ?? r), ...(call?.name ? { tool: call.name } : {}) },
      };
    case "opencode_list_mcp_resources":
    case "opencode_read_mcp_resource": {
      const foreign = resources.find((r) => r.startsWith(MCP_MOUNT_PREFIX) && !r.startsWith(ctx.ownPrefix));
      const gate = { name: req.action, input: { resources } };
      return foreign ? { ...gate, unshowable: "it names another session's MCP server" } : gate;
    }
  }
  if (req.action.startsWith(ctx.ownPrefix)) {
    const rest = req.action.slice(ctx.ownPrefix.length);
    // Longest name first: one server's name can be another's prefix.
    const server = [...ctx.mounts.keys()].sort((a, b) => b.length - a.length).find((n) => rest.startsWith(`${n}_`));
    if (server) {
      const mcpInput = meta.input && typeof meta.input === "object" && !Array.isArray(meta.input) ? (meta.input as Record<string, unknown>) : input;
      return { name: `mcp__${ctx.mounts.get(server)}__${rest.slice(server.length + 1)}`, input: mcpInput };
    }
  }
  if (req.action.startsWith(MCP_MOUNT_PREFIX)) {
    return { name: `opencode_${req.action}`, input: {}, unshowable: "it's a tool of an MCP server another codeoid session mounted" };
  }
  return { name: `opencode_${req.action}`, input: { resources }, unshowable: `codeoid doesn't know opencode's "${req.action}" permission` };
}

// ── Models and efforts ──────────────────────────────────────────────────────

/** codeoid's id for an opencode model: `provider/model`, opencode's own string form. */
export function modelValue(ref: { providerID: string; id: string }): string {
  return `${ref.providerID}/${ref.id}`;
}

/** A `provider/model` id (a `#variant` suffix is dropped: the effort carries it). Null when it isn't one. */
export function parseModelValue(value: string): OcModelRef | null {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return null;
  const hash = value.indexOf("#", slash + 1);
  return { providerID: value.slice(0, slash), id: value.slice(slash + 1, hash === -1 ? undefined : hash) };
}

/** A reasoning variant on codeoid's scale, or null for a variant that isn't an effort level. */
export function effortOfVariant(variant: string): EffortLevel | null {
  const v = variant.toLowerCase();
  if (v === "none" || v === "off") return "off";
  return (EFFORT_LEVELS as readonly string[]).includes(v) ? (v as EffortLevel) : null;
}

/** The variant that gives `effort` on `model`, or undefined when the model has none for it. */
export function variantForEffort(model: OcModelInfo | undefined, effort: EffortLevel | undefined): string | undefined {
  if (!model || !effort) return undefined;
  return model.variants.find((v) => effortOfVariant(v.id) === effort)?.id;
}

/** The efforts a model takes, in codeoid's order. */
export function effortsOf(model: OcModelInfo): EffortLevel[] {
  const have = new Set(model.variants.map((v) => effortOfVariant(v.id)).filter((e): e is EffortLevel => e !== null));
  return EFFORT_LEVELS.filter((e) => have.has(e));
}

// ── Errors ──────────────────────────────────────────────────────────────────

/** An opencode structured error as codeoid's error `detail` (read by the usage-limit classifier). */
export function errorDetail(error: OcError | undefined): Record<string, unknown> | undefined {
  if (!error || typeof error !== "object") return undefined;
  return {
    type: error.type,
    message: error.message,
    ...(typeof error.status === "number" ? { status: error.status } : {}),
    ...(typeof error.retryAfterMs === "number" ? { retryDelayMs: error.retryAfterMs } : {}),
  };
}

export function describeError(error: OcError | undefined): string {
  if (!error) return "opencode reported a failure without saying why";
  return error.message || error.type || "opencode reported a failure without saying why";
}

/** The model-facing text of a tool result (`Tool.Content[]`). */
export function toolOutputText(content: unknown, error?: OcError): string {
  const parts = Array.isArray(content)
    ? content.flatMap((c) => {
        const item = c as { type?: string; text?: string; name?: string; uri?: string };
        if (item.type === "text" && typeof item.text === "string") return [item.text];
        if (item.type === "file") return [`[file ${item.name ?? item.uri ?? ""}]`];
        return [];
      })
    : [];
  const text = parts.join("\n");
  if (error) return text ? `${error.message}\n${text}` : error.message;
  return text;
}
