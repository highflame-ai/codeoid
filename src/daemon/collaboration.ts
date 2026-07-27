/**
 * Collaborative-session config validation (docs/collaborative-session-design.md).
 *
 * A collaboration is one goal worked by several role-children, each bound to
 * its own backend. This module owns the SEMANTIC rules — the wire schema
 * (`collaborationConfigSchema`) only checks shape, deliberately, so that an
 * unknown provider or a missing orchestrator reaches the daemon and gets a
 * specific, actionable error instead of an opaque parse failure.
 *
 * Everything here is fail-closed. A collaboration that names a backend this
 * daemon doesn't have must never quietly collapse onto the default — that is
 * the same rule `#create` already applies to `providerId`, and it matters
 * more here: the entire point of a collaboration is that roles sit on
 * *different* vendors, so a silent fallback would produce a "multi-model"
 * session that is secretly single-model.
 */

import type { CollaborationConfig, CollaborationRole } from "../protocol/types.js";
import { LIMITS, ORCHESTRATOR_ROLE } from "../protocol/types.js";
import { CLAUDE_PROVIDER_ID, resolveModelIdForProvider } from "./models.js";
import { CORE_ARTIFACT_KINDS, isValidArtifactKind } from "./blackboard/types.js";
import { resolveRoleIo } from "./blackboard/service.js";

/** The provider-registry surface this module needs — kept narrow so tests
 *  can pass a stub instead of building a real registry. */
export interface ProviderLookup {
  has(id: string): boolean;
  ids(): string[];
}

export type CollaborationValidation =
  | { ok: true; config: CollaborationConfig }
  | { ok: false; error: string };

/**
 * Validate + normalize a collaboration config.
 *
 * On success the returned config is normalized: role names trimmed, `count`
 * defaulted to 1, and each `model` resolved against its own role's backend
 * (so downstream code never re-resolves, and never re-resolves against the
 * wrong provider).
 */
