/**
 * `codeoid workstream import` (docs/workstreams-design.md §13, "Moving off
 * today's setup"): a PROPOSAL from what is already on disk — repositories
 * grouped by their remote's owner, and the MCP servers in Claude's global
 * config, none of them assigned. Writes nothing: the owner reviews, edits and
 * saves it, and only then turns isolation on.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { FolderReader } from "./folder.js";

export interface ImportProposal {
  /** Proposed workstreams, by remote owner. */
  items: Array<{ id: string; name: string; match: { remotes: string[] }; folders: string[] }>;
  /** Folders with no remote any rule could name. */
  unmatched: string[];
  /** Server names from Claude's global config: assign each to the workstreams that should reach it. */
  globalServers: string[];
}

/** A config id from a remote owner: lowercase, dashes, at most 64. */
function idOf(owner: string): string {
  const id = owner.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/, "");
  return id.length > 0 ? id : "repos";
}

export function proposeWorkstreams(roots: readonly string[], globalServers: readonly string[], reader = new FolderReader()): ImportProposal {
  const byOwner = new Map<string, { host: string; owner: string; folders: string[] }>();
  const unmatched: string[] = [];
  for (const root of roots) {
    let names: string[];
    try {
      names = readdirSync(root).filter((n) => !n.startsWith("."));
    } catch {
      continue;
    }
    for (const n of names.sort()) {
      const dir = join(root, n);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      const remote = reader.remotes(dir).origin;
      const parts = remote?.split("/");
      if (!parts || parts.length < 3) {
        unmatched.push(dir);
        continue;
      }
      const key = `${parts[0]}/${parts[1]}`;
      const group = byOwner.get(key) ?? { host: parts[0]!, owner: parts[1]!, folders: [] };
      group.folders.push(dir);
      byOwner.set(key, group);
    }
  }
  const used = new Set<string>();
  const items = [...byOwner.values()]
    .sort((a, b) => b.folders.length - a.folders.length || a.owner.localeCompare(b.owner))
    .map((g) => {
      let id = idOf(g.owner);
      for (let i = 2; used.has(id); i++) id = `${idOf(g.owner).slice(0, 60)}-${i}`;
      used.add(id);
      return { id, name: g.owner, match: { remotes: [`${g.host}/${g.owner}/*`] }, folders: g.folders };
    });
  return { items, unmatched, globalServers: [...globalServers].sort() };
}
