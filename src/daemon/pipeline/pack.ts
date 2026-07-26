/**
 * Declarative pack loader. A pack is a directory with a `pack.yaml` manifest
 * (docs/sdlc-pipeline.md §7) — DATA only, no executable code. `loadPack()` parses
 * and validates it, then compiles it into the runtime `Pack` shape (id +
 * register() + pipeline), so the daemon runs a shared, contributable methodology
 * by reading files rather than importing code. This is what makes a pack safe to
 * fetch from a shared registry: nothing executable travels with it.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";
import { buildProbeGate, probePathEscapes, type ProbeSpec } from "./gate-probes";
import type {
  GatePlugin,
  Pack,
  PhaseDef,
  PhaseFailAction,
  PipelineRegistries,
  SkillPlugin,
} from "./interface";

// ── Manifest schema (the pack.yaml contract) ──────────────────────────────

const idField = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "must be an alphanumeric id (._- allowed)");

/** A capability role (ai-factory `roles/*.yaml` format) — compiled to Cedar and
 *  enforced by Shield in a later slice; parsed + carried on phases now. */
export const roleSchema = z.object({
  name: z.string().min(1).max(64),
  summary: z.string().max(500).optional(),
  /**
   * Backend this role runs on (docs/collaborative-session-design.md §8.1).
   * A role has always been a capability envelope; this also makes it a
   * role→backend binding, so one engine covers both topologies — a
   * sequential pack phase and a collaborative fan-out.
   *
   * Absent = the session's own backend, which is what every existing pack
   * relies on. Consumed only on the fleet/child path, where a provider picks
   * the CHILD a role runs on; it is never a request to mutate a bound
   * session's backend mid-run.
   */
  provider: z.string().min(1).max(64).optional(),
  /** Model within `provider`. Absent = that backend's default. */
  model: z.string().min(1).max(256).optional(),
  write: z.boolean(),
  network: z.union([z.boolean(), z.literal("read-only")]).default(false),
  envelope: z.union([z.literal("all"), z.array(z.string().max(32)).max(32)]),
  exceptions: z
    .record(
      z.string(),
      z.object({ add: z.array(z.string().max(32)).max(32).optional(), reason: z.string().max(500).optional() }),
    )
    .optional(),
});
export type RoleDef = z.infer<typeof roleSchema>;

const onFailSchema = z
  .union([z.literal("halt"), z.literal("abort"), z.object({ retry: z.number().int().positive().max(100) })])
  .optional();

const skillSchema = z.discriminatedUnion("kind", [
  z.object({ id: idField, kind: z.literal("slash"), command: z.string().min(1).max(128) }),
  z.object({ id: idField, kind: z.literal("prompt"), template: z.string().min(1).max(100_000) }),
]);

const gateAt = z.enum(["entry", "exit"]).optional();
const probeTypeSchema = z.enum([
  "file-exists",
  "glob-nonempty",
  "git-diff-nonempty",
  "build",
  "test",
  "lint",
  "verify",
]);
const probeSchema = z.object({
  type: probeTypeSchema,
  /** Path globs for file-exists / glob-nonempty, CONFINED to the run's workdir:
   *  relative and no `..` segment (a read-only probe runs even for an untrusted
   *  pack, so an escaping path would be a host-filesystem existence oracle). */
  paths: z
    .array(z.string().min(1).max(512).refine((p) => !probePathEscapes(p), "must be relative to the workdir (no leading / or `..`)"))
    .max(32)
    .optional(),
});
const gateSchema = z.union([
  z.object({ id: idField, kind: z.literal("command"), run: z.string().min(1).max(2000), at: gateAt }),
  z.object({ id: idField, kind: z.literal("probe"), probe: probeSchema, at: gateAt }),
  z.object({ id: idField, kind: z.literal("self"), prompt: z.string().max(2000).optional(), at: gateAt }),
  z.object({ id: idField, kind: z.literal("skill"), skill: idField, at: gateAt }),
  z.object({ id: idField, kind: z.literal("review"), role: z.string().max(64).optional(), at: gateAt }),
]);