export function validateCollaboration(
  config: CollaborationConfig,
  providers: ProviderLookup,
): CollaborationValidation {
  const goal = config.goal?.trim();
  if (!goal) return { ok: false, error: "collaboration.goal must not be empty" };

  // Re-check the published bounds here, not only in Zod. Embedded frontends
  // hold the SessionManager directly and never cross `parseClientMessage`, so
  // the wire schema is not the only door into this function — and the design's
  // own rule is that an unenforced field is false security.
  if (goal.length > LIMITS.COLLABORATION_GOAL_MAX) {
    return {
      ok: false,
      error: `collaboration.goal is ${goal.length} chars — max ${LIMITS.COLLABORATION_GOAL_MAX}`,
    };
  }
  if (config.roles.length > LIMITS.COLLABORATION_ROLES_MAX) {
    return {
      ok: false,
      error: `collaboration has ${config.roles.length} roles — max ${LIMITS.COLLABORATION_ROLES_MAX}`,
    };
  }

  const roles: CollaborationRole[] = [];
  const seen = new Set<string>();

  for (const raw of config.roles) {
    const name = raw.name?.trim();
    if (!name) return { ok: false, error: "collaboration role name must not be empty" };

    // Case-insensitive uniqueness: "Review" and "review" addressing different
    // backends would make every downstream lookup ambiguous.
    const key = name.toLowerCase();
    if (seen.has(key)) {
      return { ok: false, error: `Duplicate collaboration role "${name}"` };
    }
    seen.add(key);

    if (!providers.has(raw.providerId)) {
      return {
        ok: false,
        error: `Unknown provider "${raw.providerId}" for role "${name}" — available: ${providers
          .ids()
          .join(", ")}`,
      };
    }

    // Blackboard scoping: an unknown kind must reject here. Left to pass, a
    // typo like `reads: ["diffs"]` would produce a role that appears scoped but
    // can never read the artifact it needs, and the failure would surface much
    // later as an agent inexplicably waiting on a handoff.
    for (const [field, kinds] of [
      ["reads", raw.reads],
      ["writes", raw.writes],
    ] as const) {
      if (!kinds) continue;
      for (const kind of kinds) {
        if (!isValidArtifactKind(kind)) {
          return {
            ok: false,
            error: `Role "${name}" ${field} unknown artifact kind "${kind}" — valid: ${CORE_ARTIFACT_KINDS.join(", ")}, or extra/<key>`,
          };
        }
      }
    }

    const count = raw.count ?? 1;
    if (!Number.isInteger(count) || count < 1) {
      return { ok: false, error: `Role "${name}" count must be a positive integer` };
    }
    if (count > LIMITS.COLLABORATION_ROLE_COUNT_MAX) {
      return {
        ok: false,
        error: `Role "${name}" count is ${count} — max ${LIMITS.COLLABORATION_ROLE_COUNT_MAX}`,
      };
    }

    // Provider-aware model check. resolveModelIdForProvider returns null for
    // a Claude-shaped value on a non-Claude backend, which is exactly the
    // mistake worth catching at create time ("review on gemini with model
    // opus") rather than at first turn. It does NOT catch a typo in a
    // provider-native id — models.ts leaves the backend as the real validator
    // (a cached catalog goes stale the moment a vendor ships a point release).
    let model: string | undefined;
    if (raw.model !== undefined && raw.model.trim() !== "") {
      const resolved = resolveModelIdForProvider(raw.model, raw.providerId);
      if (!resolved) {
        return {
          ok: false,
          error: `Model "${raw.model}" is not valid for provider "${raw.providerId}" (role "${name}")`,
        };
      }
      model = resolved;
    }

    roles.push({
      // Store the lowercased name. Matching is case-insensitive everywhere
      // (uniqueness above, orchestratorRole below), so keeping the caller's
      // casing would let `ORCHESTRATOR:claude` validate and then miss any
      // exact-match lookup downstream.
      name: key,
      providerId: raw.providerId,
      ...(model !== undefined ? { model } : {}),
      count,
      ...(raw.purpose !== undefined ? { purpose: raw.purpose } : {}),
      // Normalize to an explicit boolean so downstream code never has to
      // re-decide what "absent" means for write authority.
      write: raw.write === true,
      // Left ABSENT when undeclared, deliberately — the blackboard service
      // distinguishes "declared nothing" (fall back to the §3 default profile
      // for this role name) from "declared an empty list" (reads/writes
      // nothing). Defaulting to [] here would erase that distinction and
      // silently strip every default profile.
      ...(raw.reads !== undefined ? { reads: [...raw.reads] } : {}),
      ...(raw.writes !== undefined ? { writes: [...raw.writes] } : {}),
    });
  }

  const orchestrators = roles.filter(
    (r) => r.name.toLowerCase() === ORCHESTRATOR_ROLE,
  );
  if (orchestrators.length === 0) {
    return {
      ok: false,
      error: `A collaboration needs exactly one "${ORCHESTRATOR_ROLE}" role — got none`,
    };
  }
  // Unreachable via the duplicate check above (two roles named "orchestrator"
  // collide first), but kept so the invariant survives a future change to how
  // names are keyed.
  if (orchestrators.length > 1) {
    return {
      ok: false,
      error: `A collaboration needs exactly one "${ORCHESTRATOR_ROLE}" role — got ${orchestrators.length}`,
    };
  }

  const orchestrator = orchestrators[0]!;
  if (orchestrator.providerId !== CLAUDE_PROVIDER_ID) {
    return {
      ok: false,
      error: `The "${ORCHESTRATOR_ROLE}" role must run on "${CLAUDE_PROVIDER_ID}" in v1 (got "${orchestrator.providerId}") — it is the only backend that mounts the fleet MCP server. Non-Claude orchestrators are tracked in #245.`,
    };
  }
  // The orchestrator delegates; it is not itself a fan-out role.
  if (orchestrator.count !== 1) {
    return {
      ok: false,
      error: `The "${ORCHESTRATOR_ROLE}" role cannot fan out (count must be 1, got ${orchestrator.count})`,
    };
  }

  return { ok: true, config: { goal, roles } };
}

/**
 * The orchestrator binding of a validated config.
 *
 * Safe to assume present: `validateCollaboration` rejects a config without
 * exactly one orchestrator, so every `CollaborationConfig` that reaches the
 * rest of the daemon has one. Matching is case-insensitive to agree with the
 * validator, even though it also lowercases the stored name.
 */
export function orchestratorRole(
  config: CollaborationConfig,
): CollaborationRole | undefined {
  return config.roles.find((r) => r.name.toLowerCase() === ORCHESTRATOR_ROLE);
}

// ── Role → children (P1b) ───────────────────────────────────────────────────

/**
 * Ceiling on the total children one collaboration may bring up.
 *
 * The per-role and per-collaboration schema bounds multiply: 15 worker roles
 * × 8 fan-out is 120 live agent subprocesses from a single `session.create`.
 * The real concurrency governor is the live-worker cap in P3; this is the
 * blast-radius backstop that must exist BEFORE anything spawns, because
 * without it one create request can exhaust the machine.
 */
