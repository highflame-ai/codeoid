/**
 * ZeroIdVerifier's bound on what a forged token costs.
 *
 * The ZeroID SDK refetches the issuer's JWKS for every token naming a key it
 * hasn't cached, so forged tokens with random `kid`s — over the WebSocket
 * handshake or /mcp/control — would make the daemon fetch in a loop. The
 * verifier checks an unseen `kid` against its own inventory of the issuer's
 * published key ids, refreshed at most once per cooldown.
 */

import { describe, expect, it } from "bun:test";
import { FAILED_FETCH_RETRY_MS, jwtKeyRef, jwtKid, UNKNOWN_KID_COOLDOWN_MS, ZeroIdVerifier } from "../daemon/auth.js";
import type { AuthContext } from "../protocol/types.js";

const CTX: AuthContext = { sub: "u", scopes: [], delegationDepth: 0, accountId: "a", projectId: "p" };

function jwt(kid: string | undefined, tag = "x"): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", ...(kid ? { kid } : {}) })).toString("base64url");
  return `${header}.${Buffer.from(`{"t":"${tag}"}`).toString("base64url")}.sig`;
}

/** A fake issuer publishing `published`; the fake SDK verifies only those keys. */
function harness(initial: string[]) {
  let now = 1_000_000;
  const published = new Set(initial);
  const sdkCalls: string[] = [];
  let reads = 0;
  const v = new ZeroIdVerifier(
    { baseUrl: "http://zeroid.test" },
    {
      now: () => now,
      fetchKids: async () => {
        reads++;
        return new Set(published);
      },
      verify: async (token) => {
        const kid = jwtKid(token) ?? "(none)";
        sdkCalls.push(kid);
        if (published.has(kid) || kid === "(none)") return CTX;
        throw new Error("No matching JWKS key found for this token");
      },
    },
  );
  return {
    v,
    sdkCalls,
    reads: () => reads,
    rotate: (kid: string) => published.add(kid),
    retire: (kid: string) => published.delete(kid),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("ZeroIdVerifier — forged-kid bound", () => {
  it("a flood of random kids costs one issuer read per window and never reaches the SDK", async () => {
    const h = harness(["k1"]);
    for (let i = 0; i < 50; i++) await expect(h.v.verify(jwt(`rand-${i}`))).rejects.toThrow("unknown key");
    expect(h.reads()).toBe(1);
    expect(h.sdkCalls).toEqual([]);
    h.advance(UNKNOWN_KID_COOLDOWN_MS);
    for (let i = 50; i < 100; i++) await expect(h.v.verify(jwt(`rand-${i}`))).rejects.toThrow("unknown key");
    expect(h.reads()).toBe(2);
  });

  it("a published key verifies on first sight, and is never gated again", async () => {
    const h = harness(["k1"]);
    expect(await h.v.verify(jwt("k1"))).toEqual(CTX);
    await expect(h.v.verify(jwt("forged"))).rejects.toThrow();
    for (let i = 0; i < 5; i++) expect(await h.v.verify(jwt("k1", `n${i}`))).toEqual(CTX);
    expect(h.reads()).toBe(1);
  });

  it("a rotated key cannot be starved by a steady forged stream", async () => {
    // The old design (a cooldown reset by every failure) let one forged token
    // per window keep a genuinely new key from ever being tried.
    const h = harness(["k1"]);
    await expect(h.v.verify(jwt("forged-0"))).rejects.toThrow();
    h.rotate("k2");
    let verified = false;
    for (let step = 1; step <= 5 && !verified; step++) {
      h.advance(UNKNOWN_KID_COOLDOWN_MS - 1);
      await expect(h.v.verify(jwt(`forged-${step}`))).rejects.toThrow(); // attacker, every window
      h.advance(1);
      verified = await h.v.verify(jwt("k2")).then(
        () => true,
        () => false,
      );
    }
    expect(verified).toBe(true);
  });

  it("a key the issuer retires stops being trusted — forged tokens naming it are gated again", async () => {
    // Round-4 finding: a once-verified kid skipped the gate forever, so after
    // rotation each forged token naming the old, public kid cost a refetch.
    const h = harness(["k1"]);
    expect(await h.v.verify(jwt("k1"))).toEqual(CTX);
    h.retire("k1");
    h.rotate("k2");
    await expect(h.v.verify(jwt("k1", "forged-0"))).rejects.toThrow("No matching JWKS key"); // SDK says so once
    const before = h.sdkCalls.length;
    for (let i = 1; i <= 50; i++) await expect(h.v.verify(jwt("k1", `forged-${i}`))).rejects.toThrow("unknown key");
    expect(h.sdkCalls.length).toBe(before); // none reached the SDK
    // The new key is admitted at the next key-list read (one window).
    h.advance(UNKNOWN_KID_COOLDOWN_MS);
    expect(await h.v.verify(jwt("k2"))).toEqual(CTX);
  });

  it("a fresh key list also prunes trusted keys it no longer contains", async () => {
    const h = harness(["k1"]);
    expect(await h.v.verify(jwt("k1"))).toEqual(CTX);
    h.retire("k1");
    h.advance(UNKNOWN_KID_COOLDOWN_MS);
    await expect(h.v.verify(jwt("other"))).rejects.toThrow("unknown key"); // triggers a fresh read
    const before = h.sdkCalls.length;
    await expect(h.v.verify(jwt("k1", "forged"))).rejects.toThrow("unknown key");
    expect(h.sdkCalls.length).toBe(before);
  });

  it("concurrent unknown kids share one in-flight issuer read", async () => {
    const h = harness(["k1"]);
    await Promise.allSettled(Array.from({ length: 20 }, (_, i) => h.v.verify(jwt(`c-${i}`))));
    expect(h.reads()).toBe(1);
  });

  it("after a failed read, the issuer is retried within a second, not a full window", async () => {
    let now = 0;
    let up = false;
    let reads = 0;
    const v = new ZeroIdVerifier(
      { baseUrl: "http://zeroid.test" },
      {
        now: () => now,
        fetchKids: async () => {
          reads++;
          if (!up) throw new Error("ECONNREFUSED");
          return new Set(["k1"]);
        },
        verify: async () => CTX,
      },
    );
    await expect(v.verify(jwt("k1"))).rejects.toThrow("unknown key"); // boot during an outage
    up = true;
    now += FAILED_FETCH_RETRY_MS;
    expect(await v.verify(jwt("k1"))).toEqual(CTX);
    expect(reads).toBe(2);
    expect(FAILED_FETCH_RETRY_MS).toBeLessThan(UNKNOWN_KID_COOLDOWN_MS);
  });

  it("an unreachable issuer leaves unknown kids refused and the next window retries", async () => {
    let reads = 0;
    const v = new ZeroIdVerifier(
      { baseUrl: "http://zeroid.test" },
      {
        fetchKids: async () => {
          reads++;
          throw new Error("ECONNREFUSED");
        },
        verify: async () => CTX,
      },
    );
    await expect(v.verify(jwt("k9"))).rejects.toThrow("unknown key");
    await expect(v.verify(jwt("k9"))).rejects.toThrow("unknown key");
    expect(reads).toBe(1);
  });

  it("tokens without a kid skip the inventory (the SDK never refetches for them)", async () => {
    const h = harness([]);
    expect(await h.v.verify(jwt(undefined))).toEqual(CTX);
    expect(h.reads()).toBe(0);
  });

  it("headers the SDK would still refetch for, but the gate can't read, are refused outright", async () => {
    // Round-3 finding: our parser and the SDK's disagreed, so these skipped
    // the gate while the SDK refetched JWKS for each one.
    const raw = (headerJson: string, bom = false) =>
      `${Buffer.concat([bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(headerJson)]).toString("base64url")}.e30.sig`;
    const h = harness(["k1"]);
    const variants = [
      raw('{"alg":"RS256","kid":1}'),
      raw('{"alg":"RS256","kid":true}'),
      raw('{"alg":"RS256","kid":[0]}'),
      raw('{"alg":"RS256","kid":{}}'),
      raw('{"alg":"RS256","kid":"z","kid":5}'),
      raw('{"alg":"RS256","k\\u0069d":7}'),
      raw("not json"),
      raw("[1,2]"),
    ];
    for (const t of variants) await expect(h.v.verify(t)).rejects.toThrow("Malformed token header");
    expect(h.sdkCalls).toEqual([]);
    expect(h.reads()).toBe(0);
    // A BOM is stripped exactly as the SDK strips it — so its kid IS gated.
    for (let i = 0; i < 10; i++) await expect(h.v.verify(raw(`{"alg":"RS256","kid":"bom-${i}"}`, true))).rejects.toThrow("unknown key");
    expect(h.reads()).toBe(1);
    expect(h.sdkCalls).toEqual([]);
  });

  it("an empty or falsy kid is 'none' — the SDK selects by alg and never refetches", () => {
    const raw = (j: string) => `${Buffer.from(j).toString("base64url")}.e30.sig`;
    for (const j of ['{"alg":"RS256","kid":""}', '{"alg":"RS256","kid":null}', '{"alg":"RS256","kid":0}', '{"alg":"RS256"}']) {
      expect(jwtKeyRef(raw(j))).toEqual({ kind: "none" });
    }
  });

  it("jwtKid reads the header, and tolerates garbage", () => {
    expect(jwtKid(jwt("abc"))).toBe("abc");
    expect(jwtKid(jwt(undefined))).toBeUndefined();
    expect(jwtKid("not-a-jwt")).toBeUndefined();
    expect(jwtKid("")).toBeUndefined();
  });
});
