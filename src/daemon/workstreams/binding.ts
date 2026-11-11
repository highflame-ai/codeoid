/**
 * A session's home workstream as persisted in its meta file
 * (`TranscriptMeta.workstream`, docs/workstreams-design.md G5). Kept apart from
 * the service so the transcript store can carry it without importing matching.
 */

import type { WorkstreamSource } from "../../protocol/types.js";

/**
 * Another workstream a session may read (§7.2): its folders through file
 * tools and the sandbox (read-only), its memory through recall. Never its
 * servers, env or accounts, and never a write.
 */
export interface WorkstreamReference {
  workstream: string;
  /** Folders inside it; absent = all of its folders. */
  paths?: string[];
  /** The subject that granted it (an `ask` workstream: the owner who confirmed). */
  grantedBy: string;
  grantedAt: string;
}

/** A session's home, as persisted in its meta (TranscriptMeta.workstream). */
export interface WorkstreamBinding {
  /** Absent = no home (`source: "none"`). */
  id?: string;
  source: WorkstreamSource;
  matchedBy?: string;
  /** The config revision the binding was made under. */
  revision: string;
  references?: WorkstreamReference[];
  /**
   * Every workstream the session has read from through a reference, for its
   * lifetime (§14 q3): a later move or fork follows each one's share policy
   * as it is then, even after the reference is gone.
   */
  readFrom?: string[];
  /**
   * The stored binding couldn't be read back, so what the session read from
   * is unknown: it gets no home, and is never moved to another workstream
   * (that would carry its conversation past a policy nobody can check).
   */
  sealed?: true;
}

const ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_REFERENCES = 32;
const MAX_REFERENCE_PATHS = 64;

function readReference(raw: unknown): WorkstreamReference | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.workstream !== "string" || !ID.test(r.workstream)) return undefined;
  if (typeof r.grantedBy !== "string" || r.grantedBy.length === 0 || r.grantedBy.length > 512) return undefined;
  if (typeof r.grantedAt !== "string" || r.grantedAt.length > 64) return undefined;
  if (r.paths !== undefined) {
    if (!Array.isArray(r.paths) || r.paths.length > MAX_REFERENCE_PATHS) return undefined;
    if (!r.paths.every((p) => typeof p === "string" && p.startsWith("/") && p.length <= 4096 && !p.includes("\0"))) return undefined;
  }
  return {
    workstream: r.workstream,
    ...(r.paths !== undefined ? { paths: [...(r.paths as string[])] } : {}),
    grantedBy: r.grantedBy,
    grantedAt: r.grantedAt,
  };
}

/** Why a reference's folders can't be stored (the same bounds a binding is read back with), or undefined. */
export function referencePathsProblem(paths: readonly string[] | undefined): string | undefined {
  if (paths === undefined) return undefined;
  if (paths.length === 0) return "A reference names its folders, or none for all of them";
  if (paths.length > MAX_REFERENCE_PATHS) return `A reference names at most ${MAX_REFERENCE_PATHS} folders`;
  const bad = paths.find((p) => !p.startsWith("/") || p.length > 4096 || p.includes("\0"));
  return bad === undefined ? undefined : `Not an absolute folder: ${JSON.stringify(bad)}`;
}

/** Most references one session holds. */
export const REFERENCE_LIMIT = MAX_REFERENCES;

const SOURCES: ReadonlySet<string> = new Set(["explicit", "matched", "default", "override", "migrated", "reserved", "none"]);

/**
 * A binding read back from a meta file, validated: it is read from disk, so
 * anything unexpected is dropped (the session is then treated as pre-dating
 * workstreams and resolved again on resume — fail toward re-deciding, never
 * toward trusting a malformed home).
 */
export function readWorkstreamBinding(raw: unknown): WorkstreamBinding | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.source !== "string" || !SOURCES.has(r.source)) return undefined;
  if (typeof r.revision !== "string" || r.revision.length > 128) return undefined;
  if (r.id !== undefined && (typeof r.id !== "string" || !ID.test(r.id))) return undefined;
  if (r.matchedBy !== undefined && (typeof r.matchedBy !== "string" || r.matchedBy.length > 1024)) return undefined;
  if ((r.source === "none") !== (r.id === undefined)) return undefined;
  // References and the read-from record fail the whole binding when malformed:
  // a reference dropped silently would be harmless, but a read-from entry
  // dropped would let a later move skip a share policy.
  let references: WorkstreamReference[] | undefined;
  if (r.references !== undefined) {
    if (!Array.isArray(r.references) || r.references.length > MAX_REFERENCES) return undefined;
    references = [];
    for (const raw of r.references) {
      const ref = readReference(raw);
      if (!ref) return undefined;
      references.push(ref);
    }
  }
  let readFrom: string[] | undefined;
  if (r.readFrom !== undefined) {
    if (!Array.isArray(r.readFrom) || r.readFrom.length > 256 || !r.readFrom.every((x) => typeof x === "string" && ID.test(x))) return undefined;
    readFrom = [...new Set(r.readFrom as string[])];
  }
  return {
    ...(typeof r.id === "string" ? { id: r.id } : {}),
    source: r.source as WorkstreamSource,
    ...(typeof r.matchedBy === "string" ? { matchedBy: r.matchedBy } : {}),
    revision: r.revision,
    ...(references && references.length > 0 ? { references } : {}),
    ...(readFrom && readFrom.length > 0 ? { readFrom } : {}),
    ...(r.sealed === true ? { sealed: true as const } : {}),
  };
}
