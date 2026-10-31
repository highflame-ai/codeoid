/**
 * opencode → codeoid vocabulary: what a permission request is in the gate's
 * terms, model refs and reasoning variants, and errors.
 *
 * The gate keys off Claude's tool names (`isSafeTool`, `WRITE_TOOLS`, the
 * shell risk judge reads `Bash` with a string `command`), so each opencode
 * permission action is mapped onto them, with the tool call's own input
 * where opencode's request doesn't carry it (a shell request's resources are
 * the parsed sub-commands, not the command line that runs).
 *
 * Paths are shown as they really resolve. opencode asks `external_directory`
 * only for a path outside its boundary as written — the workdir, or the
 * whole git checkout the workdir is in — and reads and writes through a
 * symlink inside it without asking; the gate auto-approves `Read`, `Glob`
 * and `Grep` in guarded mode. So a read or search that resolves outside the
 * workdir is asked as `opencode_external_directory` (never auto-approved)
 * unless the call's own `external_directory` request for that directory was
 * approved, and every card names the file that is really touched.
 *
 * Every path in a call is judged by one rule (`realTarget`): resolved the
 * way the kernel resolves it in opencode's process, one component at a
 * time, never lexically in codeoid's. A path is shown only where that is
 * certain. procfs's links (`/proc/self`, `/proc/thread-self`, a process's
 * `cwd`, `root` and `fd/N`, and `/dev/fd` and `/dev/stdin` through them)
 * lead somewhere else for each process that follows them, so a call
 * through one is refused (`unshowable`): it may lead beside the server's
 * credentials. Any other step that can't be resolved for certain (`..`
 * after a missing component, a path that reads differently as written and
 * as opencode normalizes it, one codeoid can't look at, too many links)
 * makes the call an `opencode_unresolved_path` card, asked in every mode.
 */

