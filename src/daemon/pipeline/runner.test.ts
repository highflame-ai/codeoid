import { describe, expect, test } from "bun:test";
import type { PipelineState } from "./interface";
import { type PhaseTurnHost, SessionPhaseRunner } from "./runner";

function fakePipeline(over: Partial<PipelineState> = {}): PipelineState {
  return {
    id: "p",
    name: "p",
    phases: [],
    cursor: 0,
    status: "running",
    sessionId: "sess-1",
    accountId: "a",
    projectId: "pr",
    createdBy: "u",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

type Req = Parameters<PhaseTurnHost["runPhaseOnSession"]>[0];

describe("SessionPhaseRunner", () => {
  test("drives the phase on the run's bound session (sessionId + prompt + pack/role) and returns the summary", async () => {
    const calls: Req[] = [];
    const host: PhaseTurnHost = {
      async runPhaseOnSession(req) {
        calls.push(req);
        return { finalStatus: "idle", text: "the result" };
      },
    };
    const out = await new SessionPhaseRunner(() => host).runPrompt({
      prompt: "/spec",
      provider: "gemini",
      model: "flash",
      pipeline: fakePipeline({ sessionId: "run-session", packId: "aif-sdlc" }),
      phase: { id: "one", kind: "skill", skill: "spec", role: "implementer" },
    });
    expect(out).toEqual({ summary: "the result" });
    expect(calls[0]).toMatchObject({
      sessionId: "run-session",
      prompt: "/spec",
      provider: "gemini",
      model: "flash",
      packId: "aif-sdlc",
      roleName: "implementer",
    });
  });

  test("throws when the turn ends non-idle (error / waiting_approval / timeout)", async () => {
    for (const finalStatus of ["error", "waiting_approval", "timeout"] as const) {
      const host: PhaseTurnHost = {
        async runPhaseOnSession() {
          return { finalStatus, text: "partial output" };
        },
      };
      await expect(
        new SessionPhaseRunner(() => host).runPrompt({
          prompt: "x",
          pipeline: fakePipeline(),
          phase: { id: "one", kind: "skill" },
        }),
      ).rejects.toThrow(finalStatus);
    }
  });

  test("throws when the run has no bound session (misconfiguration, fail loud — never runs a phase unbound)", async () => {
    let called = false;
    const host: PhaseTurnHost = {
      async runPhaseOnSession() {
        called = true;
        return { finalStatus: "idle", text: "" };
      },
    };
    await expect(
      new SessionPhaseRunner(() => host).runPrompt({
        prompt: "x",
        pipeline: fakePipeline({ sessionId: undefined }),
        phase: { id: "one", kind: "skill" },
      }),
    ).rejects.toThrow(/no bound session/);
    expect(called).toBe(false);
  });
});

// A failing turn must name the phase's model binding + the rung that chose it
// (docs/role-model-binding.md §5): model ids pass through unvalidated, so this
// error is the operator's only pointer to WHICH layer supplied a bad id.
test("a non-idle turn's error names the binding and its resolvedFrom rung", async () => {
  const host: PhaseTurnHost = {
    async runPhaseOnSession() {
      return { finalStatus: "error", text: "unknown model" };
    },
  };
  await expect(
    new SessionPhaseRunner(() => host).runPrompt({
      prompt: "x",
      provider: "claude",
      model: "claude-fable-9",
      pipeline: fakePipeline(),
      phase: { id: "one", kind: "skill", provider: "claude", model: "claude-fable-9", resolvedFrom: "config-tier" },
    }),
  ).rejects.toThrow('[binding: claude:claude-fable-9 ← config-tier]');
});
