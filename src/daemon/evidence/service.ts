/**
 * Runs checks and records what they did. The one entry point pipelines' gates
 * and (later) loops use, so every executed check leaves the same evidence.
 */

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
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

export class EvidenceService {
  readonly #store: EvidenceStore;
  readonly #artifactRoot: string;

  /** `artifactRoot` holds one directory per check's full output. */
  constructor(store: EvidenceStore, artifactRoot: string) {
    this.#store = store;
    this.#artifactRoot = artifactRoot;
  }

  /** Run `spec` in `cwd` and persist the result. */
  async run(spec: CheckSpec, cwd: string, ctx: EvidenceContext): Promise<CheckRun> {
    const artifactDir = join(this.#artifactRoot, ctx.ownerKind, safeSegment(ctx.ownerId), randomUUID());
    const outcome = await runCheck(spec, { cwd, artifactDir, signal: ctx.signal });
    const record = this.#store.insert({
      ...outcome,
      accountId: ctx.tenant.accountId,
      projectId: ctx.tenant.projectId,
      ownerKind: ctx.ownerKind,
      ownerId: ctx.ownerId,
      candidateDigest: ctx.candidateDigest ?? null,
    });
    return { outcome, record };
  }

  /** A runner bound to one owner — what a gate is handed. */
  runnerFor(ctx: EvidenceContext): CheckRunner {
    return (spec, cwd) => this.run(spec, cwd, ctx);
  }

  get(id: string, tenant: EvidenceTenant): EvidenceRecord | null {
    return this.#store.get(id, tenant);
  }

  listForOwner(ownerKind: EvidenceOwnerKind, ownerId: string, tenant: EvidenceTenant): EvidenceRecord[] {
    return this.#store.listForOwner(ownerKind, ownerId, tenant);
  }
}

/**
 * Run a check without recording it, for callers with no evidence store (tests,
 * a pipeline manager built without one). Output goes to a temporary directory
 * that is removed afterwards; the outcome's excerpts survive, its artifact
 * paths do not.
 */
export const ephemeralCheck: CheckRunner = async (spec, cwd) => {
  const artifactDir = join(tmpdir(), "codeoid-evidence", randomUUID());
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
