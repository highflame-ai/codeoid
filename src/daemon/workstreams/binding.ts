/**
 * A session's home workstream as persisted in its meta file
 * (`TranscriptMeta.workstream`, docs/workstreams-design.md G5). Kept apart from
 * the service so the transcript store can carry it without importing matching.
 */

import type { WorkstreamSource } from "../../protocol/types.js";

/** A session's home, as persisted in its meta (TranscriptMeta.workstream). */
export interface WorkstreamBinding {
  /** Absent = no home (`source: "none"`). */
  id?: string;
  source: WorkstreamSource;
  matchedBy?: string;
  /** The config revision the binding was made under. */
  revision: string;
}

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
  if (r.id !== undefined && (typeof r.id !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(r.id))) return undefined;
  if (r.matchedBy !== undefined && (typeof r.matchedBy !== "string" || r.matchedBy.length > 1024)) return undefined;
  if ((r.source === "none") !== (r.id === undefined)) return undefined;
  return {
    ...(typeof r.id === "string" ? { id: r.id } : {}),
    source: r.source as WorkstreamSource,
    ...(typeof r.matchedBy === "string" ? { matchedBy: r.matchedBy } : {}),
    revision: r.revision,
  };
}
