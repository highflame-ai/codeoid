/**
 * Workstream-homed egress (docs/workstreams-design.md §10, G6) — the stub W4
 * leaves until P6's Slack and email egress exists.
 *
 * The rule it holds: anything the conductor sends to the world names a
 * target workstream and is carried out by a worker homed there, so a reply in
 * one line of work is never drafted by a session that has seen another's.
 * `planEgress` is that decision, pure; nothing calls it yet but its tests.
 * When an egress verb lands it plans first, then spawns the worker it names
 * (fleet_spawn's path: `#fleetSpawnHome`), with the plan on the approval card.
 */

import type { WorkstreamService } from "./service.js";

export interface EgressRequest {
  /** The workstream the message belongs to: required, never inferred. */
  workstream?: string;
  /** Where it goes: a channel kind (`slack`, `email`, …) and its recipient. */
  channel: string;
  recipient: string;
  /** Who asks: only the conductor plans egress. */
  from: { role?: string; workstream?: string };
}

export type EgressPlan =
  | { ok: true; worker: { workstream: string }; card: { workstream: string; channel: string; recipient: string } }
  | { ok: false; error: string };

/**
 * Where an outbound message is drafted and sent: by a worker homed in its
 * workstream, never by the conductor itself, never in a workstream not named.
 */
export function planEgress(service: Pick<WorkstreamService, "configured" | "choiceProblem">, req: EgressRequest): EgressPlan {
  if (req.from.role !== "conductor") return { ok: false, error: "Only the conductor plans egress; a worker sends what it was spawned to send" };
  if (!service.configured) return { ok: false, error: "Egress needs workstreams: each message is sent by a worker homed in its workstream" };
  if (!req.workstream) return { ok: false, error: "Name the workstream this message belongs to: egress is never sent from a guessed one" };
  const problem = service.choiceProblem(req.workstream);
  if (problem) return { ok: false, error: problem };
  if (!req.channel || !req.recipient) return { ok: false, error: "Name the channel and the recipient" };
  return {
    ok: true,
    worker: { workstream: req.workstream },
    card: { workstream: req.workstream, channel: req.channel, recipient: req.recipient },
  };
}
