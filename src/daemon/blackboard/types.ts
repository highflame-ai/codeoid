/**
 * Goal blackboard — the typed-artifact vocabulary
 * (docs/collaborative-session-design.md §4).
 *
 * The blackboard is how role-children hand work to each other WITHOUT the
 * orchestrator re-serializing it as prose. A searcher writes `research`; an
 * architect reads `research`+`spec` and writes `adr`; each reviewer writes its
 * own `findings` entry. The orchestrator holds an index of what exists at what
 * version — never the artifact bodies.
 *
 * Why a fixed core plus a scoped escape hatch, settled in the 2026-07-25
 * grill: a wholly free-form key space makes access scoping meaningless (you
 * cannot grant "read the spec" if `spec` isn't a real name), while a closed
 * enum makes a new pack a code change. So: six core kinds that scoping and
 * tooling can rely on, and `extra/<key>` for anything else.
 */

/**
 * The fixed core artifact kinds. Order is the natural SDLC flow, which is also
 * how an index renders.
 */
export const CORE_ARTIFACT_KINDS = [
  "spec",
  "research",
  "adr",
  "task-list",
  "diff",
  "findings",
] as const;

export type CoreArtifactKind = (typeof CORE_ARTIFACT_KINDS)[number];

/** `extra/<key>` — the scoped escape hatch. Lowercase, bounded, no nesting. */
const EXTRA_PREFIX = "extra/";
const EXTRA_KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Max stored body per artifact version. A handoff is a document, not a blob;
 *  anything larger belongs in the workspace with the artifact pointing at it. */
export const ARTIFACT_CONTENT_MAX = 256 * 1024;

/** Max `extra/<key>` length including the prefix, for column sizing sanity. */
export const ARTIFACT_KIND_MAX = 64;

export function isCoreArtifactKind(kind: string): kind is CoreArtifactKind {
  return (CORE_ARTIFACT_KINDS as readonly string[]).includes(kind);
}

/**
 * Validate an artifact kind — a core name, or a well-formed `extra/<key>`.
 *
 * Rejects rather than normalizing: a typo'd kind that silently became a new
 * `extra/` slot would look like a successful handoff while the intended reader
 * waits forever on an artifact nobody wrote.
 */
export function isValidArtifactKind(kind: string): boolean {
  if (isCoreArtifactKind(kind)) return true;
  if (!kind.startsWith(EXTRA_PREFIX)) return false;
  if (kind.length > ARTIFACT_KIND_MAX) return false;
  return EXTRA_KEY_RE.test(kind.slice(EXTRA_PREFIX.length));
}

/** One stored version of one artifact. */
export interface Artifact {
  id: string;
  /** Goal scope: the orchestrating (parent) session's id. */
  goalSessionId: string;
  /** A core kind or `extra/<key>`. */
  kind: string;
  /**
   * Discriminator within a kind, for the genuinely multi-writer case: §4 has
   * *each* reviewer write a `findings` entry, and without a slot reviewer #2
   * would overwrite reviewer #1 — silently collapsing a panel to one opinion.
   * NULL/absent = the singleton slot.
   */
  slot: string | null;
  /** 1-based, monotonic per (goal, kind, slot). Writes never overwrite. */
  version: number;
  content: string;
  /** ZeroID subject of the producing agent — every contribution attributable. */
  authorSub: string;
  /** Collaboration role that produced it, when written by a role-child. */
  authorRole: string | null;
  createdAt: number;
}

/** An index row: what exists, at what version, by whom — no bodies. This is
 *  all the orchestrator ever needs (§4: "holds an index, not the artifacts"). */
export interface ArtifactIndexEntry {
  kind: string;
  slot: string | null;
  /** Latest version present. */
  version: number;
  authorSub: string;
  authorRole: string | null;
  updatedAt: number;
  /** Body size of the latest version, so the orchestrator can reason about
   *  cost before asking a child to read it. */
  bytes: number;
}
