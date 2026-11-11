/**
 * WorkstreamService — the daemon's view of the `workstreams` block
 * (docs/workstreams-design.md).
 *
 * Owns: the effective (bases-merged) workstreams, the config revision, and
 * deciding a session's home — at create (§5.1, §5.2) and at resume (G5).
 * Never owns a session's binding: that lives in the session's meta and sticks.
 *
 * W0 records and shows. Nothing here changes what a session is given yet;
 * enforcement (servers, credentials, env) is W1.
 */

import { createHash } from "node:crypto";
import type {
  SessionWorkstreamInfo,
  WorkstreamResolution,
  WorkstreamSummary,
} from "../../protocol/types.js";
import { effectiveWorkstreams, type EffectiveWorkstream } from "./effective.js";
import { FolderReader } from "./folder.js";
import { expandHome, type MatchableWorkstream, matchFolder } from "./match.js";
import type { WorkstreamsConfig } from "./schema.js";
import type { WorkstreamBinding } from "./binding.js";

export { readWorkstreamBinding, type WorkstreamBinding } from "./binding.js";

/** The reserved home of the conductor (§10). */
export const CONDUCTOR_WORKSTREAM = "conductor";

export type CreateBinding =
  | { ok: true; binding: WorkstreamBinding | undefined; resolution?: WorkstreamResolution; warnings: string[] }
  | { ok: false; kind: "workstream_conflict" | "workstream_ambiguous"; resolution: WorkstreamResolution; error: string }
  | { ok: false; kind: "workstream_unknown"; workstream: string; error: string };

export class WorkstreamService {
  #cfg: WorkstreamsConfig;
  #effective: Map<string, EffectiveWorkstream>;
  #matchables: MatchableWorkstream[];
  /** expanded path rule → the rule as written (for `matchedBy`). */
  #written = new Map<string, string>();
  #revision: string;
  #reader: FolderReader;

  constructor(cfg: WorkstreamsConfig | undefined, reader: FolderReader = new FolderReader()) {
    this.#reader = reader;
    this.#cfg = cfg ?? { isolateGlobalServers: false, items: [] };
    this.#effective = new Map();
    this.#matchables = [];
    this.#revision = "";
    this.#load(this.#cfg);
  }

