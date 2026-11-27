/**
 * A routine's API trigger: `POST /routines/<id>/fire` (docs/routines.md).
 *
 * Authenticated by the routine's own token (`Authorization: Bearer rt_…`),
 * not by a ZeroID JWT: the caller is a monitor, a deploy script, a CI step —
 * something that should be able to start THIS routine and nothing else. The
 * token is compared in constant time against a stored hash, and an unknown
 * routine and a wrong token get the same 401, so the endpoint never reveals
 * which routines exist.
 *
 * The body is the payload: JSON `{ "text": "…" }`, or any text body. It
 * reaches the agent only as delimited data in its prompt ({{payload}}, or
 * appended when the prompt doesn't place it), never as instructions.
 */

import { RoutineError, type RoutineService } from "./service.js";
import type { RunRow } from "./types.js";

const FIRE_PATH = /^\/routines\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/fire$/;
const MAX_BODY_BYTES = 64 * 1024;

/**
 * What the caller is told about a fire that didn't go ahead. Generic on
 * purpose: the run's own reason names what it waited behind (a loop run's id,
 * the owner's cap), which is the owner's to see over the WebSocket and the
 * CLI, not a token holder's.
 */
function callerReason(run: RunRow): string | undefined {
  switch (run.status) {
    case "skipped":
      return "this fire was skipped: the routine is busy or at one of its limits";
    case "failed":
      return "the run could not start";
    case "cancelled":
      return "the run was cancelled";
    default:
      return undefined;
  }
}

/** The routine id if `pathname` is a fire endpoint, else null. */
export function matchFirePath(pathname: string): string | null {
  return FIRE_PATH.exec(pathname)?.[1] ?? null;
}

function json(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

async function readCapped(req: Request): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function handleRoutineFire(
  req: Request,
  routineId: string,
  svc: RoutineService,
  opts: { clientIp?: string } = {},
): Promise<Response> {
  // A browser page must not be able to fire a loopback daemon's routines.
  if (req.headers.get("origin")) return json(403, { error: "browser origins are not accepted" });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });

  const authz = req.headers.get("authorization") ?? "";
  const token = /^bearer\s+/i.test(authz) ? authz.replace(/^bearer\s+/i, "").trim() : "";
  const routine = svc.store.getRoutine(routineId);
  // One answer for "no such routine", "API trigger off", and "wrong token".
  if (!token || !routine || !routine.spec.api || !svc.store.verifyApiToken(routineId, token)) {
    return json(401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
  }

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return json(413, { error: "request too large" });
  const raw = await readCapped(req).catch(() => null);
  if (raw === null) return json(413, { error: "request too large" });
  let payload: string | null = raw.trim() === "" ? null : raw;
  if (payload !== null && (req.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      const body = JSON.parse(payload) as { text?: unknown };
      payload = typeof body.text === "string" ? body.text : JSON.stringify(body);
    } catch {
      return json(400, { error: "body is not valid JSON" });
    }
  }

  try {
    const run = svc.fire(routine, "api", payload, `routine-token:${routine.id}${opts.clientIp ? `@${opts.clientIp}` : ""}`);
    const reason = callerReason(run);
    return json(202, { runId: run.id, status: run.status, ...(reason ? { reason } : {}) });
  } catch (err) {
    if (err instanceof RoutineError) {
      const status = err.code === "rate_limited" ? 429 : err.code === "conflict" ? 409 : 400;
      return json(status, { error: err.message }, status === 429 ? { "Retry-After": "3600" } : {});
    }
    return json(500, { error: "internal error" });
  }
}
