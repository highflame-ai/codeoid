/**
 * The workstream fence at the tool gate (docs/workstreams-design.md §7.3):
 * a file tool reading or searching another workstream's folder, or writing
 * one or a reference (read-only), is refused — in every mode, on every
 * backend, sandboxed or not. The sandbox fences commands (its hidden paths);
 * this fences the file tools that run outside it and every tool of a session
 * without one.
 *
 * Pure: the fence comes from the session (WorkstreamService.fenceFor).
 */

import { realpathSync } from "node:fs";
import { writeTargets } from "../held-writes.js";
import { isSearchTool, toolPathForms, toolReadPaths } from "../secret-paths.js";
import { within } from "./folders.js";
import type { WorkstreamFence } from "./service.js";

export interface FenceRefusal {
  /** The path as the call named it. */
  path: string;
  /** The workstream whose folder it is. */
  workstream: string;
  kind: "read" | "search" | "write" | "write_reference";
}

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Each fenced folder in both spellings: as found and real. */
function forms(folders: readonly string[]): string[] {
  return [...new Set(folders.flatMap((f) => [f, realOr(f)]))];
}

/**
 * The fence's verdict on one call: null when it stays out of other
 * workstreams' folders (and writes no reference), else why not.
 */
export function fenceRefusal(toolName: string, input: unknown, opts: { workdir: string; cwd?: string | null; fence: WorkstreamFence }): FenceRefusal | null {
  const base = typeof opts.cwd === "string" ? opts.cwd : opts.workdir;
  const foreign = opts.fence.foreign.map((f) => ({ workstream: f.workstream, folders: forms(f.folders) }));
  const references = opts.fence.references.map((r) => ({ workstream: r.workstream, folders: forms(r.folders) }));
  const home = forms(opts.fence.home);
  const inForeign = (p: string) => foreign.find((f) => f.folders.some((d) => within(p, d)));
  // Writes first: a write tool's path is also a read key, and the refusal should say it writes.
  const writes = input && typeof input === "object" ? writeTargets(toolName, input as Record<string, unknown>) : null;
  for (const raw of writes ?? []) {
    if (!raw) continue;
    for (const p of toolPathForms(raw, base)) {
      const hit = inForeign(p);
      if (hit) return { path: raw, workstream: hit.workstream, kind: "write" };
      // A reference is read-only; a folder of the home's inside one is the home's.
      const ref = references.find((r) => r.folders.some((d) => within(p, d)));
      if (ref && !home.some((h) => within(p, h))) return { path: raw, workstream: ref.workstream, kind: "write_reference" };
    }
  }
  const search = isSearchTool(toolName);
  for (const raw of toolReadPaths(toolName, input)) {
    for (const p of toolPathForms(raw, base)) {
      const hit = inForeign(p);
      if (hit) return { path: raw, workstream: hit.workstream, kind: "read" };
      // A search whose root holds a fenced folder reads into it.
      if (search) {
        const holds = foreign.find((f) => f.folders.some((d) => within(d, p)));
        if (holds) return { path: raw, workstream: holds.workstream, kind: "search" };
      }
    }
  }
  return null;
}

/** What the agent is told. */
export function fenceRefusalText(r: FenceRefusal): string {
  switch (r.kind) {
    case "read":
      return `${r.path} is in workstream "${r.workstream}"'s folders, which this session's workstream may not read. Ask the owner to add a reference to "${r.workstream}" if it should.`;
    case "search":
      return `Searching ${r.path} would read workstream "${r.workstream}"'s folders, which this session's workstream may not read: search a narrower folder.`;
    case "write":
      return `${r.path} is in workstream "${r.workstream}"'s folders: this session's workstream may not write there.`;
    case "write_reference":
      return `${r.path} is in workstream "${r.workstream}", which this session references read-only: write in the session's own workstream instead.`;
  }
}
