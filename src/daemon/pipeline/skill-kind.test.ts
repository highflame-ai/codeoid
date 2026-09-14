import { describe, expect, test } from "bun:test";
import type { PhaseCtx, PhaseDef, PipelineState, SkillPlugin } from "./interface";
import { createRegistries } from "./registry";
import type { PhaseRunner, PhaseRunRequest } from "./runner";
import { makeSkillPhaseKind } from "./skill-kind";

function ctxFor(phase: PhaseDef, skills: SkillPlugin[], packId?: string): PhaseCtx {
  const registries = createRegistries();
  for (const s of skills) registries.skills.register(s);
  const pipeline: PipelineState = {
    id: "p",
    name: "p",
    ...(packId ? { packId } : {}),
    phases: [{ def: phase, state: { status: "running", startedAt: 1, attempts: 0 } }],
    cursor: 0,
    status: "running",
    accountId: "a",
    projectId: "p",
    createdBy: "u",
    createdAt: 1,
    updatedAt: 1,
  };
  return { pipeline, phase, registries };
}

describe("skill phase kind", () => {
  test("resolves the run's pack-scoped skill before a bare one of the same id", async () => {
    const bare: SkillPlugin = {
      id: "hello",
      kind: "fn",
      async run() {
        return { summary: "bare" };
      },
    };
    const scoped: SkillPlugin = {
      id: "mypack/hello",
      kind: "fn",
      async run() {
        return { summary: "scoped" };
      },
    };
    const kind = makeSkillPhaseKind();
    const phase: PhaseDef = { id: "one", kind: "skill", skill: "hello" };
    // With a packId the pack's own entry wins; without one the bare entry resolves.
    expect(await kind.run(ctxFor(phase, [bare, scoped], "mypack"))).toMatchObject({ summary: "scoped" });
    expect(await kind.run(ctxFor(phase, [bare, scoped]))).toMatchObject({ summary: "bare" });
    // A pack run whose pack didn't declare the id still falls back to bare.
    expect(await kind.run(ctxFor(phase, [bare], "mypack"))).toMatchObject({ summary: "bare" });
  });

  test("runs an fn skill natively and passes with its summary", async () => {
    const skill: SkillPlugin = {
      id: "hello",
      kind: "fn",
      async run() {
        return { summary: "did the thing", artifacts: ["out.md"] };
      },
    };
    const kind = makeSkillPhaseKind();
    const res = await kind.run(ctxFor({ id: "one", kind: "skill", skill: "hello" }, [skill]));
    expect(res).toEqual({ outcome: "passed", summary: "did the thing", artifacts: ["out.md"] });
  });

  test("a throwing fn skill fails gracefully", async () => {
    const skill: SkillPlugin = {
      id: "boom",
      kind: "fn",
      async run() {
        throw new Error("fn-boom");
      },
    };
    const res = await makeSkillPhaseKind().run(ctxFor({ id: "one", kind: "skill", skill: "boom" }, [skill]));
    expect(res.outcome).toBe("failed");
    if (res.outcome === "failed") expect(res.reason).toContain("fn-boom");
  });

  test("fails when the phase declares no skill id", async () => {
    const res = await makeSkillPhaseKind().run(ctxFor({ id: "one", kind: "skill" }, []));
    expect(res.outcome).toBe("failed");
    if (res.outcome === "failed") expect(res.reason).toContain("no skill id");
  });

  test("fails on an unknown skill", async () => {
    const res = await makeSkillPhaseKind().run(ctxFor({ id: "one", kind: "skill", skill: "nope" }, []));
    expect(res.outcome).toBe("failed");
    if (res.outcome === "failed") expect(res.reason).toContain("unknown skill");
  });

  test("a prompt/slash skill fails cleanly when no runner is configured", async () => {
    const skill: SkillPlugin = { id: "spec", kind: "slash", command: "/spec" };
    const res = await makeSkillPhaseKind().run(ctxFor({ id: "one", kind: "skill", skill: "spec" }, [skill]));
    expect(res.outcome).toBe("failed");
    if (res.outcome === "failed") expect(res.reason).toContain("needs a phase runner");
  });

  test("frames the goal as CONTEXT and scopes the model to THIS phase's deliverable", async () => {
    let prompt = "";
    const runner: PhaseRunner = {
      async runPrompt(req) {
        prompt = req.prompt;
        return { summary: "ok" };
      },
    };
    const skill: SkillPlugin = { id: "spec", kind: "slash", command: "/spec" };
    const ctx = ctxFor({ id: "one", kind: "skill", skill: "spec" }, [skill]);
    ctx.pipeline.spec = "Build a rate limiter";
    await makeSkillPhaseKind(runner).run(ctx);
    // The overall goal is present as CONTEXT, not as "the task to complete now".
    expect(prompt).toContain("Build a rate limiter");
    expect(prompt).toContain("Overall goal (context");
    expect(prompt).toContain("target for THIS phase");
    // The old whole-feature framing is gone (it caused spec→implement scope creep).
    expect(prompt).not.toContain("## Goal / feature");
  });

  test("drives a prompt/slash skill through the runner with per-phase provider/model", async () => {
    const seen: PhaseRunRequest[] = [];
    const runner: PhaseRunner = {
      async runPrompt(req) {
        seen.push(req);
        return { summary: "ran on backend" };
      },
    };
    const skill: SkillPlugin = { id: "spec", kind: "slash", command: "/spec" };
    const phase: PhaseDef = { id: "one", kind: "skill", skill: "spec", provider: "gemini", model: "flash" };
    const res = await makeSkillPhaseKind(runner).run(ctxFor(phase, [skill]));
    expect(res).toEqual({ outcome: "passed", summary: "ran on backend", artifacts: undefined });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ prompt: "/spec", provider: "gemini", model: "flash" });
  });
});
