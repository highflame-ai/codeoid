/**
 * Goal blackboard — the role-scoped access layer
 * (docs/collaborative-session-design.md §4, §6).
 *
 * Every artifact read and write in a collaboration goes through a handle
 * obtained from `Blackboard.forRole()`. The handle is the gate: it knows which
 * kinds its role may read and write, and it refuses anything else.
 *
 * Enforcement lives HERE rather than in the tool layer on purpose. The design's
 * standing rule is that "an unenforced field is false security", and the
 * reserved `reads`/`writes` comment in pipeline/interface.ts repeats it. If
 * scoping lived only in the MCP tool wrappers, then any second caller — a
 * future frontend, the pipeline engine, a test helper — would silently get
 * unscoped access. With the service owning it, the tool surface cannot expose a
 * path that bypasses scoping because there isn't one to expose.
 *
 * The property this protects (§6): a reviewer may read `diff`+`spec` and write
 * its own `findings`. It may NOT read `research` (the implementer's reasoning
 * by proxy) and may NOT read `findings` — not even another reviewer's. A panel
 * whose members can read each other is not a panel; it's an echo. That is why
 * `review`'s default read set is exactly two kinds.
 */

import type { BlackboardStore, GoalScope } from "./store.js";
import type { Artifact, ArtifactIndexEntry } from "./types.js";
import { ARTIFACT_CONTENT_MAX, isValidArtifactKind } from "./types.js";

/** What a role may read and write. Both default to EMPTY — fail closed. */
export interface RoleIo {
  reads: readonly string[];
  writes: readonly string[];
}

/**
 * The default role→artifact profile from §3's table. A *default*, not a
 * closed list: §3 is explicit that the five named roles are a starting profile
 * and that adding a role must stay a config change. A role absent from this
 * table and declaring nothing gets nothing — the fail-closed direction.
 *
 * Note what `review` deliberately lacks: `research` (the implementer's
 * reasoning by proxy) and `findings` (its peers' opinions). Independence is a
 * consequence of the read set, not of asking nicely.
 */
export const DEFAULT_ROLE_IO: Readonly<Record<string, RoleIo>> = {
  orchestrator: { reads: ["spec", "findings"], writes: ["spec", "task-list"] },
  search: { reads: ["spec"], writes: ["research"] },
  architecture: { reads: ["spec", "research"], writes: ["adr", "task-list"] },
  reasoning: { reads: ["spec", "adr", "task-list"], writes: ["diff"] },
  review: { reads: ["spec", "diff"], writes: ["findings"] },
};

/**
 * Kinds where each writer gets its own slot.
 *
 * §4 has *each* reviewer write a `findings` entry. Without per-writer slots,
 * reviewer #2's write would become version 2 of the same artifact and a reader
 * taking "latest" would see one opinion — a panel silently collapsed to a
 * single voice, with no error anywhere. Everything else is a singleton with
 * version history.
 */
export const MULTI_WRITER_KINDS: ReadonlySet<string> = new Set(["findings"]);

export type BlackboardDenial = { ok: false; error: string };
export type BlackboardResult<T> = { ok: true; value: T } | BlackboardDenial;

/** Identity of the agent behind a handle — for attribution on every write. */
export interface RoleIdentity {
  /** Role name (already lowercased by validateCollaboration). */
  roleName: string;
  /** 1-based fan-out index; 1 for a singleton role. */
  ordinal: number;
  /** ZeroID subject of the agent. */
  authorSub: string;
}

/**
 * A role's view of one goal's blackboard. Obtained from `Blackboard.forRole`;
 * cannot widen its own scope.
 */
export class RoleBlackboard {
  #store: BlackboardStore;
  #scope: GoalScope;
  #identity: RoleIdentity;
  #io: RoleIo;

  constructor(store: BlackboardStore, scope: GoalScope, identity: RoleIdentity, io: RoleIo) {
    this.#store = store;
    this.#scope = scope;
    this.#identity = identity;
    this.#io = io;
  }

  get reads(): readonly string[] {
    return this.#io.reads;
  }
  get writes(): readonly string[] {
    return this.#io.writes;
  }

