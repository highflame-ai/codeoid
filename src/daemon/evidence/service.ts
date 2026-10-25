/**
 * Runs checks and records what they did. The one entry point pipelines' gates
 * and (later) loops use, so every executed check leaves the same evidence.
 *
 * The service also owns the checks it starts: an owner (a pipeline being
 * aborted) or the daemon (shutting down) can stop them, so a test run never
 * outlives the thing that asked for it.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck } from "./runner.js";
import type { EvidenceStore, EvidenceTenant } from "./store.js";
import type { CheckOutcome, CheckSpec, EvidenceOwnerKind, EvidenceRecord } from "./types.js";

/** Who the evidence is for and what it judged. */
export interface EvidenceContext {
  tenant: EvidenceTenant;
  ownerKind: EvidenceOwnerKind;
  ownerId: string;
  /** The tree the check judged, when the caller pinned one. */
  candidateDigest?: string | null;
  signal?: AbortSignal;
}

/** A check run through the service: its outcome, and the stored record when
 *  the run was recorded. */
export interface CheckRun {
  outcome: CheckOutcome;
  record?: EvidenceRecord;
}

/** The narrow surface a gate needs: run a check in a directory. */
export type CheckRunner = (spec: CheckSpec, cwd: string) => Promise<CheckRun>;

export interface EvidenceRetention {
  /** Records (and their artifacts) older than this are deleted. */
  maxAgeMs: number;
  /** Past this many artifact bytes in total, the oldest records go first. */
  maxTotalBytes: number;
}

export const DEFAULT_EVIDENCE_RETENTION: EvidenceRetention = {
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
};

const ownerKey = (kind: EvidenceOwnerKind, id: string): string => `${kind}\u0000${id}`;

export class EvidenceService {
  readonly #store: EvidenceStore;
  readonly #artifactRoot: string;
  /** Live checks by owner, so an owner or the daemon can stop them. */
  readonly #live = new Map<string, Set<AbortController>>();

  /** `artifactRoot` holds one directory per check's full output. */
  constructor(store: EvidenceStore, artifactRoot: string) {
    this.#store = store;
    this.#artifactRoot = artifactRoot;
  }

  /** Run `spec` in `cwd` and persist the result. */
  async run(spec: CheckSpec, cwd: string, ctx: EvidenceContext): Promise<CheckRun> {
    const artifactDir = join(this.#artifactRoot, ctx.ownerKind, safeSegment(ctx.ownerId), randomUUID());
    const key = ownerKey(ctx.ownerKind, ctx.ownerId);
    const ac = new AbortController();
    const onAbort = (): void => ac.abort();
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    if (ctx.signal?.aborted) ac.abort();
    const live = this.#live.get(key) ?? new Set<AbortController>();
    live.add(ac);
    this.#live.set(key, live);
    try {
      const outcome = await runCheck(spec, { cwd, artifactDir, signal: ac.signal });
      const record = this.#store.insert({
        ...outcome,
        accountId: ctx.tenant.accountId,
        projectId: ctx.tenant.projectId,
        ownerKind: ctx.ownerKind,
        ownerId: ctx.ownerId,
        candidateDigest: ctx.candidateDigest ?? null,
      });
      return { outcome, record };
    } finally {
      ctx.signal?.removeEventListener("abort", onAbort);
      live.delete(ac);
      if (live.size === 0) this.#live.delete(key);
    }
  }

  /** A runner bound to one owner — what a gate is handed. */
  runnerFor(ctx: EvidenceContext): CheckRunner {
    return (spec, cwd) => this.run(spec, cwd, ctx);
  }

  /** Stop every check running for one owner (e.g. a pipeline being aborted). */
  abortOwner(ownerKind: EvidenceOwnerKind, ownerId: string): void {
    for (const ac of this.#live.get(ownerKey(ownerKind, ownerId)) ?? []) ac.abort();
  }

  /** Stop every running check (daemon shutdown). */
  abortAll(): void {
    for (const set of this.#live.values()) for (const ac of set) ac.abort();
  }

  get(id: string, tenant: EvidenceTenant): EvidenceRecord | null {
    return this.#store.get(id, tenant);
  }

  listForOwner(ownerKind: EvidenceOwnerKind, ownerId: string, tenant: EvidenceTenant): EvidenceRecord[] {
    return this.#store.listForOwner(ownerKind, ownerId, tenant);
  }

  /**
   * Delete records and artifacts past the retention policy: anything older than
   * `maxAgeMs`, then the oldest until the artifacts fit in `maxTotalBytes`.
   * Artifact directories with no record (a crash between writing output and
   * storing the record) are removed too. Returns how many records went.
   */
  sweep(policy: EvidenceRetention = DEFAULT_EVIDENCE_RETENTION, now = Date.now()): number {
    const doomed = new Set(this.#store.idsStartedBefore(now - policy.maxAgeMs));
    let total = 0;
    for (const r of this.#store.artifactSizesNewestFirst()) {
      if (doomed.has(r.id)) continue;
      total += r.bytes;
      if (total > policy.maxTotalBytes) doomed.add(r.id);
    }
    const dirs = this.#store.artifactDirsFor([...doomed]);
    this.#store.deleteIds([...doomed]);
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    this.#removeOrphanDirs(new Set(this.#store.allArtifactDirs()), now);
    return doomed.size;
  }

  /** Remove check directories under the root that no record points at, once
   *  they are old enough not to belong to a check still running. */
  #removeOrphanDirs(known: Set<string>, now: number): void {
    const minAgeMs = 60 * 60 * 1000;
    let kinds: string[];
    try {
      kinds = readdirSync(this.#artifactRoot);
    } catch {
      return;
    }
    for (const kind of kinds) {
      for (const owner of safeReaddir(join(this.#artifactRoot, kind))) {
        const ownerDir = join(this.#artifactRoot, kind, owner);
        for (const check of safeReaddir(ownerDir)) {
          const dir = join(ownerDir, check);
          if (known.has(dir)) continue;
          try {
            if (now - statSync(dir).mtimeMs < minAgeMs) continue;
          } catch {
            continue;
          }
          rmSync(dir, { recursive: true, force: true });
        }
        if (safeReaddir(ownerDir).length === 0) rmSync(ownerDir, { recursive: true, force: true });
      }
    }
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Run a check without recording it, for callers with no evidence store (tests,
 * a pipeline manager built without one). Output goes to a private temporary
 * directory that is removed afterwards; the outcome's excerpts survive, its
 * artifact paths do not.
 */
export const ephemeralCheck: CheckRunner = async (spec, cwd) => {
  const artifactDir = mkdtempSync(join(tmpdir(), "codeoid-evidence-"));
  try {
    return { outcome: await runCheck(spec, { cwd, artifactDir }) };
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
  }
};

/** An owner id as one path segment: ids are daemon-minted, but a directory
 *  name must never be able to climb out of the artifact root. */
function safeSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "_";
}
