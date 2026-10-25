/**
 * Evidence reads (docs/loop-engineering-design.md §7): fetch one record of an
 * executed check by id. Records are immutable, so a fetched record is cached
 * for the life of the page.
 */

import type { EvidenceRecordMsg, EvidenceWire } from "../protocol/types";
import { getClient, newRequestId } from "./connection";

const READ_TIMEOUT_MS = 15_000;
const cache = new Map<string, EvidenceWire>();

export async function fetchEvidence(evidenceId: string): Promise<EvidenceWire> {
  const hit = cache.get(evidenceId);
  if (hit) return hit;
  const id = newRequestId();
  const msg = await getClient().request<EvidenceRecordMsg>(
    { type: "evidence.get", id, evidenceId },
    {
      waitForResult: (m) => (m.type === "evidence.record" && m.requestId === id ? m : undefined),
      timeoutMs: READ_TIMEOUT_MS,
    },
  );
  cache.set(evidenceId, msg.evidence);
  return msg.evidence;
}

export function _resetEvidenceForTest(): void {
  cache.clear();
}