import { lstatSync, readlinkSync, statSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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
  /** The server's home, where `~` in a tool's path leads (default: the daemon's). */
  home?: string;
  /** Directories the call's own `external_directory` request was approved for. */
  approvedDirs?: readonly string[];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Absolute, but as written: `..` is resolved by `realTarget`, which follows it both ways. */
function abs(workdir: string, p: string | undefined): string | undefined {
  if (!p) return undefined;
  return isAbsolute(p) ? p : `${workdir}/${p}`;
}

/**
 * A path from a tool call's input, as opencode resolves it (`FileAccess.resolve`):
 * `~` and `~/…` are its home (the `HOME` it started with: `ctx.home`),
 * anything else is relative to the workdir. Its own resources come resolved.
 */
function inputPath(ctx: MapContext, p: string | undefined): string | undefined {
  if (p === "~" || p?.startsWith("~/")) return `${ctx.home ?? homedir()}${p.slice(1)}`;
  return abs(ctx.workdir, p);
}

/** opencode's resources for a path action may be a directory boundary (`dir/*`). */
function resourcePath(workdir: string, r: string | undefined): string | undefined {
  if (!r) return undefined;
  return abs(workdir, r.endsWith("/*") ? r.slice(0, -2) : r);
}

/**
 * A tool call's input as opencode announced or stored it. Arguments the
 * model sent as a JSON string are announced as `{ value: "<the json>" }`,
 * while the tool runs the object they hold: a built-in's input is that
 * object (no built-in takes a `value`). An MCP tool's is left as it came:
 * its request carries the input it runs (`metadata.input`).
 */
export function callInput(name: string | undefined, raw: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(raw);
  if (name?.startsWith(MCP_MOUNT_PREFIX) || keys.length !== 1 || keys[0] !== "value" || typeof raw.value !== "string") return raw;
  try {
    const parsed: unknown = JSON.parse(raw.value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : raw;
  } catch {
    return raw;
  }
}

/** Keys a card reads that opencode's input-repair plugin turns into a boolean or a number. */
const REPAIRED_BOOLEANS = ["background", "replaceAll"] as const;
const REPAIRED_NUMBERS = ["timeout"] as const;

/**
 * A tool call's input as the tool runs it. opencode's input-repair plugin
 * (`tool-input-repair.ts`) runs before the tool and its permission request:
 * a stringified object is parsed, `"true"`/`"false"` and numeric strings
 * become booleans and numbers, a null key is dropped. A boolean or number
 * key the card reads holding anything else comes back as `bad`.
 */
function repaired(raw: unknown): { input: Record<string, unknown>; bad?: string } {
  let input: unknown = raw;
  if (typeof raw === "string") {
    try {
      input = JSON.parse(raw);
    } catch {
      input = {};
    }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return { input: {} };
  const out = { ...(input as Record<string, unknown>) };
  for (const k of REPAIRED_BOOLEANS) {
    const v = out[k];
    if (v === "true" || v === "false") out[k] = v === "true";
    else if (v === null) delete out[k];
    else if (v !== undefined && typeof v !== "boolean") return { input: out, bad: k };
  }
  for (const k of REPAIRED_NUMBERS) {
    const v = out[k];
    if (typeof v === "string" && v.trim() !== "" && Number.isSafeInteger(Number(v))) out[k] = Number(v);
    else if (v === null) delete out[k];
    else if (v !== undefined && typeof v !== "number") return { input: out, bad: k };
  }
  return { input: out };
}

/** procfs's `f_type` (`PROC_SUPER_MAGIC`). */
const PROC_SUPER_MAGIC = 0x9fa0;

/** Paths that are per-process wherever procfs is or isn't (macOS's `/dev/fd` is fdesc). */
const PER_PROCESS = ["/proc/self", "/proc/thread-self", "/dev/fd", "/dev/stdin", "/dev/stdout", "/dev/stderr"];

/** The kernel's limit on symlinks followed in one lookup (`ELOOP` past it). */
const MAX_LINKS = 40;

/** Thrown by `realTarget` for a path whose target depends on the process that follows it. */
export class PerProcessPath extends Error {
  constructor(readonly path: string) {
    super(`${path} leads through a link that goes somewhere else in opencode's process`);
  }
}

/**
 * Thrown by `realTarget` for a path codeoid can't resolve for certain. Its
 * call is asked as `opencode_unresolved_path`, in every mode; `candidates`
 * are where it might lead, judged by the secret-path gate.
 */
export class UnresolvedPath extends Error {
  constructor(
    readonly path: string,
    readonly why: string,
    readonly candidates: readonly string[] = [],
  ) {
    super(`codeoid can't tell for certain where ${path} leads: ${why}`);
  }
}

/** The card a request with a per-process path gets, by action. */
const PER_PROCESS_CARD: Record<string, string> = { shell: "Bash", edit: "Edit", read: "Read", glob: "Glob", grep: "Grep" };

/** A call whose path codeoid couldn't resolve for certain: never auto-approved (tool-safety.ts). */
export const UNRESOLVED_PATH_CARD = "opencode_unresolved_path";

function onProcfs(dir: string): boolean {
  try {
    return statfsSync(dir).type === PROC_SUPER_MAGIC;
  } catch {
    return false;
  }
}

const components = (p: string) => p.split("/").filter((c) => c !== "" && c !== ".");

/**
 * `p` (absolute) resolved the way the kernel resolves it, one component at
 * a time from `/`: `..` is the parent of the physical prefix so far, and a
 * symlink's target is spliced in as written (a relative one from the link's
 * directory), never normalized first. A component that doesn't exist ends
 * what's followed: the rest is appended as written (what a create makes).
 * Throws `PerProcessPath` at any per-process link — one of `PER_PROCESS`,
 * or any symlink on procfs — and `UnresolvedPath` at any step it can't be
 * sure of: `..` after a missing component, a component under a file, one
 * codeoid can't look at, or too many links.
 */
function physical(p: string): string {
  const parts = components(p);
  let at = "/";
  let missing = false;
  for (let links = 0; parts.length > 0; ) {
    const name = parts.shift()!;
    if (name === "..") {
      if (missing) throw new UnresolvedPath(p, `".." follows ${at}, which doesn't exist`);
      at = dirname(at);
      continue;
    }
    const next = join(at, name);
    if (PER_PROCESS.some((pp) => within(pp, next))) throw new PerProcessPath(p);
    if (missing) {
      at = next;
      continue;
    }
    let link: string | undefined;
    try {
      const st = lstatSync(next);
      if (st.isSymbolicLink()) link = readlinkSync(next);
      else if (parts.length > 0 && !st.isDirectory()) throw new UnresolvedPath(p, `${next} isn't a directory`);
    } catch (err) {
      if (err instanceof UnresolvedPath) throw err;
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new UnresolvedPath(p, `codeoid can't look at ${next}`);
      missing = true;
      at = next;
      continue;
    }
    if (link === undefined) {
      at = next;
      continue;
    }
    if (onProcfs(at)) throw new PerProcessPath(p);
    if (++links > MAX_LINKS) throw new UnresolvedPath(p, "it goes through too many links");
    parts.unshift(...components(link));
    if (isAbsolute(link)) at = "/";
  }
  return at;
}

/**
 * Where a path from an opencode call really leads in opencode's process.
 * opencode resolves a tool's path lexically (`path.resolve`, collapsing
 * `..`) and the kernel then follows that physically; the path as written
 * is followed too, and where the two readings differ the call can't be
 * shown for certain. `p` is absolute, as written (not normalized). Throws
 * `PerProcessPath` or `UnresolvedPath` (see `physical`).
 */
export function realTarget(p: string): string {
  const lexical = resolve(p);
  const target = physical(lexical);
  if (!components(p).includes("..")) return target;
  let written: string;
  try {
    written = physical(p);
  } catch (err) {
    if (err instanceof UnresolvedPath) throw new UnresolvedPath(p, err.why, [target]);
    throw err;
  }
  if (written !== target) throw new UnresolvedPath(p, `as written it leads to ${written}, as opencode reads it to ${target}`, [target, written]);
  return target;
}

/** `p` is `root` or under it. */
function within(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * A read or search of `requested` that really reaches `target` outside the
 * workdir: asked as an external directory, which the gate never
 * auto-approves. Whatever the path as written: opencode doesn't ask for one
 * elsewhere in the git checkout the workdir is in. Null when it stays
 * inside, or inside a directory approved for this call (as shown, so not
 * through a symlink).
 */
function escapedRead(ctx: MapContext, tool: string, asked: string | undefined, target: string | undefined): GateCall | null {
  const requested = asked && resolve(asked);
  if (!requested || !target || within(realTarget(ctx.workdir), target)) return null;
  if (ctx.approvedDirs?.some((d) => within(d, target))) return null;
  let dir = target;
  try {
    if (!statSync(target).isDirectory()) dir = dirname(target);
  } catch {
    dir = dirname(target);
  }
  return { name: "opencode_external_directory", input: { directories: [dir], tool, path: target, requested } };
}

/** The real target of a path, and the path as asked (as opencode reads it) when it differs. */
function shown(asked: string | undefined): { path: string | undefined; requested?: string } {
  if (!asked) return { path: undefined };
  const path = realTarget(asked);
  const requested = resolve(asked);
  return path === requested ? { path } : { path, requested };
}

/**
 * What the gate is asked for a permission request. Unknown actions — a
 * plugin's, an MCP server codeoid didn't mount, another session's mount —
 * come back `unshowable`: rejected, never allowed.
 */
export function gateCallFor(req: OcPermissionRequest, call: OcToolCall | undefined, ctx: MapContext): GateCall {
  const { input, bad } = repaired(call ? callInput(call.name, call.input) : undefined);
  const meta = req.metadata ?? {};
  const resources = req.resources ?? [];
  let mapped: GateCall;
  try {
    mapped = mapRequest(req, call, ctx, input, meta, resources);
  } catch (err) {
    if (err instanceof UnresolvedPath) {
      // Asked, never auto-approved; refused by the secret-path gate when where it might lead holds credentials.
      const candidates = [...new Set([resolve(err.path), ...err.candidates])];
      return { name: UNRESOLVED_PATH_CARD, input: { tool: call?.name ?? req.action, path: err.path, paths: candidates, reason: err.message, call: input } };
    }
    if (!(err instanceof PerProcessPath)) throw err;
    return { name: PER_PROCESS_CARD[req.action] ?? "opencode_external_directory", input: { path: err.path }, unshowable: err.message };
  }
  return bad && !mapped.unshowable ? { ...mapped, unshowable: `its "${bad}" isn't something opencode reads the same way` } : mapped;
}

function mapRequest(
  req: OcPermissionRequest,
  call: OcToolCall | undefined,
  ctx: MapContext,
  input: Record<string, unknown>,
  meta: Record<string, unknown>,
  resources: readonly string[],
): GateCall {
  switch (req.action) {
    case "shell": {
      const command = str(input.command);
      const gate = {
        name: "Bash",
        input: {
          ...(command ? { command } : {}),
          ...(str(input.workdir) ? { cwd: realTarget(inputPath(ctx, str(input.workdir))!) } : {}),
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
      const { path, requested } = shown(resourcePath(ctx.workdir, resources[0]) ?? inputPath(ctx, str(input.path)));
      const via = requested ? { requested_path: requested } : {};
      // What it writes is required by the tool, so it is in any call that
      // asks: a card without it read the input wrong, and would show a path only.
      if (tool === "write") {
        const gate = { name: "Write", input: { file_path: path, ...(typeof input.content === "string" ? { content: input.content } : {}), ...via } };
        return typeof input.content === "string" ? gate : { ...gate, unshowable: "opencode didn't say what it would write" };
      }
      if (tool === "edit") {
        const gate = {
          name: "Edit",
          input: {
            file_path: path,
            ...via,
            ...(typeof input.oldString === "string" ? { old_string: input.oldString } : {}),
            ...(typeof input.newString === "string" ? { new_string: input.newString } : {}),
            ...(input.replaceAll === true ? { replace_all: true } : {}),
            ...(Array.isArray(input.files) ? { files: input.files } : {}),
          },
        };
        return typeof input.oldString === "string" && typeof input.newString === "string"
          ? gate
          : { ...gate, unshowable: "opencode didn't say what the edit changes" };
      }
      const files = resources.map((r) => resourcePath(ctx.workdir, r)).filter((p): p is string => !!p).map((p) => realTarget(p));
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
      const asked = resourcePath(ctx.workdir, resources[0]) ?? inputPath(ctx, str(input.path));
      if (!asked) return { name: "Read", input: {}, unshowable: "opencode didn't say what it wants to read" };
      const { path, requested } = shown(asked);
      return escapedRead(ctx, "read", asked, path) ?? { name: "Read", input: { file_path: path, ...(requested ? { requested_path: requested } : {}) } };
    }
    case "glob":
    case "grep": {
      const pattern = str(resources[0]) ?? str(input.pattern);
      // The root it searches (the workdir when none is given); a search
      // below it doesn't follow symlinked directories, the root itself does.
      // opencode's glob (not its grep) reads "undefined" and "null" as no path.
      const given = str(input.path);
      const fromCall = req.action === "glob" && (given === "undefined" || given === "null") ? undefined : given;
      // The request says where the tool searches (its `path`, from the input
      // it runs; `root` is set whenever it says): that is what's judged. A
      // call input that says otherwise was read wrong, and so would its card be.
      const said = typeof meta.root === "string";
      const root = said ? str(meta.path) : fromCall;
      if (said && Object.keys(input).length > 0 && root !== fromCall) {
        return { name: req.action === "glob" ? "Glob" : "Grep", input: {}, unshowable: "opencode's request and its call disagree on where it searches" };
      }
      const include = said ? str(meta.include) : str(input.include);
      const asked = inputPath(ctx, root);
      const { path, requested } = shown(asked);
      const gate = {
        name: req.action === "glob" ? "Glob" : "Grep",
        input: {
          ...(pattern ? { pattern } : {}),
          ...(path ? { path } : {}),
          ...(requested ? { requested_path: requested } : {}),
          ...(include ? { glob: include } : {}),
        },
      };
      if (!pattern) return { ...gate, unshowable: "opencode didn't say what it's searching for" };
      return escapedRead(ctx, req.action, asked ?? ctx.workdir, path ?? realTarget(ctx.workdir)) ?? gate;
    }
    case "webfetch": {
      // The resource is what opencode authorizes. From a Code Mode script's
      // `fetch`, the request — not the script's call — says what it is.
      const url = [resources[0], meta.url, input.url].map(str).find((u) => u !== undefined && u !== "*");
      const method = str(meta.method)?.toUpperCase();
      if (!url) return { name: "WebFetch", input: {}, unshowable: "opencode didn't say which URL" };
      return { name: "WebFetch", input: { url, ...(method && method !== "GET" ? { method } : {}) } };
    }
    case "websearch": {
      const query = str(input.query) ?? str(meta.query) ?? str(resources[0]);
      return query ? { name: "WebSearch", input: { query } } : { name: "WebSearch", input: {}, unshowable: "opencode didn't say what it's searching for" };
    }
    case "subagent": {
      const gate = {
        name: "Task",
        input: {
          subagent_type: resources[0] ?? str(input.agent) ?? "",
          ...(str(input.description) ? { description: input.description } : {}),
          ...(str(input.prompt) ? { prompt: input.prompt } : {}),
          ...(input.background === true ? { run_in_background: true } : {}),
          ...(str(input.model) ? { model: input.model } : {}),
        },
      };
      // The tool requires its prompt: a card without it doesn't say what the subagent is told.
      return typeof input.prompt === "string" ? gate : { ...gate, unshowable: "opencode didn't say what the subagent is asked to do" };
    }
    case "skill":
      return { name: "Skill", input: { skill: resources[0] ?? str(input.id) ?? "" } };
    case "todowrite":
      return { name: "TodoWrite", input: { todos: input.todos ?? [] } };
    case "question":
      // The questions themselves come as a form (requestUserInput) once allowed.
      return { name: "opencode_question", input: { questions: input.questions ?? [] } };
    case "external_directory": {
      const directories = resources.map((r) => resourcePath(ctx.workdir, r) ?? r);
      // Shown as opencode names them; each must still resolve for certain.
      for (const d of directories) if (isAbsolute(d)) realTarget(d);
      return { name: "opencode_external_directory", input: { directories, ...(call?.name ? { tool: call.name } : {}) } };
    }
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