const phaseSchema = z.object({
  id: idField,
  name: z.string().max(128).optional(),
  kind: z.string().max(64).optional(),
  skill: idField.optional(),
  role: z.string().max(64).optional(),
  provider: z.string().max(64).optional(),
  model: z.string().max(256).optional(),
  gate: idField.optional(),
  entryGate: idField.optional(),
  /** When true, and the phase's exit `gate` (a probe) already passes at entry,
   *  the phase is auto-marked `skipped` (its deliverable is already present).
   *  OFF by default — no phase auto-skips unless a pack opts in. */
  skipWhenSatisfied: z.boolean().optional(),
  onFail: onFailSchema,
});

export const packManifestSchema = z.object({
  schema: z.literal("codeoid/pack@v1"),
  id: idField,
  name: z.string().min(1).max(128),
  version: z.string().min(1).max(32),
  description: z.string().max(2000).optional(),
  constitution: z.string().max(512).optional(), // path relative to the pack dir
  agents: z.string().max(512).optional(),
  roles: z.array(z.string().max(512)).max(32).default([]), // paths to role yaml files
  skills: z.array(skillSchema).max(64).default([]),
  gates: z.array(gateSchema).max(64).default([]),
  phases: z.array(phaseSchema).min(1).max(64),
});
export type PackManifest = z.infer<typeof packManifestSchema>;

/** A loaded pack: the runtime `Pack` plus the parsed metadata + capability roles
 *  (kept for the Cedar-compile / Shield-enforcement slice). */
export interface LoadedPack extends Pack {
  name: string;
  version: string;
  description?: string;
  /** Capability roles keyed by name (→ Cedar, enforced by Shield next). */
  roles: Record<string, RoleDef>;
  /** Constitution text composed into every phase prompt, if declared. */
  constitution?: string;
  dir: string;
  /** Declared gates (id + kind) — surfaced for pack browsing without re-parsing
   *  the manifest. Whether a `command` gate actually runs still depends on trust. */
  gateSpecs: { id: string; kind: "command" | "probe" | "self" | "skill" | "review" }[];
}

export interface LoadPackOptions {
  /** Whether the host trusts this pack to execute `command` gates on its
   *  machine. Defaults to FALSE. A pack is pure data: it may *declare* a shell
   *  command, but declaring is not executing — a pack fetched from a shared /
   *  untrusted registry runs no host commands until an operator explicitly
   *  trusts it (Workspace-Trust / `direnv allow` model). Untrusted `command`
   *  gates fail closed, exactly like not-yet-enforced gates. */
  trusted?: boolean;
}

// ── Loader ────────────────────────────────────────────────────────────────

/** Cap on any single pack file (manifest, role, constitution) — these are small
 *  by nature; the bound stops a hostile/broken pack from OOMing the daemon by
 *  referencing a multi-GB file. */
const MAX_PACK_FILE_BYTES = 1_000_000;

/** Hard bound on a `command` gate's runtime. A gate command that hangs (blocks
 *  on network/stdin, `sleep infinity`, a wedged test) must not wedge the phase
 *  forever and leak the child — on timeout we kill it and fail the gate. */
