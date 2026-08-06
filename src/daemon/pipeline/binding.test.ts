/**
 * The model-binding resolution chain (docs/role-model-binding.md §3) — pure, so
 * every precedence rung is asserted directly: the full ladder peels top-down,
 * each rung reports its `resolvedFrom`, and a winning rung supplies the WHOLE
 * binding (no model inheritance from a lower rung). Plus the CLI spec compiler
 * (`roleBindingsFromSpecs`) and its pipeline-only `*count` rejection.
 */

import { describe, expect, test } from "bun:test";
import {
  type ModelBindingConfig,
  type ResolveBindingInput,
  resolveBinding,
  roleBindingsFromSpecs,
} from "./binding";

const config: ModelBindingConfig = {
  modelTiers: {
    "reasoning-max": { provider: "claude", model: "claude-fable-5" },
    mechanical: { provider: "claude" }, // provider-only tier (backend default model)
  },
  modelRoles: {
    "yash-dev/adversary": { provider: "claude", model: "claude-opus-5" },
  },
};

/** Every rung populated at once — peeling from the top exercises the ladder. */
const full: ResolveBindingInput = {
  packId: "yash-dev",
  roleName: "adversary",
  role: { tier: "reasoning-max", provider: "openai", model: "gpt-5-codex" },
  cliBinding: { provider: "gemini", model: "gemini-3-pro" },
  phasePin: { provider: "codex", model: "codex-max" },
  config,
};

describe("resolveBinding — precedence ladder", () => {
  test("rung 1: CLI --role wins over everything", () => {
    expect(resolveBinding(full)).toEqual({
      provider: "gemini",
      model: "gemini-3-pro",
      resolvedFrom: "cli",
    });
  });

  test("rung 2: config modelRoles when no CLI binding", () => {
    expect(resolveBinding({ ...full, cliBinding: undefined })).toEqual({
      provider: "claude",
      model: "claude-opus-5",
      resolvedFrom: "config-role",
    });
  });

  test("rung 3: phase-level pack pin when no CLI/config-role", () => {
    expect(
      resolveBinding({ ...full, cliBinding: undefined, roleName: "other" }),
    ).toEqual({ provider: "codex", model: "codex-max", resolvedFrom: "phase-pin" });
  });

  test("rung 4: role-level YAML pin when no phase pin", () => {
    expect(
      resolveBinding({ ...full, cliBinding: undefined, roleName: "other", phasePin: undefined }),
    ).toEqual({ provider: "openai", model: "gpt-5-codex", resolvedFrom: "role-pin" });
  });

  test("rung 5: config modelTiers[tier] when the role carries no pin", () => {
    expect(
      resolveBinding({
        packId: "yash-dev",
        roleName: "verifier",
        role: { tier: "reasoning-max" },
        config,
      }),
    ).toEqual({ provider: "claude", model: "claude-fable-5", resolvedFrom: "config-tier" });
  });

  test("rung 6: no inputs at all → default (today's behavior)", () => {
    expect(resolveBinding({})).toEqual({ resolvedFrom: "default" });
  });

  test("an unmapped tier falls to default, never errors (pack portability)", () => {
    const r = resolveBinding({ role: { tier: "quantum-oracle" }, config });
    expect(r.resolvedFrom).toBe("default");
    expect(r.provider).toBeUndefined();
  });

  test("a provider-only winning rung does NOT inherit a lower rung's model", () => {
    // CLI says "claude" (default model); the phase pin's model must not leak up.
    const r = resolveBinding({
      cliBinding: { provider: "claude" },
      phasePin: { provider: "codex", model: "codex-max" },
    });
    expect(r).toEqual({ provider: "claude", model: undefined, resolvedFrom: "cli" });
  });

  test("a model-only phase pin still counts as the pin rung", () => {
    expect(resolveBinding({ phasePin: { model: "claude-sonnet-5" } })).toEqual({
      provider: undefined,
      model: "claude-sonnet-5",
      resolvedFrom: "phase-pin",
    });
  });

  test("modelRoles keying requires BOTH packId and roleName", () => {
    // Without a pack, "yash-dev/adversary" must not accidentally match.
    const r = resolveBinding({ roleName: "adversary", config });
    expect(r.resolvedFrom).toBe("default");
  });

  test("a provider-only tier map entry resolves to that backend's default model", () => {
    expect(resolveBinding({ role: { tier: "mechanical" }, config })).toEqual({
      provider: "claude",
      model: undefined,
      resolvedFrom: "config-tier",
    });
  });
});

describe("roleBindingsFromSpecs", () => {
  test("compiles parsed specs into the bindings map", () => {
    expect(
      roleBindingsFromSpecs([
        { name: "adversary", providerId: "claude", model: "claude-fable-5" },
        { name: "verifier", providerId: "claude" },
      ]),
    ).toEqual({
      adversary: { provider: "claude", model: "claude-fable-5" },
      verifier: { provider: "claude" },
    });
  });

  test("rejects *count — fan-out is a collaboration concept", () => {
    expect(() =>
      roleBindingsFromSpecs([{ name: "review", providerId: "gemini", count: 3 }]),
    ).toThrow("fan-out is a collaboration concept; pipelines run one session per phase");
    // Even *1 is a category error, not a harmless no-op — reject uniformly.
    expect(() =>
      roleBindingsFromSpecs([{ name: "review", providerId: "gemini", count: 1 }]),
    ).toThrow("fan-out is a collaboration concept");
  });

  test("rejects the same role bound twice", () => {
    expect(() =>
      roleBindingsFromSpecs([
        { name: "adversary", providerId: "claude" },
        { name: "adversary", providerId: "gemini" },
      ]),
    ).toThrow('--role "adversary" bound more than once');
  });
});
