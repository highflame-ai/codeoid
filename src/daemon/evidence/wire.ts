/**
 * Evidence on the wire. Artifact paths stay in the daemon: a client sees each
 * stream's size and hash, and its excerpt.
 */

import type { EvidenceWire } from "../../protocol/types.js";
import type { EvidenceRecord } from "./types.js";

export function evidenceToWire(r: EvidenceRecord): EvidenceWire {
  return {
    id: r.id,
    ownerKind: r.ownerKind,
    ownerId: r.ownerId,
    criterionId: r.criterionId,
    candidateDigest: r.candidateDigest,
    verifierDigest: r.verifierDigest,
    isolation: r.isolation,
    command: r.command,
    result: r.result,
    reason: r.reason,
    exitCode: r.exitCode,
    signal: r.signal,
    timedOut: r.timedOut,
    startedAt: new Date(r.startedAt).toISOString(),
    endedAt: new Date(r.endedAt).toISOString(),
    environment: r.environment,
    stdoutExcerpt: r.stdoutExcerpt,
    stderrExcerpt: r.stderrExcerpt,
    artifacts: r.artifacts.map(({ name, sha256, bytes, truncated }) => ({ name, sha256, bytes, truncated })),
  };
}
