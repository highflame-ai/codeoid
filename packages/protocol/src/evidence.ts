/**
 * Evidence (docs/loop-engineering-design.md §7): the daemon's record of one
 * executed check — what ran, on which tree, with what result — independent of
 * any model's account of it.
 *
 * `evidence.get` reads one record. Its scope follows the record's owner: a
 * pipeline's evidence needs `pipeline:read` and the pipeline must be visible to
 * the caller. An id the caller cannot see is `not_found`, never `forbidden`, so
 * ids reveal nothing across tenants.
 */

export type EvidenceResultWire = "pass" | "fail" | "inconclusive" | "error" | "cancelled";

export interface EvidenceArtifactWire {
  name: "stdout" | "stderr";
  sha256: string;
  bytes: number;
  truncated: boolean;
}

export interface EvidenceWire {
  id: string;
  ownerKind: "pipeline" | "loop";
  ownerId: string;
  criterionId: string;
  candidateDigest: string | null;
  verifierDigest: string;
  isolation: "process" | "sandbox";
  command: string;
  result: EvidenceResultWire;
  reason: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** ISO timestamps. */
  startedAt: string;
  endedAt: string;
  environment: { platform: string; arch: string; runtime: string; envKeys: string[] };
  stdoutExcerpt: string;
  stderrExcerpt: string;
  /** Full output streams held by the daemon; paths are not exposed. */
  artifacts: EvidenceArtifactWire[];
}

export interface EvidenceGetMsg {
  type: "evidence.get";
  id: string;
  evidenceId: string;
}

export interface EvidenceRecordMsg {
  type: "evidence.record";
  requestId: string;
  evidence: EvidenceWire;
}
