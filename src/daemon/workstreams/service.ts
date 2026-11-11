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
import { realpathSync } from "node:fs";
import type { SessionWorkstreamInfo, WorkstreamResolution, WorkstreamSummary } from "../../protocol/types.js";
import { readWorkstreamBinding, type WorkstreamBinding } from "./binding.js";
import { expandPathRule, outermost, within } from "./folders.js";
import { effectiveWorkstreams, type EffectiveWorkstream } from "./effective.js";
import { FolderReader } from "./folder.js";
import { expandHome, type MatchableWorkstream, matchFolder, normalizePathRule } from "./match.js";
import type { WorkstreamsConfig } from "./schema.js";
import type { SecretStore } from "../credentials/store.js";
import type { CredentialDecl } from "../credentials/schema.js";
import type { GrantCredential, McpGrant } from "./grant.js";

export { readWorkstreamBinding, type WorkstreamBinding, type WorkstreamReference } from "./binding.js";

/**
 * A session's read fence (§7.3): the folders it may read (its home's, and
 * its references'), and every other workstream's, which it may not. Built
 * from the folders on this machine; `limits` says what couldn't be expanded.
 */
export interface WorkstreamFence {
  workstream?: string;
  /** The home's folders: readable and, as the sandbox allows, writable. */
  home: string[];
  /** Readable only, never written. */
  references: Array<{ workstream: string; folders: string[] }>;
  /** Neither read nor written: every other workstream's folders that hold none of the above. */
  foreign: Array<{ workstream: string; folders: string[] }>;
  limits: string[];
}

/** What a share policy says to a read or a move: allowed, the owner asked, or refused (with why). */
export type ShareVerdict = { ok: true; ask: string[] } | { ok: false; error: string };

/** The reserved home of the conductor (§10). */
export const CONDUCTOR_WORKSTREAM = "conductor";

export type CreateBinding =
  | { ok: true; binding: WorkstreamBinding | undefined; resolution?: WorkstreamResolution; warnings: string[] }
  | { ok: false; kind: "workstream_conflict" | "workstream_required"; resolution: WorkstreamResolution; error: string }
  | { ok: false; kind: "workstream_unknown"; workstream: string; error: string };

/** What a meta on disk says about its session, for the resume pre-pass. */
export interface ResumeMetaFacts {
  sessionId: string;
  workdir: string;
  role?: string;
  /** The meta's `workstream` value, unvalidated; absent = it predates workstreams. */
  stored: unknown;
  /** A fork's or collaboration child's parent session id. */
  parentId?: string;
}

export class WorkstreamService {
  #cfg: WorkstreamsConfig;
  #effective: Map<string, EffectiveWorkstream>;
  #matchables: MatchableWorkstream[];
  /** Expanded (and real-head) path rule → the rule as written, for `matchedBy`. */
  #written = new Map<string, string>();
  #revision: string;
  #reader: FolderReader;
  #credentials = new Map<string, CredentialDecl>();

