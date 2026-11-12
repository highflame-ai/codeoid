/**
 * A workstream with its bases merged in (docs/workstreams-design.md §6.5,
 * case 3).
 *
 * Merge rules:
 *  - lists (servers, skill dirs) are unioned in `extends` order, the
 *    workstream's own entries last; a later entry for the same server
 *    replaces an earlier one (so a workstream can give an inherited server
 *    its own credential);
 *  - maps (env, accounts) and scalars (defaults, git fields) are overridden by
 *    the most specific setting;
 *  - `exclude` is applied after the merge;
 *  - `match`, `claim`, `share` and `allowOverride` are never inherited: they
 *    describe this workstream's own folders.
 *
 * The config was validated (no cycles, every base exists) before this runs;
 * the visited set is a backstop, never the check.
 */

import type { WorkstreamItemConfig, WorkstreamServerRef } from "./schema.js";

export interface EffectiveServer {
  server: string;
  /** Credential slot; absent = the server's default sign-in. */
  credential?: string;
  /** Which workstream contributed it (itself or a base). */
  from: string;
}

export interface EffectiveWorkstream {
  id: string;
  name: string;
  color?: string;
  abstract: boolean;
  extends: string[];
  claim: "exclusive" | "suggest";
  allowOverride: boolean;
  share: "open" | "ask" | "closed";
  match: { paths: string[]; remotes: string[] };
  servers: EffectiveServer[];
  accounts: Record<string, string>;
  defaults: { provider?: string; model?: string; effort?: WorkstreamItemConfig["defaults"]["effort"] };
  env: Record<string, { secret: string }>;
  git?: { name?: string; email?: string };
  skillDirs: string[];
}

function refName(ref: WorkstreamServerRef): { server: string; credential?: string } {
  if (typeof ref === "string") return { server: ref.startsWith("+") ? ref.slice(1) : ref };
  return { server: ref.server.startsWith("+") ? ref.server.slice(1) : ref.server, ...(ref.credential ? { credential: ref.credential } : {}) };
}

export function effectiveWorkstreams(items: readonly WorkstreamItemConfig[]): Map<string, EffectiveWorkstream> {
  const byId = new Map(items.map((i) => [i.id, i] as const));
  const out = new Map<string, EffectiveWorkstream>();

  const build = (id: string, visiting: Set<string>): EffectiveWorkstream | undefined => {
    const done = out.get(id);
    if (done) return done;
    const item = byId.get(id);
    if (!item || visiting.has(id)) return undefined;
    visiting.add(id);

    const servers = new Map<string, EffectiveServer>();
    const skillDirs: string[] = [];
    let accounts: Record<string, string> = {};
    let defaults: EffectiveWorkstream["defaults"] = {};
    let env: Record<string, { secret: string }> = {};
    let git: EffectiveWorkstream["git"];

    const layer = (
      from: string,
      layerServers: Iterable<EffectiveServer | { server: string; credential?: string }>,
      dirs: readonly string[],
      acc: Record<string, string>,
      def: EffectiveWorkstream["defaults"],
      e: Record<string, { secret: string }>,
      g: EffectiveWorkstream["git"],
    ): void => {
      for (const s of layerServers) {
        servers.delete(s.server); // re-insert so the most specific entry also sits last
        servers.set(s.server, { server: s.server, ...(s.credential ? { credential: s.credential } : {}), from: "from" in s ? s.from : from });
      }
      for (const d of dirs) if (!skillDirs.includes(d)) skillDirs.push(d);
      accounts = { ...accounts, ...acc };
      defaults = { ...defaults, ...Object.fromEntries(Object.entries(def).filter(([, v]) => v !== undefined)) };
      env = { ...env, ...e };
      if (g) git = { ...(git ?? {}), ...Object.fromEntries(Object.entries(g).filter(([, v]) => v !== undefined)) };
    };

    for (const baseId of item.extends) {
      const base = build(baseId, visiting);
      if (base) layer(base.id, base.servers, base.skillDirs, base.accounts, base.defaults, base.env, base.git);
    }
    layer(id, item.mcpServers.map(refName), item.skillDirs, item.accounts, item.defaults, item.env, item.git);

    const excluded = new Set(item.exclude.map((x) => (x.startsWith("+") ? x.slice(1) : x)));
    const eff: EffectiveWorkstream = {
      id,
      name: item.name ?? id,
      ...(item.color ? { color: item.color } : {}),
      abstract: item.abstract,
      extends: [...item.extends],
      claim: item.claim,
      allowOverride: item.allowOverride,
      share: item.share,
      match: { paths: [...item.match.paths], remotes: [...item.match.remotes] },
      servers: [...servers.values()].filter((s) => !excluded.has(s.server)),
      accounts,
      defaults,
      env: Object.fromEntries(Object.entries(env).filter(([k]) => !excluded.has(k))),
      ...(git ? { git } : {}),
      skillDirs: skillDirs.filter((d) => !excluded.has(d)),
    };
    visiting.delete(id);
    out.set(id, eff);
    return eff;
  };

  for (const item of items) build(item.id, new Set());
  return out;
}
