/**
 * Local mode, end to end against a real daemon.
 *
 * The unit tests next door prove the verifier in isolation; this proves the
 * WIRING — that a daemon booted with `localMode` actually authenticates with the
 * minted token, actually refuses everything else, actually advertises the
 * degraded posture on `auth.ok`, and actually attributes the audit log to a
 * self-asserted subject.
 *
 * Deliberately NOT mocked: a real `DaemonServer`, a real `Bun.serve`, a real
 * WebSocket handshake. The one thing stubbed out is the agent backend — no
 * session ever takes a turn here.
 *
 * Offline by construction: nothing in this file starts a JWKS server, and the
 * daemon is given no reachable issuer. If local mode ever regains a network
 * dependency on the auth path, this suite hangs or fails rather than passing
 * quietly against a fake issuer.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonServer } from "../daemon/server.js";
import {
  LOCAL_ACCOUNT_ID,
  LOCAL_PROJECT_ID,
  LOCAL_SUBJECT,
  mintLocalToken,
  readLocalTokenFile,
} from "../daemon/local-auth.js";
import { ALL_SCOPES } from "@codeoid/protocol";
import type { AuthOkMsg, DaemonMessage } from "../protocol/types.js";

const TOKEN = mintLocalToken();

let dir: string;
let tokenFile: string;
let dbPath: string;
let daemon: DaemonServer;
let url: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "codeoid-localmode-"));
  tokenFile = join(dir, "local-token");
  dbPath = join(dir, "codeoid.db");
  daemon = new DaemonServer({
    port: 0, // let the OS pick — parallel test files must not collide
    host: "127.0.0.1",
    dbPath,
    transcriptDir: join(dir, "transcripts"),
    // An issuer that is NOT running. In local mode nothing may contact it; if
    // something does, it fails loudly instead of silently succeeding.
    auth: { baseUrl: "http://127.0.0.1:1/unreachable-issuer" },
    localMode: { token: TOKEN, tokenFile },
  });
  await daemon.start();
  url = `ws://127.0.0.1:${daemon.port}`;
});

afterAll(async () => {
  await daemon.stop();
  rmSync(dir, { recursive: true, force: true });
});

// ── Handshake helpers ───────────────────────────────────────────────────────

interface Handshake {
  ok?: AuthOkMsg;
  closeCode?: number;
  closeReason?: string;
}

/**
 * Open a socket, present `token`, and settle with `auth.ok` or with the close
 * frame the daemon answered with. Never rejects on a refusal — a refusal is a
 * legitimate outcome half these tests are asserting.
 */
function handshake(token: unknown): Promise<Handshake> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    const done = (h: Handshake): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(h);
    };
    const timer = setTimeout(() => {
      ws.close();
      if (!settled) {
        settled = true;
        reject(new Error("handshake timed out"));
      }
    }, 5000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "auth", token }));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as DaemonMessage;
      if (msg.type === "auth.ok") {
        done({ ok: msg });
        ws.close();
      }
    };
    ws.onclose = (ev) => done({ closeCode: ev.code, closeReason: ev.reason });
    ws.onerror = () => {
      /* a rejected handshake surfaces through onclose */
    };
  });
}

/** Assert the handshake succeeded, reporting the daemon's own reason if not. */
function expectAuthOk(h: Handshake): AuthOkMsg {
  if (!h.ok) {
    throw new Error(
      `expected auth.ok, got close ${h.closeCode} ${JSON.stringify(h.closeReason ?? "")}`,
    );
  }
  return h.ok;
}

// ── The posture is real ─────────────────────────────────────────────────────

describe("local-mode daemon", () => {
  it("reports the local posture", () => {
    expect(daemon.authMode).toBe("local");
  });

  it("publishes the token for local clients", () => {
    // This is what makes `codeoid start --local` + `codeoid tui` work with no
    // copy-paste, so it must exist by the time the socket is listening.
    expect(readLocalTokenFile(tokenFile)).toBe(TOKEN);
  });

  it("exposes the posture over HTTP for a curl check", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/config`);
    expect(await res.json()).toMatchObject({ auth_mode: "local" });
  });

  it("refuses token exchange — there is no issuer to exchange at", async () => {
    // Also matters as a guard: proxying would make the daemon an unauthenticated
    // egress path to ZeroID for any local process.
    const res = await fetch(`http://127.0.0.1:${daemon.port}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "api_key", api_key: "zid_sk_x" }),
    });
    expect(res.status).toBe(503);
  });
});