export const MAX_COLLABORATION_CHILDREN = 12;

/** One child to bring up: a role instance bound to a backend. */
export interface PlannedChild {
  roleName: string;
  /** 1-based index within this role's fan-out (`review` ×3 → 1, 2, 3). */
  ordinal: number;
  providerId: string;
  model?: string;
  /** Dispatch worker shape, derived from the role's write authority. */
  shape: "ship" | "scout";
  write: boolean;
  purpose?: string;
  /** Declared blackboard scope, if the role set one; absent = §3 default. */
  reads?: readonly string[];
  writes?: readonly string[];
}

/**
 * Flatten a validated config into the children to spawn.
 *
 * The orchestrator is deliberately EXCLUDED: the collaborative session itself
 * is the orchestrator (that is why `#create` derives its provider from this
 * role), so spawning a child for it would double it.
 *
 * Fails rather than truncating when the total exceeds the ceiling — silently
 * dropping roles would give the caller a collaboration quietly missing a
 * reviewer, which is worse than a clear rejection.
 */
export function planChildren(
  config: CollaborationConfig,
):
  | { ok: true; children: PlannedChild[] }
  | { ok: false; error: string } {
  const children: PlannedChild[] = [];
  for (const role of config.roles) {
    if (role.name.toLowerCase() === ORCHESTRATOR_ROLE) continue;
    const count = role.count ?? 1;
    for (let ordinal = 1; ordinal <= count; ordinal++) {
      children.push({
        roleName: role.name,
        ordinal,
        providerId: role.providerId,
        ...(role.model !== undefined ? { model: role.model } : {}),
        // scout holds no tools:write — see WORKER_SCOPE_PROFILES. This is the
        // enforcement behind §6's "a reviewer that provably cannot write".
        shape: role.write === true ? "ship" : "scout",
        write: role.write === true,
        ...(role.purpose !== undefined ? { purpose: role.purpose } : {}),
        ...(role.reads !== undefined ? { reads: role.reads } : {}),
        ...(role.writes !== undefined ? { writes: role.writes } : {}),
      });
    }
  }
  if (children.length > MAX_COLLABORATION_CHILDREN) {
    return {
      ok: false,
      error: `Collaboration would spawn ${children.length} children — max ${MAX_COLLABORATION_CHILDREN}. Reduce role count or fan-out.`,
    };
  }
  return { ok: true, children };
}

/** Stable display name for a child session. */
export function childSessionName(parentName: string, child: PlannedChild): string {
  const suffix = child.ordinal > 1 ? `-${child.ordinal}` : "";
  return `${parentName}:${child.roleName}${suffix}`;
}

/**
 * Recover the `PlannedChild` for one live role instance, from the goal config
 * plus the identity a child already carries (`collaborationRole`).
 *
 * The resume counterpart of `planChildren`, and deliberately implemented BY
 * calling it rather than re-deriving `shape`/`write`/`reads`/`writes` from the
 * role entry a second time. A resumed child that computed its own shape would
 * be one edit away from disagreeing with the one it spawned under — and the
 * direction that disagreement fails is a read-only reviewer coming back able to
 * write. Sharing the derivation makes that class of drift unrepresentable.
 *
 * `undefined` when the role or ordinal is no longer in the config, which is the
 * fail-closed direction: no plan, no restored authority.
 */
export function plannedChildFor(
  config: CollaborationConfig,
  roleName: string,
  ordinal: number,
): PlannedChild | undefined {
  const planned = planChildren(config);
  if (!planned.ok) return undefined;
  return planned.children.find(
    (c) => c.roleName === roleName && c.ordinal === ordinal,
  );
}

/**
 * Everything about a role-child's Session that ENCODES ITS RESTRICTIONS —
 * worker shape, capability role, and the brief that states the contract.
 *
 * One function, two callers: `#spawnCollaborationChildren` on create and the
 * resume path on restart. They were separate before, and the omission was
 * silent in exactly the worst way: a resumed reviewer came back with no
 * `workerShape` (so its next turn registered a full session agent instead of a
 * scope-capped `scout` leaf) and no capability role (so `roleDeniesTool` had
 * nothing to deny with). Nothing failed; the fence was just gone.
 *
 * `constitution` is a parameter rather than computed here so the degraded
 * resume path — child on disk, goal config unrecoverable — can substitute an
 * honest "your goal was lost" brief while still getting the real restrictions.
 */
