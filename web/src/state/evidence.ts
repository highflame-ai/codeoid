/**
 * Evidence reads (docs/loop-engineering-design.md §7): fetch one record of an
 * executed check by id. Records are immutable, so a fetched record is cached —
 * per connection (a new token or project starts empty, so nothing is served
 * that the current identity hasn't been authorized for) and bounded.
 */

import type { EvidenceRecordMsg, EvidenceWire } from "../protocol/types";
import { getClient, newRequestId } from "./connection";

const READ_TIMEOUT_MS = 15_000;
const CACHE_MAX = 200;
const caches = new WeakMap<object, Map<string, EvidenceWire>>();

export async function fetchEvidence(evidenceId: string): Promise<EvidenceWire> {
  const client = getClient();
  let cache = caches.get(client);
  if (!cache) {
    cache = new Map();
    caches.set(client, cache);
  }
  const hit = cache.get(evidenceId);
  if (hit) return hit;
  const id = newRequestId();
  const msg = await client.request<EvidenceRecordMsg>(
    { type: "evidence.get", id, evidenceId },
    {
      waitForResult: (m) => (m.type === "evidence.record" && m.requestId === id ? m : undefined),
      timeoutMs: READ_TIMEOUT_MS,
    },
  );
  cache.set(evidenceId, msg.evidence);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return msg.evidence;
}