const GATE_COMMAND_TIMEOUT_MS = 120_000;

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Resolve a pack-relative path, CONFINED to the pack directory. A manifest may
 *  only reference files it ships: absolute paths and `..` traversal are rejected
 *  lexically, and the resolved path is then canonicalized with `realpathSync` and
 *  re-checked so a symlink INSIDE the pack can't point outside it (e.g. `evil ->
 *  /etc`). Boundary is `base + sep` so a sibling like `pack-evil` can't
 *  masquerade. A missing file makes `realpathSync` throw ENOENT — surfaced as a
 *  read error by the caller. */
const underDir = (dir: string, rel: string): string => {
  const base = realpathSync(resolve(dir));
  const resolved = resolve(base, rel);
  if (isAbsolute(rel) || (resolved !== base && !resolved.startsWith(base + sep))) {
    throw new Error(`path "${rel}" escapes the pack directory`);
  }
  const real = realpathSync(resolved);
  if (real !== base && !real.startsWith(base + sep)) {
    throw new Error(`path "${rel}" escapes the pack directory (symlink)`);
  }
  return real;
};

const readText = (path: string): string => {
  const { size } = statSync(path);
  if (size > MAX_PACK_FILE_BYTES) {
    throw new Error(`file exceeds ${MAX_PACK_FILE_BYTES} bytes (${size})`);
  }
  return readFileSync(path, "utf8");
};
const readYaml = (path: string): unknown => Bun.YAML.parse(readText(path));

/**
 * Parse + validate a pack directory into a runtime `Pack`. Throws with a precise
 * message on any manifest / role / reference error (fail fast at load). The
 * returned pack's `register()` installs its skills + gates into the registries;
 * its `pipeline` is the phase list (each phase carrying its capability `role`).
 * Phase gate ids may reference this pack's gates OR built-in gates (always /
 * manual) — those are validated at `create()` against the live registries.
 * `command` gates only execute when `opts.trusted` is set (default false).
 */
export function loadPack(dir: string, opts: LoadPackOptions = {}): LoadedPack {
  let manifestRaw: unknown;
  try {
    manifestRaw = readYaml(join(dir, "pack.yaml"));
  } catch (err) {
    throw new Error(`pack "${dir}": cannot read pack.yaml — ${errText(err)}`);
  }
  const parsed = packManifestSchema.safeParse(manifestRaw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.length ? `${first.path.join(".")}: ` : "";
    throw new Error(`pack "${dir}": invalid pack.yaml — ${path}${first?.message ?? "schema error"}`);
  }
  const m = parsed.data;

  // Roles → parsed RoleDefs keyed by name.
  const roles: Record<string, RoleDef> = {};
  for (const rel of m.roles) {
    let roleRaw: unknown;
    try {
      roleRaw = readYaml(underDir(dir, rel));
    } catch (err) {
      throw new Error(`pack "${m.id}": cannot read role ${rel} — ${errText(err)}`);
    }
    const role = roleSchema.safeParse(roleRaw);
    if (!role.success) {
      throw new Error(`pack "${m.id}": invalid role ${rel} — ${role.error.issues[0]?.message ?? "schema error"}`);
    }
    roles[role.data.name] = role.data;
  }

  let constitution: string | undefined;
  if (m.constitution) {
    try {
      constitution = readText(underDir(dir, m.constitution));
    } catch (err) {
      throw new Error(`pack "${m.id}": cannot read constitution ${m.constitution} — ${errText(err)}`);
    }
  }

  const skills: SkillPlugin[] = m.skills.map((s) =>
    s.kind === "slash"
      ? { id: s.id, kind: "slash", command: s.command }
      : { id: s.id, kind: "prompt", template: s.template },
  );
  const skillIds = new Set(skills.map((s) => s.id));

  const gates: GatePlugin[] = m.gates.map((g) => buildGate(g, dir, opts.trusted ?? false));

  const seen = new Set<string>();
  const pipeline: PhaseDef[] = m.phases.map((p) => {
    if (seen.has(p.id)) throw new Error(`pack "${m.id}": duplicate phase id "${p.id}"`);
    seen.add(p.id);
    const kind = p.kind ?? (p.skill ? "skill" : undefined);
    if (!kind) throw new Error(`pack "${m.id}": phase "${p.id}" needs a kind or a skill`);
    if (p.skill && !skillIds.has(p.skill)) {
      throw new Error(`pack "${m.id}": phase "${p.id}" references unknown skill "${p.skill}"`);
    }
    if (p.role && !roles[p.role]) {
      throw new Error(`pack "${m.id}": phase "${p.id}" references unknown role "${p.role}"`);
    }
    const def: PhaseDef = { id: p.id, kind };
    if (p.name) def.name = p.name;
    if (p.skill) def.skill = p.skill;
    if (p.role) def.role = p.role;
    if (p.provider) def.provider = p.provider;
    if (p.model) def.model = p.model;
    if (p.gate) def.gate = p.gate;
    if (p.entryGate) def.entryGate = p.entryGate;
    if (p.skipWhenSatisfied) def.skipWhenSatisfied = true;
    const onFail = toOnFail(p.onFail);
    if (onFail) def.onFail = onFail;
    return def;
  });

  return {
    id: m.id,
    name: m.name,
    version: m.version,
    description: m.description,
    roles,
    constitution,
    dir,
    gateSpecs: m.gates.map((g) => ({ id: g.id, kind: g.kind })),
    pipeline,
    register(r: PipelineRegistries): void {
      for (const s of skills) r.skills.register(s);
      for (const g of gates) r.gates.register(g);
    },
  };
}

function toOnFail(v: PackManifest["phases"][number]["onFail"]): PhaseFailAction | undefined {
  if (v === undefined) return undefined;
  if (v === "halt") return { action: "halt" };
  if (v === "abort") return { action: "abort" };
  // Pack `retry: N` means N *retries* (N+1 total attempts). The engine's `max`
  // is total-attempts and it retries while attempts < max, so map N → N+1
  // (otherwise `retry: 1` would be 1 attempt = indistinguishable from abort).
  return { action: "retry", max: v.retry + 1 };
}

// ── Gate builders ─────────────────────────────────────────────────────────

/** A gate that never passes — used for gates that must not silently succeed
 *  (untrusted command gates, and self/skill/review until the enforcement slice). */
function failClosedGate(id: string, at: "entry" | "exit", reason: string): GatePlugin {
  return { id, at, async evaluate() { return { pass: false, reason }; } };
}

function buildGate(g: PackManifest["gates"][number], dir: string, trusted: boolean): GatePlugin {
  const at = g.at ?? "exit";
  if (g.kind === "probe") {
    // A deterministic phase-completion probe (docs/pipeline-phase-detection.md).
    // Read-only probes run for any pack; execution probes (build/test/lint/verify)
    // run auto-derived commands and fail closed on an untrusted pack — buildProbeGate
    // enforces that split, so trust is threaded through the same as a command gate.
    return buildProbeGate(g.id, g.probe as ProbeSpec, at, trusted);
  }
  if (g.kind === "command") {
    // A command gate is DATA (a declared shell string). Executing it is a host
    // trust decision: an untrusted pack (the registry default) fails closed, so
    // fetching a pack never runs host commands until an operator opts in.
    if (!trusted) {
      return failClosedGate(g.id, at, `command gate "${g.id}" requires a trusted pack (host opt-in) — not executed`);
    }
    const run = g.run;
    return {
      id: g.id,
      at,
      async evaluate(ctx) {
        const cwd = ctx.pipeline.workdir ?? dir;
        const proc = Bun.spawn(["sh", "-c", run], { cwd, stdout: "ignore", stderr: "ignore" });
        const TIMED_OUT = Symbol("timeout");
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race<number | typeof TIMED_OUT>([
            proc.exited,
            new Promise((res) => {
              timer = setTimeout(() => res(TIMED_OUT), GATE_COMMAND_TIMEOUT_MS);
            }),
          ]);
          if (result === TIMED_OUT) {
            proc.kill();
            return { pass: false, reason: `command gate "${g.id}" timed out after ${GATE_COMMAND_TIMEOUT_MS}ms: ${run}` };
          }
          return result === 0
            ? { pass: true }
            : { pass: false, reason: `command gate "${g.id}" failed (exit ${result}): ${run}` };
        } finally {
          clearTimeout(timer);
        }
      },
    };
  }
  // self / skill / review gates carry no AUTOMATED verdict yet. They no longer
  // fail closed (that surfaced a confusing "not yet enforced" halt): every phase
  // already halts at its boundary for a human decision (see engine.ts), so these
  // gates simply pass and defer to that human review. S4 may turn them into real
  // subagent verdicts shown alongside the human decision.
  return humanReviewGate(g.id, at);
}

/** A gate with no automated verdict — it passes, deferring acceptance to the
 *  universal human boundary halt. Distinct from failClosedGate: this is not a
 *  silent success that skips review, because the phase halts for the human
 *  regardless (engine.ts). Used for self/skill/review gate kinds. */
function humanReviewGate(id: string, at: "entry" | "exit"): GatePlugin {
  return { id, at, async evaluate() { return { pass: true }; } };
}
