import { describe, it, expect } from "vitest";

import { classifyFleetInput } from "./fleet-cards";
import { dispatchPreview, hasUnresolved, resolveTarget } from "./dispatch-preview";
import type { SessionInfo } from "../protocol/types";

const session = (id: string, name: string, over: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, name, workdir: `/repo/${name}`, status: "idle", ...over }) as SessionInfo;

const API = session("aaaa1111-2222", "api", {
  worktree: { branch: "codeoid/fix-login", path: "/repo/api" },
} as Partial<SessionInfo>);
const WEB = session("bbbb3333-4444", "web");
const SESSIONS = [API, WEB];

const card = (verb: string, input: unknown) => classifyFleetInput(`mcp__codeoid_fleet__${verb}`, input)!;

describe("resolveTarget", () => {
  it("prefers an exact name — how the conductor is told to address targets", () => {
    expect(resolveTarget("api", SESSIONS)?.id).toBe(API.id);
  });

  it("accepts an id and an unambiguous id prefix", () => {
    expect(resolveTarget(API.id, SESSIONS)?.name).toBe("api");
    expect(resolveTarget("aaaa1111", SESSIONS)?.name).toBe("api");
  });

  it("resolves an AMBIGUOUS prefix to nothing rather than guessing", () => {
    // Picking one would be a coin flip presented as a fact, on the prompt
    // whose whole job is to prevent misrouting.
    const twins = [session("dup1", "a"), session("dup2", "b")];
    expect(resolveTarget("dup", twins)).toBeNull();
  });

  it("prefers an exact name over an id prefix that also matches", () => {
    const odd = [session("zzz", "shared"), session("shared-id", "other")];
    expect(resolveTarget("shared", odd)?.id).toBe("zzz");
  });

  it("returns null for a name nothing matches", () => {
    expect(resolveTarget("ghost", SESSIONS)).toBeNull();
  });
});

describe("dispatchPreview — send-class", () => {
  it("shows repo and branch for a send, per R3", () => {
    const p = dispatchPreview(
      card("fleet_send", { session: "api", message: "run the linter" }),
      SESSIONS,
    )!;
    expect(p.kind).toBe("send");
    expect(p.content).toBe("run the linter");
    expect(p.targets).toHaveLength(1);
    expect(p.targets[0]).toMatchObject({
      name: "api",
      workdir: "/repo/api",
      branch: "codeoid/fix-login",
      unresolved: false,
    });
    expect(hasUnresolved(p)).toBe(false);
  });

  it("reports a branchless session without inventing one", () => {
    const p = dispatchPreview(card("fleet_send", { session: "web", message: "hi" }), SESSIONS)!;
    expect(p.targets[0]!.workdir).toBe("/repo/web");
    expect(p.targets[0]!.branch).toBeNull();
  });

  it("FLAGS a target that resolves to nothing", () => {
    // The case where an owner is most at risk of approving the wrong thing. A
    // prompt that quietly shows no repo reads as "no repo involved" rather
    // than "I could not tell you".
    const p = dispatchPreview(card("fleet_send", { session: "ghost", message: "x" }), SESSIONS)!;
    expect(p.targets[0]!.unresolved).toBe(true);
    expect(hasUnresolved(p)).toBe(true);
  });

  it("expands every member of a panel", () => {
    const p = dispatchPreview(
      card("fleet_panel", { sessions: ["api", "web", "ghost"], message: "review" }),
      SESSIONS,
    )!;
    expect(p.targets.map((t) => t.name)).toEqual(["api", "web", "ghost"]);
    expect(p.targets.map((t) => t.unresolved)).toEqual([false, false, true]);
    expect(p.content).toBe("review");
  });

  it("handles an interrupt, which carries a target but no content", () => {
    const p = dispatchPreview(card("fleet_interrupt", { session: "api" }), SESSIONS)!;
    expect(p.targets[0]!.workdir).toBe("/repo/api");
    expect(p.content).toBeNull();
  });

  it("survives a dispatch with no target at all", () => {
    const p = dispatchPreview(card("fleet_send", { message: "orphan" }), SESSIONS)!;
    expect(p.targets).toEqual([]);
    expect(hasUnresolved(p)).toBe(false);
  });
});

describe("dispatchPreview — spawn", () => {
  it("shows the workdir being created in, and does not cry wolf about resolution", () => {
    const p = dispatchPreview(
      card("fleet_spawn", { workdir: "/repo/new", shape: "scout", task: "investigate" }),
      SESSIONS,
    )!;
    expect(p.kind).toBe("spawn");
    expect(p.targets[0]).toMatchObject({ name: "scout", workdir: "/repo/new", unresolved: false });
    expect(p.content).toBe("investigate");
    // There is no existing session to resolve, so flagging it would fire on
    // every spawn.
    expect(hasUnresolved(p)).toBe(false);
  });
});

describe("dispatchPreview — non-dispatch", () => {
  it("returns null for a read verb, which has nothing to propose", () => {
    expect(dispatchPreview(card("fleet_find", { query: "x" }), SESSIONS)).toBeNull();
    expect(dispatchPreview(card("machine_map", {}), SESSIONS)).toBeNull();
  });

  it("returns null for an unrecognised verb rather than treating it as a send", () => {
    expect(dispatchPreview(card("fleet_detonate", {}), SESSIONS)).toBeNull();
  });
});