  #load(cfg: WorkstreamsConfig): void {
    this.#cfg = cfg;
    this.#effective = effectiveWorkstreams(cfg.items);
    this.#written.clear();
    this.#matchables = [...this.#effective.values()].map((w) => ({
      id: w.id,
      abstract: w.abstract,
      claim: w.claim,
      paths: w.match.paths.map((p) => {
        const expanded = expandHome(p, this.#reader.home);
        this.#written.set(expanded, p);
        return expanded;
      }),
      remotes: w.match.remotes,
    }));
    this.#revision = createHash("sha256").update(JSON.stringify(cfg)).digest("hex").slice(0, 16);
  }

  /** Replace the config (a settings write, W2). Live sessions keep their bindings. */
  update(cfg: WorkstreamsConfig): void {
    this.#load(cfg);
  }

  /** Any workstream configured at all. With none, the daemon behaves as before workstreams. */
  get configured(): boolean {
    return this.#cfg.items.length > 0;
  }

  get revision(): string {
    return this.#revision;
  }

  get isolateGlobalServers(): boolean {
    return this.#cfg.isolateGlobalServers;
  }

  get defaultId(): string | undefined {
    return this.#cfg.default;
  }

  get(id: string): EffectiveWorkstream | undefined {
    return this.#effective.get(id);
  }

  summaries(): WorkstreamSummary[] {
    return [...this.#effective.values()].map((w) => ({
      id: w.id,
      name: w.name,
      ...(w.color ? { color: w.color } : {}),
      abstract: w.abstract,
      extends: w.extends,
      claim: w.claim,
      allowOverride: w.allowOverride,
      share: w.share,
      match: w.match,
      servers: w.servers.map((s) => ({ ...s })),
      accounts: { ...w.accounts },
      defaults: { ...w.defaults },
      env: Object.keys(w.env),
      ...(w.git ? { git: { ...w.git } } : {}),
      skillDirs: [...w.skillDirs],
    }));
  }

  /** What `workdir` (an absolute, existing folder) resolves to, with an optional explicit choice. */
  resolve(workdir: string, explicit?: string): WorkstreamResolution {
    const pathRules = this.#matchables.flatMap((m) => m.paths);
    const wantRemotes = this.#matchables.some((m) => m.remotes.length > 0);
    const facts = this.#reader.facts(workdir, pathRules, wantRemotes);
    const m = matchFolder(this.#matchables, facts);
    const candidates = m.candidates.map((c) => ({
      workstream: c.workstream,
      rule: c.kind === "path" ? (this.#written.get(c.rule) ?? c.rule) : c.rule,
      kind: c.kind,
      ...(c.via ? { via: c.via } : {}),
      claim: c.claim,
    }));
    const matchedBy = (ws: string): string | undefined => {
      const c = candidates.find((x) => x.workstream === ws);
      return c ? (c.kind === "remote" ? `remote ${c.rule}${c.via === "upstream" ? " (upstream)" : ""}` : c.rule) : undefined;
    };

    if (explicit !== undefined) {
      // The folder's claimant: the best match if exclusive; else, among tied
      // best matches, the first exclusive one the choice isn't.
      const claimant =
        m.best?.claim === "exclusive"
          ? m.best.workstream
          : m.ambiguous && !m.ambiguous.includes(explicit)
            ? m.candidates.find((c) => m.ambiguous?.includes(c.workstream) && c.claim === "exclusive")?.workstream
            : undefined;
      const base = { candidates, ...(m.ambiguous ? { ambiguous: m.ambiguous } : {}) };
      if (claimant && claimant !== explicit) {
        return {
          home: explicit,
          source: "explicit",
          ...base,
          conflict: { folder: claimant, chosen: explicit, overridable: this.#effective.get(claimant)?.allowOverride ?? true },
        };
      }
      const by = matchedBy(explicit);
      return { home: explicit, source: "explicit", ...(by ? { matchedBy: by } : {}), ...base };
    }
    if (m.best) return { home: m.best.workstream, source: "matched", matchedBy: matchedBy(m.best.workstream), candidates };
    if (m.ambiguous) return { source: "none", candidates, ambiguous: m.ambiguous };
    if (this.#cfg.default) return { home: this.#cfg.default, source: "default", candidates };
    return { source: "none", candidates };
  }

  /**
   * The home for a new session. Undefined when no workstreams are configured
   * (the session carries no binding at all, exactly as before).
   *
   * Refuses: an unknown or base workstream; a choice past an exclusive claim
   * (W1 adds the confirmed override, G3). A folder two workstreams tie on,
   * with no choice, gets no home and a warning: W1 requires the choice once
   * isolation is on.
   */
  forCreate(workdir: string, explicit?: string): CreateBinding {
    if (explicit !== undefined) {
      const ws = this.#effective.get(explicit);
      if (!ws || ws.abstract) {
        return {
          ok: false,
          kind: "workstream_unknown",
          workstream: explicit,
          error: ws ? `"${explicit}" is a base workstream: it has no sessions of its own` : `Unknown workstream "${explicit}" — see \`codeoid workstream ls\``,
        };
      }
    }
    if (!this.configured) return { ok: true, binding: undefined, warnings: [] };
    const resolution = this.resolve(workdir, explicit);
    if (resolution.conflict) {
      const c = resolution.conflict;
      return {
        ok: false,
        kind: "workstream_conflict",
        resolution,
        error: `This folder belongs to workstream "${c.folder}" (exclusive). Start the session in "${c.folder}", or choose a folder outside it for "${c.chosen}".`,
      };
    }
    const warnings: string[] = [];
    if (resolution.ambiguous) {
      warnings.push(`Workstreams ${resolution.ambiguous.map((a) => `"${a}"`).join(" and ")} both match this folder equally — the session has no workstream. Choose one, or make one rule more specific.`);
    }
    return { ok: true, binding: this.#bind(resolution), resolution, warnings };
  }

  /** A child or fork keeps its parent's home (G5), under the current revision. */
  inherit(parent: WorkstreamBinding | undefined): WorkstreamBinding | undefined {
    return parent ? { ...parent } : undefined;
  }

  /** The conductor's home (§10): reserved, never matched. */
  conductorBinding(): WorkstreamBinding | undefined {
    if (!this.configured) return undefined;
    return { id: CONDUCTOR_WORKSTREAM, source: "reserved", revision: this.#revision };
  }

  /**
   * The home of a session coming back from disk (G5). A stored binding is
   * kept as it is — the folder is never matched again. A session from before
   * workstreams is resolved once by its folder and marked `migrated`; with
   * nothing matching and no default it has no home (fail closed, G5).
   */
  forResume(stored: WorkstreamBinding | undefined, workdir: string, role?: string): { binding: WorkstreamBinding | undefined; migrated: boolean } {
    if (stored) return { binding: stored, migrated: false };
    if (!this.configured) return { binding: undefined, migrated: false };
    if (role === "conductor") return { binding: this.conductorBinding(), migrated: true };
    let resolution: WorkstreamResolution;
    try {
      resolution = this.resolve(workdir);
    } catch {
      resolution = { source: "none", candidates: [] };
    }
    const bound = this.#bind(resolution);
    return { binding: bound ? { ...bound, source: bound.id ? "migrated" : "none" } : undefined, migrated: true };
  }

  #bind(r: WorkstreamResolution): WorkstreamBinding {
    if (r.home === undefined) return { source: "none", revision: this.#revision };
    return { id: r.home, source: r.source, ...(r.matchedBy ? { matchedBy: r.matchedBy } : {}), revision: this.#revision };
  }

  /** What `SessionInfo.workstream` carries for a binding. */
  info(binding: WorkstreamBinding | undefined): SessionWorkstreamInfo | undefined {
    if (!binding) return undefined;
    if (binding.id === undefined) return { source: binding.source };
    if (binding.id === CONDUCTOR_WORKSTREAM && binding.source === "reserved") {
      return { id: CONDUCTOR_WORKSTREAM, name: "Conductor", source: "reserved" };
    }
    const ws = this.#effective.get(binding.id);
    return {
      id: binding.id,
      ...(ws ? { name: ws.name, ...(ws.color ? { color: ws.color } : {}) } : { orphaned: true }),
      source: binding.source,
      ...(binding.matchedBy ? { matchedBy: binding.matchedBy } : {}),
    };
  }
}