export function roleChildPosture(
  child: PlannedChild,
  parentSessionId: string,
  constitution: string,
): {
  role: "worker";
  workerShape: "ship" | "scout";
  pack: {
    id: string;
    constitution: string;
    role: { name: string; write: boolean; network: "read-only"; envelope: "all" };
    roleName: string;
    subagents: never[];
  };
  collaborationRole: {
    parentSessionId: string;
    roleName: string;
    ordinal: number;
    write: boolean;
  };
} {
  return {
    role: "worker",
    // The enforcement behind §6: a read-only role becomes a "scout", whose
    // LEAF identity profile carries no tools:write at all, so it cannot mint
    // write authority even via a sub-agent.
    workerShape: child.shape,
    // ...and the same restriction at the canUseTool fence, where
    // roleDeniesTool turns `write: false` into a hard tool deny (Claude-hard;
    // advisory + logged on backends whose tools don't all route through the
    // gate — see roleEnforcement).
    pack: {
      id: "collaboration",
      constitution,
      role: {
        name: child.roleName,
        write: child.write,
        // Not `false`: §3 gives the search role web access, and roleDeniesTool
        // only denies network tools on an explicit false. Per-role network
        // gating is a later phase.
        network: "read-only",
        envelope: "all",
      },
      roleName: child.roleName,
      subagents: [],
    },
    collaborationRole: {
      parentSessionId,
      roleName: child.roleName,
      ordinal: child.ordinal,
      write: child.write,
    },
  };
}

/**
 * The brief for a child whose goal config could not be recovered on resume.
 *
 * Reachable only from a torn state (the child's transcript survived while its
 * orchestrator's did not — teardown normally removes both). It says so plainly
 * instead of leaving the agent to infer a goal from its own transcript, and it
 * tells it to stop rather than resume work it can no longer coordinate.
 */
export function orphanedChildBrief(roleName: string, write: boolean): string {
  return [
    `<collaboration role="${roleName}" state="orphaned">`,
    `You are the "${roleName}" role of a collaborative session whose goal configuration did not survive a daemon restart.`,
    write
      ? "Your write authority is unchanged."
      : "You are READ-ONLY: your identity holds no write scope, so file edits will be denied.",
    "The goal blackboard is NOT mounted — the goal it belonged to is gone, and its artifacts were dropped with it.",
    "Do not start new work and do not guess the goal. Report your state if asked, and stop.",
    "</collaboration>",
  ].join("\n");
}

/**
 * The goal brief handed to a role-child on spawn.
 *
 * Deliberately narrow. A child is told its goal, its role, and its contract —
 * never how the other roles are doing, and never the orchestrator's
 * reasoning. §6's independence property depends on a reviewer not seeing the
 * implementer's thinking, and the cheapest way to honor that is to not put it
 * in the brief in the first place. Structured handoffs arrive through the
 * blackboard in the next phase, scoped per role.
 */