describe("local-mode handshake", () => {
  it("accepts the minted token and advertises the degraded posture", async () => {
    const ok = expectAuthOk(await handshake(TOKEN));

    // The field a client MUST render as a visible badge.
    expect(ok.authMode).toBe("local");

    // Self-asserted principal — `anonymous:` prefixed, never SPIFFE-shaped.
    expect(ok.identity.sub).toBe(LOCAL_SUBJECT);
    expect(ok.identity.sub.startsWith("anonymous:")).toBe(true);
    expect(ok.identity.sub).not.toContain("spiffe://");

    // Full scope set: the enforcement path stays identical to ZeroID mode.
    expect([...ok.scopes].sort()).toEqual([...ALL_SCOPES].sort());
  });

  it("FAILS CLOSED on a wrong token, exactly like ZeroID mode", async () => {
    const { ok, closeCode } = await handshake(mintLocalToken());
    expect(ok).toBeUndefined();
    expect(closeCode).toBe(4003); // the same code a rejected JWT gets
  });

  it("fails closed on an empty token", async () => {
    const { ok } = await handshake("");
    expect(ok).toBeUndefined();
  });

  it("fails closed on a malformed auth frame", async () => {
    const { ok, closeCode } = await handshake(undefined);
    expect(ok).toBeUndefined();
    expect(closeCode).toBe(4001); // schema rejection, before verification
  });

  it("rejects a ZeroID-shaped key without ever reaching the issuer", async () => {
    // The configured issuer is a dead address, so if this path tried to verify
    // remotely it would hang past the handshake timeout rather than close.
    const started = Date.now();
    const { ok, closeCode } = await handshake("zid_sk_looks_real_but_isnt");
    expect(ok).toBeUndefined();
    expect(closeCode).toBe(4003);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("local-mode audit attribution", () => {
  it("records actions under the self-asserted subject", async () => {
    // Drive one real, audited verb over the wire and read the row back out of
    // SQLite. session.create is the cheapest audited action that exercises the
    // full path (scope check → handler → audit) without taking an agent turn.
    const ws = new WebSocket(url);
    const sessionName = `local-audit-${Date.now()}`;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out")), 20_000);
      ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token: TOKEN }));
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data)) as DaemonMessage & { requestId?: string };
        if (msg.type === "auth.ok") {
          ws.send(
            JSON.stringify({
              type: "session.create",
              id: "req-1",
              name: sessionName,
              workdir: dir,
            }),
          );
          return;
        }
        if (msg.requestId === "req-1") {
          clearTimeout(timer);
          ws.close();
          msg.type === "response.ok"
            ? resolve()
            : reject(new Error(`session.create failed: ${JSON.stringify(msg)}`));
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("socket error"));
      };
    });

    // Read through an independent connection — asserting on the bytes SQLite
    // actually committed, not on in-process state.
    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare("SELECT subject, action FROM audit_log WHERE action = 'session.create'")
      .all() as Array<{ subject: string; action: string }>;

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // The whole point: an audit export can tell self-asserted from verified.
      expect(row.subject).toBe(LOCAL_SUBJECT);
      expect(row.subject.startsWith("anonymous:")).toBe(true);
      expect(row.subject).not.toContain("spiffe://");
    }

    // And the session landed in the reserved tenant, not an empty bucket.
    const session = db
      .prepare("SELECT account_id, project_id, created_by FROM sessions WHERE name = ?")
      .get(sessionName) as
      | { account_id: string; project_id: string; created_by: string }
      | null;
    expect(session).not.toBeNull();
    expect(session!.account_id).toBe(LOCAL_ACCOUNT_ID);
    expect(session!.project_id).toBe(LOCAL_PROJECT_ID);
    expect(session!.created_by).toBe(LOCAL_SUBJECT);
    db.close();
  }, 30_000);
});
