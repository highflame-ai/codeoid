import { describe, it, expect } from "vitest";

import {
  DEFAULT_HOME,
  findConductor,
  homeTarget,
  isHome,
  isOrdinarySession,
} from "./home";
import type { SessionInfo } from "../protocol/types";

const s = (id: string, role?: "conductor" | "worker"): SessionInfo =>
  ({ id, name: id, ...(role ? { role } : {}) }) as SessionInfo;

const CONDUCTOR = s("cond", "conductor");
const WORKER = s("worker-scout-a", "worker");
const WORK = s("api");
const OTHER = s("web");

describe("isHome / DEFAULT_HOME", () => {
  it("defaults to Sessions even once a conductor exists", () => {
    // Silently relocating someone's home the first time they spawn a conductor
    // is the "trapped in an orchestrated mode" feeling §3 exists to prevent.
    expect(DEFAULT_HOME).toBe("sessions");
  });

  it("rejects anything that is not a home, so stored junk falls back", () => {
    expect(isHome("conductor")).toBe(true);
    expect(isHome("sessions")).toBe(true);
    expect(isHome("fleet")).toBe(false);
    expect(isHome(undefined)).toBe(false);
    expect(isHome(null)).toBe(false);
  });
});

describe("findConductor", () => {
  it("finds it, and reports null rather than guessing when absent", () => {
    expect(findConductor([WORK, CONDUCTOR, WORKER])?.id).toBe("cond");
    expect(findConductor([WORK, WORKER])).toBeNull();
  });
});

describe("isOrdinarySession", () => {
  it("accepts only a session with no role", () => {
    expect(isOrdinarySession(WORK)).toBe(true);
    expect(isOrdinarySession(CONDUCTOR)).toBe(false);
    expect(isOrdinarySession(WORKER)).toBe(false);
  });

  it("EXCLUDES a role this client has never heard of", () => {
    // The fail-safe, and the reason this is `role === undefined` rather than
    // `role !== "conductor" && role !== "worker"`. The protocol deliberately
    // allows roles a client does not know (session.create types role as an open
    // string "so a future role from a newer client still type-checks"), and the
    // negative form would silently opt every future kind into being a landing
    // target. Workers are excluded because they vanish; inheriting that risk
    // for kinds we know nothing about is the wrong default.
    const future = { id: "x", name: "x", role: "sandbox" } as unknown as SessionInfo;
    expect(isOrdinarySession(future)).toBe(false);
  });
});

describe("homeTarget — Conductor home", () => {
  const all = [WORK, CONDUCTOR, WORKER];

  it("focuses the conductor", () => {
    expect(homeTarget(all, "conductor", "api", null)).toBe("cond");
  });

  it("leaves focus alone when already on the conductor", () => {
    // null means "don't touch it" — re-focusing would reset scroll for nothing.
    expect(homeTarget(all, "conductor", "cond", null)).toBeNull();
  });

  it("leaves focus alone when no conductor exists yet", () => {
    // A normal state, not an error: the toggle offers to create one.
    expect(homeTarget([WORK, OTHER], "conductor", "api", null)).toBeNull();
  });
});

describe("homeTarget — Sessions home", () => {
  const all = [WORK, OTHER, CONDUCTOR, WORKER];

  it("returns to the session you came from", () => {
    expect(homeTarget(all, "sessions", "cond", "web")).toBe("web");
  });

  it("does nothing when you are not on the conductor", () => {
    // You are already somewhere in Sessions; moving you would be the surprise
    // this design avoids.
    expect(homeTarget(all, "sessions", "api", "web")).toBeNull();
  });

  it("falls back to an ordinary session when the remembered one is gone", () => {
    expect(homeTarget(all, "sessions", "cond", "destroyed")).toBe("api");
    expect(homeTarget(all, "sessions", "cond", null)).toBe("api");
  });

  it("never falls back onto a worker", () => {
    // Workers are disposable and die with their task — landing on one is
    // landing somewhere that is about to disappear.
    expect(homeTarget([CONDUCTOR, WORKER], "sessions", "cond", null)).toBeNull();
    expect(homeTarget([CONDUCTOR, WORKER], "sessions", "cond", "worker-scout-a")).toBeNull();
  });

  it("leaves focus alone when the conductor is the only session", () => {
    expect(homeTarget([CONDUCTOR], "sessions", "cond", null)).toBeNull();
  });

  it("never lands on an unknown future role, remembered or not", () => {
    // Same fail-safe as isOrdinarySession, asserted through the real entry
    // point: a new session kind must not become a landing target for free.
    const future = { id: "fut", name: "fut", role: "sandbox" } as unknown as SessionInfo;
    expect(homeTarget([CONDUCTOR, future], "sessions", "cond", null)).toBeNull();
    expect(homeTarget([CONDUCTOR, future], "sessions", "cond", "fut")).toBeNull();
  });
});