export function childBrief(
  config: CollaborationConfig,
  child: PlannedChild,
): string {
  const contract = child.write
    ? "You MAY modify files in your workdir. Keep the diff minimal and verify your work."
    : "You are READ-ONLY: your identity holds no write scope, so file edits will be denied. Investigate and report — your written findings are the deliverable.";
  const io = resolveRoleIo(child.roleName, { reads: child.reads, writes: child.writes });
  return [
    `<collaboration role="${child.roleName}"${child.ordinal > 1 ? ` member="${child.ordinal}"` : ""}>`,
    `You are the "${child.roleName}" role in a collaborative session working one shared goal.`,
    child.purpose ? `Your purpose: ${child.purpose}` : null,
    contract,
    "You are one of several agents on this goal, possibly on different model backends. You cannot see the others' work or the orchestrator's reasoning — that is deliberate, so your contribution stays independent.",
    "",
    "## Handing work off",
    "",
    "Shared state lives on the goal BLACKBOARD, not in chat. Use the blackboard tools:",
    "- `blackboard_index` — what exists, at what version, written by whom (no contents).",
    "- `blackboard_read` / `blackboard_read_all` — read an artifact you are scoped for.",
    "- `blackboard_write` — publish YOUR output. It appends a version; it never overwrites, and for multi-writer kinds you write your own entry.",
    "",
    `You can READ: ${io.reads.length > 0 ? io.reads.join(", ") : "(nothing — you work only from the task you are sent)"}`,
    `You can WRITE: ${io.writes.length > 0 ? io.writes.join(", ") : "(nothing — report back in your reply instead)"}`,
    "Anything outside that is refused by the daemon, not by your own judgement — don't work around it, and don't ask another agent to fetch it for you.",
    "",
    "Wait for instructions from the orchestrator before acting; it will send you a specific task.",
    "</collaboration>",
    "",
    `GOAL: ${config.goal}`,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

/**
 * Compile a collaboration into the ephemeral one-goal pack activation the
 * orchestrator session runs under (§9: the toggle "compiles to an ephemeral
 * one-goal pack" and pack vocabulary stays hidden on this path).
 *
 * `id` is synthetic and never installed on disk — it exists so `SessionInfo.
 * profile` reads sensibly and so the pipeline machinery, which already keys
 * off an activation, needs no special case for collaborations.
 */
export function compileGoalPack(
  config: CollaborationConfig,
  children: readonly PlannedChild[],
): { id: string; constitution: string; subagents: [] } {
  const roster = children
    .map(
      (c) =>
        `- ${c.roleName}${c.ordinal > 1 ? ` #${c.ordinal}` : ""} — ${c.providerId}${c.model ? `/${c.model}` : ""}, ${c.write ? "may write" : "read-only"}`,
    )
    .join("\n");
  return {
    id: "collaboration",
    constitution: [
      "# Collaborative session",
      "",
      "You are the ORCHESTRATOR of a collaborative session working ONE goal:",
      "",
      config.goal,
      "",
      "## Your role",
      "",
      "You plan, delegate, and synthesize. You do NOT do the work yourself — that is what your role-children are for.",
      "Direct them with the fleet tools; each dispatch needs the owner's approval, and the owner sees your exact tool input first.",
      "",
      "## Your fleet",
      "",
      roster || "(no role-children — this collaboration declared only an orchestrator)",
      "",
      "## Rules",
      "",
      "- A read-only child CANNOT edit files; its identity holds no write scope. Don't ask it to.",
      "- Children cannot see each other's work or your reasoning. When a role needs another's output, you pass it deliberately.",
      "- Reviewers must stay independent: give them the change and the goal, never the implementer's reasoning or another reviewer's findings.",
    ].join("\n"),
    subagents: [],
  };
}

/**
 * Parse one `--role` CLI spec into a `CollaborationRole`.
 *
 * Format: `name:provider[:model][*count]` — e.g.
 *   orchestrator:claude
 *   reasoning:openai:gpt-5-codex
 *   review:gemini*3
 *
 * Shape only; the semantic rules stay in `validateCollaboration` so the CLI
 * and the wire path fail identically. Throws with an actionable message —
 * the caller is a CLI that exits on bad input.
 */
export function parseRoleSpec(spec: string): CollaborationRole {
  const trimmed = spec.trim();
  if (!trimmed) throw new Error("--role must not be empty");

  // Split the fan-out suffix off the RIGHT first, so a `*` can never be
  // confused with part of a model id.
  let body = trimmed;
  let count: number | undefined;
  const star = body.lastIndexOf("*");
  if (star !== -1) {
    const raw = body.slice(star + 1).trim();
    if (!/^\d+$/.test(raw)) {
      throw new Error(`Invalid count in --role "${spec}" — expected e.g. "review:gemini*3"`);
    }
    count = Number.parseInt(raw, 10);
    if (count < 1) throw new Error(`Invalid count in --role "${spec}" — must be at least 1`);
    // Bound it here so an over-large fan-out gets this message rather than a
    // raw schema error from the daemon's wire validation.
    if (count > LIMITS.COLLABORATION_ROLE_COUNT_MAX) {
      throw new Error(
        `Invalid count in --role "${spec}" — max ${LIMITS.COLLABORATION_ROLE_COUNT_MAX}`,
      );
    }
    body = body.slice(0, star);
  }

  const parts = body.split(":").map((p) => p.trim());
  if (parts.length < 2 || parts.length > 3) {
    throw new Error(
      `Invalid --role "${spec}" — expected name:provider[:model][*count]`,
    );
  }
  const [name, providerId, model] = parts;
  if (!name) throw new Error(`Invalid --role "${spec}" — role name is empty`);
  if (!providerId) throw new Error(`Invalid --role "${spec}" — provider is empty`);
  if (parts.length === 3 && !model) {
    throw new Error(`Invalid --role "${spec}" — model is empty (drop the trailing ":")`);
  }

  return {
    name,
    providerId,
    ...(model ? { model } : {}),
    ...(count !== undefined ? { count } : {}),
  };
}