  /** This role's own slot for a multi-writer kind — never another role's. */
  #ownSlot(kind: string): string | null {
    if (!MULTI_WRITER_KINDS.has(kind)) return null;
    return this.#identity.ordinal > 1
      ? `${this.#identity.roleName}#${this.#identity.ordinal}`
      : this.#identity.roleName;
  }

  #denyRead(kind: string): BlackboardDenial | null {
    if (!isValidArtifactKind(kind)) {
      return { ok: false, error: `Unknown artifact kind "${kind}"` };
    }
    if (!this.#io.reads.includes(kind)) {
      return {
        ok: false,
        error: `Role "${this.#identity.roleName}" may not read "${kind}" — it reads: ${this.#io.reads.join(", ") || "(nothing)"}`,
      };
    }
    return null;
  }

  /** Latest version of a readable artifact. `null` value = not written yet. */
  read(kind: string, slot?: string | null): BlackboardResult<Artifact | null> {
    const denied = this.#denyRead(kind);
    if (denied) return denied;
    return { ok: true, value: this.#store.latest(this.#scope, kind, slot ?? null) };
  }

  /**
   * Every slot of a readable multi-writer kind — how the orchestrator collects
   * all N reviewers' findings for synthesis.
   */
  readAll(kind: string): BlackboardResult<Artifact[]> {
    const denied = this.#denyRead(kind);
    if (denied) return denied;
    return { ok: true, value: this.#store.latestAllSlots(this.#scope, kind) };
  }

  /**
   * Append a new version of a writable artifact.
   *
   * The slot is chosen by the SERVICE, never by the caller: a reviewer writes
   * into its own slot and has no way to name someone else's. Letting a caller
   * pass a slot would hand one reviewer the ability to overwrite another's
   * findings, which is the whole thing slots exist to prevent.
   */
  write(kind: string, content: string): BlackboardResult<Artifact> {
    if (!isValidArtifactKind(kind)) {
      return { ok: false, error: `Unknown artifact kind "${kind}"` };
    }
    if (!this.#io.writes.includes(kind)) {
      return {
        ok: false,
        error: `Role "${this.#identity.roleName}" may not write "${kind}" — it writes: ${this.#io.writes.join(", ") || "(nothing)"}`,
      };
    }
    if (content.length > ARTIFACT_CONTENT_MAX) {
      return {
        ok: false,
        error: `Artifact "${kind}" is ${content.length} bytes — max ${ARTIFACT_CONTENT_MAX}. Put large output in the workspace and reference it.`,
      };
    }
    return {
      ok: true,
      value: this.#store.append({
        scope: this.#scope,
        kind,
        slot: this.#ownSlot(kind),
        content,
        authorSub: this.#identity.authorSub,
        authorRole: this.#identity.roleName,
        now: Date.now(),
      }),
    };
  }

  /**
   * The index. Deliberately NOT scoped by `reads`: knowing that a `diff` exists
   * at v3 is not the same as reading it, the orchestrator needs the whole
   * picture to schedule (§4), and bodies never appear here. Reading still
   * requires the read scope.
   */
  index(): ArtifactIndexEntry[] {
    return this.#store.index(this.#scope);
  }
}

/** The daemon-owned blackboard: one store, many goal-and-role-scoped views. */
export class Blackboard {
  #store: BlackboardStore;

  constructor(store: BlackboardStore) {
    this.#store = store;
  }

  /**
   * A role's handle on one goal.
   *
   * `declared` comes from the role's own `reads`/`writes`. When it declares
   * neither, the §3 default profile for that role name applies; when the name
   * isn't in the profile either, the handle can do nothing — a new role must
   * say what it touches before it touches anything.
   */
  forRole(
    scope: GoalScope,
    identity: RoleIdentity,
    declared?: { reads?: readonly string[]; writes?: readonly string[] },
  ): RoleBlackboard {
    const fallback = DEFAULT_ROLE_IO[identity.roleName];
    const io: RoleIo = {
      reads: declared?.reads ?? fallback?.reads ?? [],
      writes: declared?.writes ?? fallback?.writes ?? [],
    };
    return new RoleBlackboard(this.#store, scope, identity, io);
  }

  /** Drop a goal's artifacts. Called on collaboration teardown. */
  deleteGoal(scope: GoalScope): number {
    return this.#store.deleteGoal(scope);
  }
}