  constructor(cfg: WorkstreamsConfig | undefined, reader: FolderReader = new FolderReader(), credentials: readonly CredentialDecl[] = []) {
    this.#reader = reader;
    for (const c of credentials) this.#credentials.set(c.id, c);
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
      paths: w.match.paths.flatMap((p) => this.#pathRuleForms(p)),
      remotes: w.match.remotes.map((r) => r.toLowerCase()),
    }));
    // The credentials too: a credential edit changes what sessions get, and clients skip a repeated revision.
    this.#revision = createHash("sha256").update(JSON.stringify([cfg, [...this.#credentials.values()]])).digest("hex").slice(0, 16);
  }

  /**
   * The forms a path rule matches in: as written (`~` expanded, trailing `/`
   * and `/**` dropped — they mean the same folder) and, for a `~` rule, with
   * the home's real path when the home is a symlink, so `~/Workspace/x`
   * matches a canonical workdir.
   *
   * Only `~` is resolved, never the rest of a rule's fixed part: a folder a
   * rule names that doesn't exist yet (or that an agent can replace) would
   * otherwise become a link someone else points, re-homing another
   * workstream's folder at the next start (W0 audit round 2). The home is the
   * daemon's own; anyone who can replace it has every credential anyway.
   */
  #pathRuleForms(written: string): string[] {
    const forms = [normalizePathRule(expandHome(written, this.#reader.home))];
    if (written === "~" || written.startsWith("~/")) {
      const realHome = this.#realHome();
      if (realHome !== this.#reader.home) forms.push(normalizePathRule(expandHome(written, realHome)));
    }
    for (const f of forms) this.#written.set(f, written);
    return forms;
  }

  #realHome(): string {
    try {
      return realpathSync(this.#reader.home);
    } catch {
      return this.#reader.home;
    }
  }

  /** Replace the config (a settings write, W2). Live sessions keep their bindings. */
  update(cfg: WorkstreamsConfig, credentials?: readonly CredentialDecl[]): void {
    if (credentials) this.#credentials = new Map(credentials.map((c) => [c.id, c]));
    this.#load(cfg);
  }

  /**
   * What a session homed by `binding` may reach over MCP (grant.ts), or
   * undefined when isolation is off — every session then keeps today's
   * servers. Read live by the session's view and the hub, so a server
   * removed from a workstream stops on the next call (G4).
   */
  grantFor(binding: WorkstreamBinding | undefined): McpGrant | undefined {
    if (!this.configured || !this.#cfg.isolateGlobalServers) return undefined;
    const ws = binding?.id && binding.source !== "reserved" ? this.#effective.get(binding.id) : undefined;
    if (!ws) return { ...(binding?.id ? { workstream: binding.id } : {}), servers: new Map(), workdirServers: false };
    const servers = new Map<string, { credential?: GrantCredential; oauthSlot?: string }>();
    for (const s of ws.servers) {
      const decl = s.credential ? this.#credentials.get(s.credential) : undefined;
      if (s.credential && !decl) continue; // validated at load; a config edit that drops one fails closed
      if (!decl) servers.set(s.server, {});
      else if (decl.kind === "bearer") servers.set(s.server, { credential: { id: decl.id } });
      else if (decl.kind === "header") servers.set(s.server, { credential: { id: decl.id, header: decl.header } });
      else if (decl.kind === "oauth") servers.set(s.server, { oauthSlot: decl.id });
    }
    return { workstream: ws.id, servers, workdirServers: binding?.source !== "override" };
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

  /**
   * A workstream's folders on this machine: the directories its path rules
   * name (each spelling: as written and, for `~`, the home's real path), plus
   * `recorded` (folders recorded as its home, repository tops).
   */
  foldersOf(id: string, recorded: readonly string[] = []): { folders: string[]; limits: string[] } {
    const m = this.#matchables.find((x) => x.id === id);
    if (!m || m.abstract) return { folders: [], limits: [] };
    const limits: string[] = [];
    const found: string[] = [...recorded];
    for (const rule of m.paths) {
      const e = expandPathRule(rule);
      found.push(...e.folders);
      limits.push(...e.limits);
    }
    return { folders: outermost(found), limits };
  }

  /**
   * The read fence of a session homed by `binding`, or undefined when
   * isolation is off (nothing is fenced then, as before W3). `recorded(id)`
   * gives a workstream's recorded home folders.
   */
  fenceFor(binding: WorkstreamBinding | undefined, recorded: (id: string) => readonly string[] = () => []): WorkstreamFence | undefined {
    if (!this.configured || !this.#cfg.isolateGlobalServers) return undefined;
    const limits: string[] = [];
    const homeId = binding?.id && binding.source !== "reserved" && this.#effective.has(binding.id) ? binding.id : undefined;
    const of = (id: string) => {
      const r = this.foldersOf(id, recorded(id));
      limits.push(...r.limits);
      return r.folders;
    };
    const home = homeId ? of(homeId) : [];
    const references: WorkstreamFence["references"] = [];
    for (const ref of binding?.references ?? []) {
      const ws = this.#effective.get(ref.workstream);
      // A reference whose workstream is gone or closed now gives nothing (§8).
      if (!ws || ws.abstract || ws.share === "closed" || ref.workstream === homeId) continue;
      const all = of(ref.workstream);
      const folders = ref.paths ? ref.paths.filter((p) => all.some((f) => within(p, f))) : all;
      // Kept with no folders here too: it still gives its memory (§7.2).
      references.push({ workstream: ref.workstream, folders });
    }
    const readable = [...home, ...references.flatMap((r) => r.folders)];
    const foreign: WorkstreamFence["foreign"] = [];
    for (const ws of this.#effective.values()) {
      if (ws.abstract || ws.id === homeId) continue;
      // A folder holding a readable one can't be fenced off without fencing
      // that too: the more specific rule made it the home's or a reference's.
      const folders = of(ws.id).filter((f) => !readable.some((r) => within(r, f) || within(f, r)));
      if (folders.length > 0) foreign.push({ workstream: ws.id, folders });
    }
    return { ...(homeId ? { workstream: homeId } : {}), home, references, foreign, limits: [...new Set(limits)] };
  }

  /**
   * Whether a session homed in `home` may read `target` (a reference,
   * §7.1): `open` yes, `ask` with its owner's confirm, `closed` never.
   */
  referenceVerdict(home: string | undefined, ref: { workstream: string; paths?: readonly string[] }, recorded: readonly string[] = []): ShareVerdict {
    const ws = this.#effective.get(ref.workstream);
    if (!ws) return { ok: false, error: `Unknown workstream "${ref.workstream}"` };
    if (ws.abstract) return { ok: false, error: `"${ws.id}" is a base workstream: it has no folders of its own` };
    if (ws.id === home) return { ok: false, error: `"${ws.id}" is this session's own workstream` };
    if (ws.share === "closed") return { ok: false, error: `Workstream "${ws.id}" is closed: other workstreams can't read it` };
    if (ref.paths) {
      const { folders } = this.foldersOf(ws.id, recorded);
      const outside = ref.paths.filter((p) => !folders.some((f) => within(p, f)));
      if (outside.length > 0) return { ok: false, error: `Not ${ws.id}'s folders: ${outside.join(", ")}` };
    }
    return { ok: true, ask: ws.share === "ask" ? [ws.id] : [] };
  }

  /**
   * Whether a session may move to `target` (§5.3): a move carries its whole
   * transcript, so it is a share from the old home and from every workstream
   * it has read from. From no home or the default workstream it is always
   * allowed.
   */
  moveVerdict(binding: WorkstreamBinding | undefined, target: string): ShareVerdict {
    const problem = this.choiceProblem(target);
    if (problem) return { ok: false, error: problem };
    if (binding?.source === "reserved") return { ok: false, error: "The conductor's home can't be changed" };
    const from = new Set<string>(binding?.readFrom ?? []);
    if (binding?.id && binding.id !== this.#cfg.default) from.add(binding.id);
    from.delete(target);
    const ask: string[] = [];
    for (const id of [...from].sort()) {
      const ws = this.#effective.get(id);
      // A workstream since deleted has no policy left to keep.
      if (!ws) continue;
      if (ws.share === "closed") {
        return { ok: false, error: id === binding?.id ? `Workstream "${id}" is closed: its sessions can't move to another` : `This session read from "${id}", which is closed: it can't move to another workstream` };
      }
      if (ws.share === "ask") ask.push(id);
    }
    return { ok: true, ask };
  }

  /** Why `id` can't be chosen as a home, or undefined when it can. */
  choiceProblem(id: string): string | undefined {
    const ws = this.#effective.get(id);
    if (!ws) return `Unknown workstream "${id}" — see \`codeoid workstream ls\``;
    if (ws.abstract) return `"${id}" is a base workstream: it has no sessions of its own`;
    return undefined;
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
      config: structuredClone((this.#cfg.items.find((i) => i.id === w.id) ?? {}) as Record<string, unknown>),
    }));
  }

  /**
   * What `workdir` (an absolute, existing folder, canonical) resolves to,
   * with an optional explicit choice. `given` is the path as the caller wrote
   * it (`~` expanded), matched too: a rule written through a symlink matches
   * the folder reached through it.
   *
   * When the spellings disagree — the given path matches one workstream and
   * the real path another — the folder gets no home until one is chosen: a
   * link someone planted must never decide the home (W0 audit).
   */
  resolve(workdir: string, explicit?: string, given?: string): WorkstreamResolution {
    const wantRemotes = this.#matchables.some((m) => m.remotes.length > 0);
    const facts = this.#reader.facts(workdir, wantRemotes);
    const spellings = [...new Set([...(given ? [given] : []), ...facts.paths])];
    const m = matchFolder(this.#matchables, { ...facts, paths: spellings });
    // Each spelling on its own (remotes belong to the folder, so they count once, in `m`).
    const perSpelling = new Set(
      spellings.map((p) => matchFolder(this.#matchables, { paths: [p] }).best?.workstream).filter((x): x is string => x !== undefined),
    );
    const disagree = perSpelling.size > 1 ? [...perSpelling].sort() : undefined;
    const ambiguous = disagree ?? m.ambiguous;
    const best = disagree ? undefined : m.best;

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
      // The folder's claimant: the best match when it is exclusive; else, among
      // those tied or disagreeing, an exclusive one other than the choice —
      // unless the choice is itself one of the tied exclusives: a tie means
      // neither outranks the other, so choosing one settles it. A
      // suggestion chosen against an exclusive it ties with waives nothing.
      const tiedExclusive = (id: string) => ambiguous?.includes(id) && candidates.some((c) => c.workstream === id && c.claim === "exclusive");
      const claimant =
        best?.claim === "exclusive"
          ? best.workstream
          : ambiguous && !tiedExclusive(explicit)
            ? candidates.find((c) => ambiguous.includes(c.workstream) && c.workstream !== explicit && c.claim === "exclusive")?.workstream
            : undefined;
      const base = { candidates, ...(ambiguous ? { ambiguous } : {}) };
      if (claimant && claimant !== explicit) {
        return {
          home: explicit,
          source: "explicit",
          ...base,
          conflict: {
            folder: claimant,
            chosen: explicit,
            overridable: this.#effective.get(claimant)?.allowOverride ?? true,
            changes: this.#overrideChanges(claimant, explicit),
          },
        };
      }
      const by = matchedBy(explicit);
      return { home: explicit, source: "explicit", ...(by ? { matchedBy: by } : {}), ...base };
    }
    if (best) return { home: best.workstream, source: "matched", matchedBy: matchedBy(best.workstream), candidates };
    if (ambiguous) return { source: "none", candidates, ambiguous };
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
  /** What homing a session in `chosen` instead of `folder` gives and withholds (§5.2 (c)). */
  #overrideChanges(folder: string, chosen: string): { gains: string[]; withholds: string[]; env: string[]; git?: string } {
    const f = this.#effective.get(folder);
    const c = this.#effective.get(chosen);
    const cs = new Set(c?.servers.map((s) => s.server) ?? []);
    return {
      gains: [...cs],
      withholds: (f?.servers ?? []).map((s) => s.server).filter((s) => !cs.has(s)),
      env: Object.keys(c?.env ?? {}),
      ...(c?.git?.email ? { git: c.git.email } : {}),
    };
  }

  /**
   * `overridden`: the caller confirmed the choice past an exclusive claim
   * (G3, a redeemed token — checked by the manager). The home is then the
   * choice, `source: "override"`, unless the claimant allows no override.
   */
  forCreate(workdir: string, explicit?: string, given?: string, required = false, overridden = false): CreateBinding {
    if (explicit !== undefined) {
      const problem = this.choiceProblem(explicit);
      if (problem) return { ok: false, kind: "workstream_unknown", workstream: explicit, error: problem };
    }
    if (!this.configured) return { ok: true, binding: undefined, warnings: [] };
    const resolution = this.resolve(workdir, explicit, given);
    if (resolution.conflict && overridden && resolution.conflict.overridable && explicit !== undefined) {
      return { ok: true, binding: { id: explicit, source: "override", revision: this.#revision }, resolution, warnings: [] };
    }
    if (resolution.conflict) {
      const c = resolution.conflict;
      return {
        ok: false,
        kind: "workstream_conflict",
        resolution,
        error: `This folder belongs to workstream "${c.folder}" (exclusive). Start the session in "${c.folder}", or choose a folder outside it for "${c.chosen}".`,
      };
    }
    // Isolated, a home decides everything a session reaches: a folder with
    // none must be given one (§5.1). Sessions the daemon starts itself use
    // forFolder (the manager's), which keeps "no home": built-ins only.
    if (this.#cfg.isolateGlobalServers && resolution.home === undefined && explicit === undefined && required) {
      const ids = [...this.#effective.values()].filter((w) => !w.abstract).map((w) => w.id);
      return {
        ok: false,
        kind: "workstream_required",
        resolution,
        error: `This folder belongs to no workstream${resolution.ambiguous ? ` (${resolution.ambiguous.join(" and ")} both match)` : ""}: choose one (${ids.join(", ")}).`,
      };
    }
    const warnings: string[] = [];
    if (resolution.ambiguous && explicit === undefined) {
      warnings.push(`Workstreams ${resolution.ambiguous.map((a) => `"${a}"`).join(" and ")} both match this folder — the session has no workstream. Choose one, or make one rule more specific.`);
    }
    return { ok: true, binding: this.#bind(resolution), resolution, warnings };
  }

  /** A child or fork keeps its parent's home exactly (G5), revision included. */
  inherit(parent: WorkstreamBinding | undefined): WorkstreamBinding | undefined {
    return parent ? { ...parent } : undefined;
  }

  /** The conductor's home (§10): reserved, never matched. */
  conductorBinding(): WorkstreamBinding | undefined {
    if (!this.configured) return undefined;
    return { id: CONDUCTOR_WORKSTREAM, source: "reserved", revision: this.#revision };
  }

  /**
   * The home of every session coming back from disk (G5), keyed by session
   * id. `persist` = the binding differs from what the meta holds and must be
   * written (once the session has resumed).
   *
   *  - Stored and valid: kept exactly; the folder is never matched again. A
   *    home the config no longer has stays, shown orphaned.
   *  - Stored but malformed, a base workstream, or a reserved home on a
   *    session that isn't the conductor: no home. Never re-resolved — a
   *    tampered or corrupt meta must not turn into "the folder's (or the
   *    default's) credentials" (W0 audit).
   *  - Absent (the session predates workstreams): a fork or collaboration
   *    child takes its parent's home (G5: they inherit), anything else is
   *    resolved once by its folder; with nothing matching and no default it
   *    has no home (fail closed). Marked `migrated`.
   *  - The conductor's is always the reserved home.
   *
   * With no workstreams configured, a stored binding is kept (it applies
   * again if workstreams come back) and nothing is resolved.
   */
  forResume(metas: readonly ResumeMetaFacts[]): (sessionId: string) => { binding: WorkstreamBinding | undefined; persist: boolean } {
    const out = new Map<string, { binding: WorkstreamBinding | undefined; persist: boolean }>();
    const byId = new Map(metas.map((m) => [m.sessionId, m] as const));
    const none = (): WorkstreamBinding => ({ source: "none", revision: this.#revision });

    const decide = (m: ResumeMetaFacts, depth: number): { binding: WorkstreamBinding | undefined; persist: boolean } => {
      const done = out.get(m.sessionId);
      if (done) return done;
      let result: { binding: WorkstreamBinding | undefined; persist: boolean };
      if (!this.configured) {
        result = { binding: m.stored === undefined ? undefined : readWorkstreamBinding(m.stored), persist: false };
      } else if (m.role === "conductor") {
        const same = readWorkstreamBinding(m.stored);
        const ok = same?.source === "reserved" && same.id === CONDUCTOR_WORKSTREAM;
        result = { binding: ok ? same : this.conductorBinding(), persist: !ok };
      } else if (m.stored !== undefined) {
        const parsed = readWorkstreamBinding(m.stored);
        const bad =
          !parsed ||
          parsed.source === "reserved" ||
          parsed.id === CONDUCTOR_WORKSTREAM ||
          (parsed.id !== undefined && this.#effective.get(parsed.id)?.abstract === true);
        result = bad ? { binding: none(), persist: true } : { binding: parsed, persist: false };
      } else {
        const parent = m.parentId && depth < 32 ? byId.get(m.parentId) : undefined;
        const inherited = parent ? decide(parent, depth + 1).binding : undefined;
        if (inherited) {
          result = { binding: inherited.id ? { ...inherited, source: "migrated" } : none(), persist: true };
        } else {
          let resolution: WorkstreamResolution;
          try {
            resolution = this.resolve(expandHome(m.workdir, this.#reader.home));
          } catch {
            resolution = { source: "none", candidates: [] };
          }
          const bound = this.#bind(resolution);
          result = { binding: { ...bound, source: bound.id ? "migrated" : "none" }, persist: true };
        }
      }
      out.set(m.sessionId, result);
      return result;
    };

    // Decided on demand, so only the sessions actually resumed (and their
    // ancestors) cost a folder read — none at all with nothing configured.
    return (sessionId) => {
      const m = byId.get(sessionId);
      return m ? decide(m, 0) : { binding: undefined, persist: false };
    };
  }

  /**
   * The environment a session homed by `binding` gets (§6.2): its
   * workstream's env, each value read from `secrets` now, and its git
   * identity. Empty for no home, a reserved one, an orphaned one, or with no
   * workstreams configured. `missing` names env vars whose credential has no
   * value — the session starts without them, and says so.
   */
  envFor(binding: WorkstreamBinding | undefined, secrets: SecretStore): { env: Record<string, string>; missing: string[] } {
    const env: Record<string, string> = {};
    const missing: string[] = [];
    if (!this.configured || !binding?.id || binding.source === "reserved") return { env, missing };
    const ws = this.#effective.get(binding.id);
    if (!ws) return { env, missing };
    for (const [name, ref] of Object.entries(ws.env)) {
      const value = secrets.get(ref.secret);
      if (value === undefined || value.includes("\0")) missing.push(name);
      else env[name] = value;
    }
    const oneLine = (v: string | undefined) => (v !== undefined && !/[\0\r\n]/.test(v) ? v : undefined);
    const name = oneLine(ws.git?.name);
    const email = oneLine(ws.git?.email);
    if (name) Object.assign(env, { GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name });
    if (email) Object.assign(env, { GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email });
    return { env, missing };
  }

  #bind(r: WorkstreamResolution): WorkstreamBinding {
    if (r.home === undefined) return { source: "none", revision: this.#revision };
    return { id: r.home, source: r.source, ...(r.matchedBy ? { matchedBy: r.matchedBy } : {}), revision: this.#revision };
  }

  /**
   * What `SessionInfo.workstream` carries for a binding. Nothing at all when
   * no workstreams are configured: removing the block turns workstreams off,
   * it doesn't orphan every session.
   */
  info(binding: WorkstreamBinding | undefined): SessionWorkstreamInfo | undefined {
    if (!binding || !this.configured) return undefined;
    const reads = {
      ...(binding.references?.length ? { references: binding.references.map((r) => ({ workstream: r.workstream, ...(r.paths ? { paths: [...r.paths] } : {}) })) } : {}),
      ...(binding.readFrom?.length ? { readFrom: [...binding.readFrom] } : {}),
    };
    if (binding.id === undefined) return { source: binding.source, ...reads };
    if (binding.id === CONDUCTOR_WORKSTREAM && binding.source === "reserved") {
      return { id: CONDUCTOR_WORKSTREAM, name: "Conductor", source: "reserved" };
    }
    const ws = this.#effective.get(binding.id);
    return {
      id: binding.id,
      ...(ws ? { name: ws.name, ...(ws.color ? { color: ws.color } : {}) } : { orphaned: true }),
      source: binding.source,
      ...(binding.matchedBy ? { matchedBy: binding.matchedBy } : {}),
      ...reads,
    };
  }
}
