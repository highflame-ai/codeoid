import { describe, expect, it } from "vitest";

import { absoluteTime, errMessage, githubCommitUrl, githubUrl, identityKey, isUnavailable, optionalInt, optionalUsd, relativeWhen } from "./automation";

const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();

describe("relativeWhen", () => {
  it("reads both ways", () => {
    expect(relativeWhen(at(30_000), NOW)).toBe("in under a minute");
    expect(relativeWhen(at(-30_000), NOW)).toBe("just now");
    expect(relativeWhen(at(4 * 60_000), NOW)).toBe("in 4m");
    expect(relativeWhen(at(-4 * 60_000), NOW)).toBe("4m ago");
    expect(relativeWhen(at(2 * 3_600_000), NOW)).toBe("in 2h");
    expect(relativeWhen(at(-2 * 3_600_000), NOW)).toBe("2h ago");
    expect(relativeWhen(at(-30 * 3_600_000), NOW)).toBe("yesterday");
    expect(relativeWhen(at(30 * 3_600_000), NOW)).toMatch(/^tomorrow /);
    expect(relativeWhen(at(3 * 86_400_000), NOW)).toBe("in 3d");
  });

  it("an unknown time is a dash, not a guess", () => {
    expect(relativeWhen(null, NOW)).toBe("—");
    expect(relativeWhen("not a time", NOW)).toBe("—");
    expect(absoluteTime(undefined)).toBe("");
  });
});

describe("links", () => {
  it("only https://github.com/ URLs become links", () => {
    expect(githubUrl("https://github.com/o/r/pull/1")).toBe("https://github.com/o/r/pull/1");
    expect(githubUrl("http://github.com/o/r")).toBeNull();
    expect(githubUrl("https://github.com.evil.example/x")).toBeNull();
    expect(githubUrl("https://evil.example/https://github.com/")).toBeNull();
    expect(githubUrl("javascript:alert(1)")).toBeNull();
    expect(githubUrl(null)).toBeNull();
  });

  it("builds a commit link only for a well-formed repo and sha", () => {
    expect(githubCommitUrl("acme/shop", "0123456789AB")).toBe("https://github.com/acme/shop/commit/0123456789ab");
    expect(githubCommitUrl("acme/shop/../x", "0123456789ab")).toBeNull();
    expect(githubCommitUrl("acme/shop", "not-a-sha")).toBeNull();
    // A SHA-256 repository's full ids, but nothing between 40 and 64.
    expect(githubCommitUrl("acme/shop", "a".repeat(64))).toBe(`https://github.com/acme/shop/commit/${"a".repeat(64)}`);
    expect(githubCommitUrl("acme/shop", "a".repeat(50))).toBeNull();
    expect(githubCommitUrl("acme/shop", "a".repeat(65))).toBeNull();
  });
});

describe("numbers", () => {
  it("parses optional whole numbers and dollar amounts with the reason they're wrong", () => {
    expect(optionalInt("", "X")).toBeUndefined();
    expect(optionalInt(" 7 ", "X")).toBe(7);
    expect(optionalInt("0", "X", 0)).toBe(0);
    expect(optionalInt("0", "X")).toEqual({ error: "X must be a whole number of at least 1" });
    expect(optionalInt("1.5", "X")).toEqual({ error: "X must be a whole number of at least 1" });
    expect(optionalUsd("$2.50", "Y")).toBe(2.5);
    expect(optionalUsd("0", "Y")).toEqual({ error: "Y must be a dollar amount above 0" });
  });
});

describe("errors", () => {
  it("keeps the daemon's words and spots an unavailable feature", () => {
    expect(errMessage({ error: "Missing scope: session:create", code: "forbidden" })).toBe("Missing scope: session:create");
    expect(errMessage(new Error("boom"))).toBe("boom");
    expect(isUnavailable({ error: "x", code: "forbidden" }, /never/)).toBe(true);
    // The client rejects a response.error as a plain Error: the words decide.
    expect(isUnavailable(new Error("Missing scope: session:send"), /^Missing scope/)).toBe(true);
    expect(isUnavailable(new Error("request timed out"), /^Missing scope/)).toBe(false);
  });
});

describe("identityKey", () => {
  it("is the same for a reconnect as the same identity, and differs for another or a narrower token", () => {
    const a = { identity: { sub: "spiffe://t/user/a" }, scopes: ["session:read", "session:create"] };
    expect(identityKey(a)).toBe(identityKey({ identity: { sub: "spiffe://t/user/a" }, scopes: ["session:create", "session:read"] }));
    expect(identityKey(a)).not.toBe(identityKey({ ...a, identity: { sub: "spiffe://t/user/b" } }));
    expect(identityKey(a)).not.toBe(identityKey({ ...a, scopes: ["session:read"] }));
    expect(identityKey(null)).toBeNull();
  });
});
