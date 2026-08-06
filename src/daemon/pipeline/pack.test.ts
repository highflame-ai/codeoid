/**
 * Declarative pack loader + create-from-pack. Packs are DATA on disk (pack.yaml
 * + role files + constitution) — these tests write real fixture dirs, load them,
 * and run a pack-defined pipeline end-to-end, plus every fail-fast path.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistries } from "./registry";
import type { PhaseDef } from "./interface";
import { PipelineManager } from "./manager";
import { loadPack } from "./pack";
import { PipelineStore } from "./store";

const tenant = { accountId: "acct", projectId: "proj", createdBy: "user" };

const EXPLORER_ROLE = `name: explorer
summary: read-only scout
write: false
network: read-only
envelope: [read, grep, glob, bash]
`;
const IMPLEMENTER_ROLE = `name: implementer
write: true
network: read-only
envelope: all
`;
const ETHOS = "# Ethos\nDo good work.\n";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

/** Write a pack directory: pack.yaml + optional roles/ + ETHOS.md. */
function writePack(
  manifest: string,
  opts: { roles?: Record<string, string>; ethos?: string } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "codeoid-pack-"));
  dirs.push(dir);
  writeFileSync(join(dir, "pack.yaml"), manifest);
  if (opts.roles) {
    mkdirSync(join(dir, "roles"), { recursive: true });
    for (const [f, body] of Object.entries(opts.roles)) writeFileSync(join(dir, "roles", f), body);
  }
  if (opts.ethos) writeFileSync(join(dir, "ETHOS.md"), opts.ethos);
  return dir;
}

const FULL_MANIFEST = `schema: codeoid/pack@v1
id: aif-test
name: AIF Test
version: 1.2.3
description: fixture pack
constitution: ./ETHOS.md
roles:
  - ./roles/explorer.yaml
  - ./roles/implementer.yaml
skills:
  - id: spec
    kind: slash
    command: /spec
  - id: build
    kind: prompt
    template: Build it well.
gates:
  - id: tests_pass
    kind: command
    run: "true"
    at: exit
phases:
  - id: explore
    kind: skill
    skill: spec
    role: explorer
  - id: implement
    kind: skill
    skill: build
    role: implementer
    gate: tests_pass
    onFail:
      retry: 2
`;

function fullPack(): string {
  return writePack(FULL_MANIFEST, {
    roles: { "explorer.yaml": EXPLORER_ROLE, "implementer.yaml": IMPLEMENTER_ROLE },
    ethos: ETHOS,
  });
}

describe("loadPack", () => {
  test("parses manifest, roles, constitution, and compiles the pipeline", () => {
    const pack = loadPack(fullPack());
    expect(pack.id).toBe("aif-test");
    expect(pack.name).toBe("AIF Test");
    expect(pack.version).toBe("1.2.3");
    expect(pack.description).toBe("fixture pack");
    expect(pack.constitution).toContain("Do good work");

    expect(Object.keys(pack.roles).sort()).toEqual(["explorer", "implementer"]);
    expect(pack.roles.explorer).toMatchObject({ write: false, network: "read-only" });
    expect(pack.roles.explorer.envelope).toEqual(["read", "grep", "glob", "bash"]);
    expect(pack.roles.implementer).toMatchObject({ write: true, envelope: "all" });

    expect(pack.pipeline).toHaveLength(2);
    expect(pack.pipeline[0]).toMatchObject({ id: "explore", kind: "skill", skill: "spec", role: "explorer" });
    expect(pack.pipeline[1]).toMatchObject({ id: "implement", gate: "tests_pass", role: "implementer" });
    // pack `retry: 2` → 2 retries → 3 total attempts (engine `max` is total).
    expect(pack.pipeline[1].onFail).toEqual({ action: "retry", max: 3 });
  });

  test("register() installs the pack's skills + gates into the registries", () => {
    const mgr = new PipelineManager(new PipelineStore(new Database(":memory:")));
    mgr.installPack(loadPack(fullPack()));
    expect(mgr.registries.skills.has("spec")).toBe(true);
    expect(mgr.registries.skills.has("build")).toBe(true);
    expect(mgr.registries.gates.has("tests_pass")).toBe(true);
    expect(mgr.registries.packs.has("aif-test")).toBe(true);
  });

  test("kind defaults to 'skill' when a phase declares only a skill", () => {
    const dir = writePack(`schema: codeoid/pack@v1
id: p
name: P
version: 0.1.0
skills:
  - id: s
    kind: slash
    command: /s
phases:
  - id: only
    skill: s
`);
    expect(loadPack(dir).pipeline[0]).toMatchObject({ id: "only", kind: "skill", skill: "s" });
  });

  test("throws when pack.yaml is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "codeoid-pack-"));
    dirs.push(dir);
    expect(() => loadPack(dir)).toThrow("cannot read pack.yaml");
  });

  test("throws on a wrong schema literal", () => {
    const dir = writePack(`schema: nope/v9
id: p
name: P
version: 0.1.0
phases:
  - id: a
    kind: noop
`);
    expect(() => loadPack(dir)).toThrow("invalid pack.yaml");
  });

  test("throws on a phase referencing an unknown skill", () => {
    const dir = writePack(`schema: codeoid/pack@v1
id: p
name: P
version: 0.1.0
phases:
  - id: a
    kind: skill
    skill: ghost
`);
    expect(() => loadPack(dir)).toThrow('unknown skill "ghost"');
  });

  test("throws on a phase referencing an unknown role", () => {
    const dir = writePack(`schema: codeoid/pack@v1
id: p
name: P
version: 0.1.0
phases:
  - id: a
    kind: noop
    role: nobody
`);
    expect(() => loadPack(dir)).toThrow('unknown role "nobody"');
  });

  test("throws on duplicate phase ids", () => {
    const dir = writePack(`schema: codeoid/pack@v1
id: p
name: P
version: 0.1.0
phases:
  - id: a
    kind: noop
  - id: a
    kind: noop
`);
    expect(() => loadPack(dir)).toThrow("duplicate phase id");
  });

  test("rejects a constitution path that escapes the pack dir (traversal)", () => {
    const dir = writePack(`schema: codeoid/pack@v1
id: p
name: P
version: 0.1.0
constitution: ../../../../etc/passwd
phases:
  - id: a
    kind: noop
`);
    expect(() => loadPack(dir)).toThrow("escapes the pack directory");
  });

  test("rejects a symlinked file that escapes the pack dir (symlink confinement)", () => {
    const dir = writePack(`schema: codeoid/pack@v1
id: p
name: P
version: 0.1.0
constitution: ./leak.md
phases:
  - id: a
    kind: noop
`);
    // A secret outside the pack, and a symlink INSIDE the pack pointing at it —
    // lexically the path is under the pack dir, so only realpath catches it.
    const outside = mkdtempSync(join(tmpdir(), "codeoid-outside-"));
    dirs.push(outside);
    writeFileSync(join(outside, "secret.md"), "TOP SECRET");
    symlinkSync(join(outside, "secret.md"), join(dir, "leak.md"));
    expect(() => loadPack(dir)).toThrow("escapes the pack directory");
  });

  test("rejects an absolute role path (arbitrary file read)", () => {
    const dir = writePack(`schema: codeoid/pack@v1
id: p
name: P
version: 0.1.0
roles:
  - /etc/passwd
phases:
  - id: a
    kind: noop
`);
    expect(() => loadPack(dir)).toThrow("escapes the pack directory");
  });

  test("throws when a phase has neither kind nor skill", () => {
    const dir = writePack(`schema: codeoid/pack@v1
id: p
name: P
version: 0.1.0
phases:
  - id: a
    role: explorer
`);
    expect(() => loadPack(dir)).toThrow("needs a kind or a skill");
  });
});

describe("create({ pack })", () => {
  function noopPack(gateBody: string, phaseGate: string): string {
    return writePack(`schema: codeoid/pack@v1
id: noop-pack
name: Noop
version: 0.0.1
gates:
${gateBody}
phases:
  - id: a
    kind: noop
    gate: ${phaseGate}
  - id: b
    kind: noop
    gate: always
`);
  }

  test("walks a pack-defined pipeline: halts at each boundary, approving each reaches done", async () => {
    const mgr = new PipelineManager(new PipelineStore(new Database(":memory:")));
    mgr.installPack(loadPack(noopPack('  - id: green\n    kind: command\n    run: "true"', "green"), { trusted: true }));
    const p = mgr.create({ name: "run", pack: "noop-pack", ...tenant });
    expect(p.status).toBe("draft");
    expect(p.phases.map((ph) => ph.def.id)).toEqual(["a", "b"]);
    // Phase "a" runs, its command gate passes, then it HALTS for human review
    // (a passing gate does not auto-advance).
    let s = await mgr.advance(p.id);
    expect(s.status).toBe("halted");
    expect(s.cursor).toBe(0);
    let st = s.phases[s.cursor].state;
    if (st.status !== "halted") throw new Error("expected halt at phase a");
    // Approve → phase "b" runs + halts.
    s = await mgr.answer(p.id, st.requestId, { approved: true });
    expect(s.status).toBe("halted");
    expect(s.cursor).toBe(1);
    st = s.phases[s.cursor].state;
    if (st.status !== "halted") throw new Error("expected halt at phase b");
    // Approve the last boundary → done.
    s = await mgr.answer(p.id, st.requestId, { approved: true });
    expect(s.status).toBe("done");
    expect(s.phases.every((ph) => ph.state.status === "passed")).toBe(true);
  });

  test("a failing trusted command gate halts the pipeline with the gate reason", async () => {
    const mgr = new PipelineManager(new PipelineStore(new Database(":memory:")));
    mgr.installPack(loadPack(noopPack('  - id: red\n    kind: command\n    run: "false"', "red"), { trusted: true }));
    const p = mgr.create({ name: "run", pack: "noop-pack", ...tenant });
    const halted = await mgr.advance(p.id);
    expect(halted.status).toBe("halted");
    expect(halted.phases[0].state.status).toBe("halted");
    if (halted.phases[0].state.status === "halted") {
      expect(halted.phases[0].state.reason).toContain("command gate");
    }
  });

  test("an UNTRUSTED command gate never executes — fails closed (registry default)", async () => {
    const mgr = new PipelineManager(new PipelineStore(new Database(":memory:")));
    // No { trusted } → default false. Even a "true" command must not run.
    mgr.installPack(loadPack(noopPack('  - id: green\n    kind: command\n    run: "true"', "green")));
    const p = mgr.create({ name: "run", pack: "noop-pack", ...tenant });
    const halted = await mgr.advance(p.id);
    expect(halted.status).toBe("halted");
    if (halted.phases[0].state.status === "halted") {
      expect(halted.phases[0].state.reason).toContain("requires a trusted pack");
    }
  });

  test("a self/skill/review gate carries no automated verdict — the phase halts for human review (no 'not yet enforced')", async () => {
    const dir = writePack(`schema: codeoid/pack@v1
id: self-pack
name: Self
version: 0.0.1
gates:
  - id: reflect
    kind: self
phases:
  - id: a
    kind: noop
    gate: reflect
`);
    const mgr = new PipelineManager(new PipelineStore(new Database(":memory:")));
    mgr.installPack(loadPack(dir));
    const p = mgr.create({ name: "run", pack: "self-pack", ...tenant });
    const halted = await mgr.advance(p.id);
    expect(halted.status).toBe("halted");
    const st = halted.phases[0].state;
    expect(st.status).toBe("halted");
    if (st.status === "halted") {
      // No fake "not yet enforced" fail-closed halt — a clean human-review boundary.
      expect(st.reason).not.toContain("not yet enforced");
      expect(st.reason).toContain("review and approve");
    }
  });

  test("throws on an unknown pack id", () => {
    const mgr = new PipelineManager(new PipelineStore(new Database(":memory:")));
    expect(() => mgr.create({ name: "x", pack: "ghost", ...tenant })).toThrow("unknown pack");
  });

  test("throws when both phases and pack are given", () => {
    const mgr = new PipelineManager(new PipelineStore(new Database(":memory:")));
    mgr.installPack(loadPack(fullPack()));
    expect(() =>
      mgr.create({ name: "x", pack: "aif-test", phases: [{ id: "one", kind: "noop" }], ...tenant }),
    ).toThrow("either");
  });

  test("throws when neither phases nor pack is given", () => {
    const mgr = new PipelineManager(new PipelineStore(new Database(":memory:")));
    expect(() => mgr.create({ name: "x", ...tenant })).toThrow("provide");
  });
});


const PROBE_MANIFEST = `schema: codeoid/pack@v1
id: probe-pack
name: Probe Pack
version: 1.0.0
skills:
  - id: spec
    kind: slash
    command: /spec
gates:
  - id: spec-done
    kind: probe
    probe: { type: file-exists, paths: ["spec.md"] }
    at: exit
  - id: impl-verify
    kind: probe
    probe: { type: verify }
    at: exit
phases:
  - id: spec
    skill: spec
    gate: spec-done
    skipWhenSatisfied: true
  - id: implement
    skill: spec
    gate: impl-verify
    onFail: { retry: 2 }
`;

describe("pack loader — probe gates", () => {
  test("parses probe gates + skipWhenSatisfied into the phase defs and gateSpecs", () => {
    const pack = loadPack(writePack(PROBE_MANIFEST));
    expect(pack.pipeline[0]).toMatchObject({ id: "spec", gate: "spec-done", skipWhenSatisfied: true });
    expect(pack.pipeline[1]).toMatchObject({ id: "implement", gate: "impl-verify" });
    expect(pack.pipeline[1].skipWhenSatisfied).toBeUndefined(); // default off
    expect(pack.gateSpecs).toContainEqual({ id: "spec-done", kind: "probe" });
    expect(pack.gateSpecs).toContainEqual({ id: "impl-verify", kind: "probe" });
  });

  test("a registered file-exists probe evaluates against the run's workdir", async () => {
    const pack = loadPack(writePack(PROBE_MANIFEST));
    const r = createRegistries();
    pack.register(r);
    const gate = r.gates.resolve("spec-done");
    expect(gate).toBeDefined();

    const workdir = mkdtempSync(join(tmpdir(), "probe-wd-"));
    dirs.push(workdir);
    const mkCtx = () => ({
      pipeline: { workdir } as never,
      phase: { id: "spec", kind: "skill" as const },
    });
    // Absent → fail; present → pass.
    expect((await gate!.evaluate(mkCtx())).pass).toBe(false);
    writeFileSync(join(workdir, "spec.md"), "# spec");
    expect((await gate!.evaluate(mkCtx())).pass).toBe(true);
  });

  test("a probe path that escapes the workdir (`..`) is rejected at load", () => {
    const manifest = `schema: codeoid/pack@v1
id: evil-pack
name: Evil
version: 1.0.0
gates:
  - id: peek
    kind: probe
    probe: { type: file-exists, paths: ["../../../../etc/passwd"] }
phases:
  - id: one
    kind: noop
    gate: peek
`;
    expect(() => loadPack(writePack(manifest))).toThrow(/workdir|relative/);
  });

  test("an execution probe (verify) fails closed on an untrusted pack", async () => {
    const pack = loadPack(writePack(PROBE_MANIFEST) /* trusted defaults to false */);
    const r = createRegistries();
    pack.register(r);
    const workdir = mkdtempSync(join(tmpdir(), "probe-wd-"));
    dirs.push(workdir);
    writeFileSync(join(workdir, "go.mod"), "module x\n");
    const v = await r.gates.resolve("impl-verify")!.evaluate({
      pipeline: { workdir } as never,
      phase: { id: "implement", kind: "skill" },
    });
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("requires a trusted pack");
  });
});

// ── Auto-skip end-to-end through the manager (docs/pipeline-phase-detection.md)

const SKIP_MANIFEST = `schema: codeoid/pack@v1
id: skip-pack
name: Skip Pack
version: 1.0.0
gates:
  - id: spec-done
    kind: probe
    probe: { type: file-exists, paths: ["spec.md"] }
    at: exit
phases:
  - id: spec
    kind: noop
    gate: spec-done
    skipWhenSatisfied: true
`;

describe("pipeline auto-skip (manager end-to-end)", () => {
  test("a phase whose deliverable already exists in the workdir is skipped, not run", async () => {
    const mgr = new PipelineManager(new PipelineStore(new Database(":memory:")));
    mgr.installPack(loadPack(writePack(SKIP_MANIFEST)));
    const workdir = mkdtempSync(join(tmpdir(), "skip-wd-"));
    dirs.push(workdir);
    writeFileSync(join(workdir, "spec.md"), "# already written");

    const p = mgr.create({ name: "run", pack: "skip-pack", workdir, ...tenant });
    const s = await mgr.advance(p.id);

    expect(s.status).toBe("done");
    expect(s.phases[0].state.status).toBe("skipped");
    const st = s.phases[0].state;
    if (st.status === "skipped") expect(st.reason).toContain("already present");
  });

  test("the same phase RUNS (does not skip) when the deliverable is absent", async () => {
    const mgr = new PipelineManager(new PipelineStore(new Database(":memory:")));
    mgr.installPack(loadPack(writePack(SKIP_MANIFEST)));
    const workdir = mkdtempSync(join(tmpdir(), "skip-wd-"));
    dirs.push(workdir); // empty — no spec.md

    const p = mgr.create({ name: "run", pack: "skip-pack", workdir, ...tenant });
    const s = await mgr.advance(p.id);

    // Not skipped: it ran, then the exit probe failed (no spec.md) → halted for a human.
    expect(s.phases[0].state.status).toBe("halted");
  });
});

// ── Per-role model binding (docs/role-model-binding.md) ────────────────────

/** A pack whose roles exercise every pack-side binding source: a tier, a
 *  role-level pin, and a phase-level pin. */
const BINDING_MANIFEST = `schema: codeoid/pack@v1
id: bind-pack
name: Binding
version: 0.0.1
roles:
  - ./roles/adversary.yaml
  - ./roles/scribe.yaml
  - ./roles/pinned.yaml
phases:
  - id: attack
    kind: noop
    role: adversary
  - id: write-up
    kind: noop
    role: scribe
  - id: pinned-phase
    kind: noop
    role: pinned
    provider: codex
    model: codex-max
`;
const ADVERSARY_ROLE = `name: adversary
tier: reasoning-max
write: false
network: read-only
envelope: [read, grep]
`;
const SCRIBE_ROLE = `name: scribe
write: true
network: false
envelope: all
`;
const PINNED_ROLE = `name: pinned
tier: reasoning-max
provider: openai
model: gpt-5-codex
write: false
network: false
envelope: all
`;

function bindingPack(): string {
  return writePack(BINDING_MANIFEST, {
    roles: { "adversary.yaml": ADVERSARY_ROLE, "scribe.yaml": SCRIBE_ROLE, "pinned.yaml": PINNED_ROLE },
  });
}

const TIERS = { "reasoning-max": { provider: "claude", model: "claude-fable-5" } };

describe("role tier schema (loadPack)", () => {
  test("tier parses and is carried on the RoleDef", () => {
    const pack = loadPack(bindingPack());
    expect(pack.roles.adversary.tier).toBe("reasoning-max");
    expect(pack.roles.scribe.tier).toBeUndefined();
    // The role-level pin (fleet path) is also carried — binding rung 4.
    expect(pack.roles.pinned).toMatchObject({ provider: "openai", model: "gpt-5-codex" });
  });

  test("rejects an empty tier and one over 64 chars", () => {
    const bad = (tier: string) =>
      writePack(
        "schema: codeoid/pack@v1\nid: p\nname: P\nversion: 0.0.1\nroles: [./roles/r.yaml]\nphases:\n  - id: a\n    kind: noop\n",
        { roles: { "r.yaml": `name: r\ntier: "${tier}"\nwrite: false\nenvelope: all\n` } },
      );
    expect(() => loadPack(bad(""))).toThrow("invalid role");
    expect(() => loadPack(bad("x".repeat(65)))).toThrow("invalid role");
  });
});

describe("model binding at create (manager)", () => {
  test("resolves per phase and persists {provider, model, resolvedFrom}", () => {
    const mgr = new PipelineManager(new PipelineStore(new Database(":memory:")));
    mgr.installPack(loadPack(bindingPack()));
    const p = mgr.create({ name: "run", pack: "bind-pack", ...tenant, modelConfig: { modelTiers: TIERS } });

    // attack: tier mapped by config → config-tier rung.
    expect(p.phases[0].def).toMatchObject({
      provider: "claude",
      model: "claude-fable-5",
      resolvedFrom: "config-tier",
    });
    // write-up: no tier, no pins, no bindings → untouched (absent = default).
    expect(p.phases[1].def.provider).toBeUndefined();
    expect(p.phases[1].def.resolvedFrom).toBeUndefined();
    // pinned-phase: the phase pin outranks both the role pin and the tier map.
    expect(p.phases[2].def).toMatchObject({
      provider: "codex",
      model: "codex-max",
      resolvedFrom: "phase-pin",
    });
  });

  test("CLI roleBindings outrank every pack-side source, wholesale", () => {
    const mgr = new PipelineManager(new PipelineStore(new Database(":memory:")));
    mgr.installPack(loadPack(bindingPack()));
    const p = mgr.create({
      name: "run",
      pack: "bind-pack",
      ...tenant,
      roleBindings: { pinned: { provider: "gemini" } }, // provider-only, on the pinned role
      modelConfig: { modelTiers: TIERS },
    });
    // The CLI's provider-only binding replaces the pin ENTIRELY: no model
    // inherited from the phase pin (gemini's default model, not codex-max).
    expect(p.phases[2].def.provider).toBe("gemini");
    expect(p.phases[2].def.model).toBeUndefined();
    expect(p.phases[2].def.resolvedFrom).toBe("cli");
  });

  test("role-level pin wins when the phase carries none (rung 4)", () => {
    const mgr = new PipelineManager(new PipelineStore(new Database(":memory:")));
    // Same pack, but the phase-level pin removed from pinned-phase.
    const manifest = BINDING_MANIFEST.replace("    provider: codex\n    model: codex-max\n", "");
    mgr.installPack(
      loadPack(
        writePack(manifest, {
          roles: { "adversary.yaml": ADVERSARY_ROLE, "scribe.yaml": SCRIBE_ROLE, "pinned.yaml": PINNED_ROLE },
        }),
      ),
    );
    const p = mgr.create({ name: "run", pack: "bind-pack", ...tenant, modelConfig: { modelTiers: TIERS } });
    expect(p.phases[2].def).toMatchObject({
      provider: "openai",
      model: "gpt-5-codex",
      resolvedFrom: "role-pin",
    });
  });

  test("config modelRoles outranks the phase pin (rung 2 vs 3)", () => {
    const mgr = new PipelineManager(new PipelineStore(new Database(":memory:")));
    mgr.installPack(loadPack(bindingPack()));
    const p = mgr.create({
      name: "run",
      pack: "bind-pack",
      ...tenant,
      modelConfig: { modelRoles: { "bind-pack/pinned": { provider: "claude", model: "claude-opus-5" } } },
    });
    expect(p.phases[2].def).toMatchObject({
      provider: "claude",
      model: "claude-opus-5",
      resolvedFrom: "config-role",
    });
  });

  test("persisted bindings survive a config change (deterministic resume)", () => {
    const store = new PipelineStore(new Database(":memory:"));
    const mgr = new PipelineManager(store);
    mgr.installPack(loadPack(bindingPack()));
    // The config object is read ONCE at create — mutate it afterwards.
    const modelConfig = { modelTiers: { ...TIERS } };
    const p = mgr.create({ name: "run", pack: "bind-pack", ...tenant, modelConfig });
    modelConfig.modelTiers["reasoning-max"] = { provider: "openai", model: "o9" };

    // The live manager AND a restarted one (fresh manager, same store) both
    // report the binding resolved at create, not the mutated config.
    expect(mgr.get(p.id)?.phases[0].def.model).toBe("claude-fable-5");
    const revived = new PipelineManager(store);
    expect(revived.get(p.id)?.phases[0].def).toMatchObject({
      provider: "claude",
      model: "claude-fable-5",
      resolvedFrom: "config-tier",
    });
  });

  test("binding at create does not mutate the installed pack's shared phase defs", () => {
    const mgr = new PipelineManager(new PipelineStore(new Database(":memory:")));
    const loaded = loadPack(bindingPack());
    mgr.installPack(loaded);
    mgr.create({ name: "run", pack: "bind-pack", ...tenant, modelConfig: { modelTiers: TIERS } });
    // The registry's defs stay pristine — a second run must re-resolve fresh.
    expect(loaded.pipeline[0].provider).toBeUndefined();
    expect(loaded.pipeline[0].resolvedFrom).toBeUndefined();
  });

  test("unknown role in roleBindings is a create-time error listing the pack's roles", () => {
    const mgr = new PipelineManager(new PipelineStore(new Database(":memory:")));
    mgr.installPack(loadPack(bindingPack()));
    expect(() =>
      mgr.create({ name: "run", pack: "bind-pack", ...tenant, roleBindings: { adversry: { provider: "claude" } } }),
    ).toThrow('unknown role "adversry" in role bindings — pack "bind-pack" declares: adversary, scribe, pinned');
  });

  test("explicit-phases plans validate bindings against the phases' role names", () => {
    const mgr = new PipelineManager(new PipelineStore(new Database(":memory:")));
    const phases: PhaseDef[] = [{ id: "a", kind: "noop", role: "worker" }];
    expect(() =>
      mgr.create({ name: "run", phases, ...tenant, roleBindings: { ghost: { provider: "claude" } } }),
    ).toThrow('unknown role "ghost" in role bindings — the phase plan declares: worker');
    // A binding for a declared role applies (cli rung), even without a pack.
    const p = mgr.create({ name: "run", phases, ...tenant, roleBindings: { worker: { provider: "claude", model: "m" } } });
    expect(p.phases[0].def).toMatchObject({ provider: "claude", model: "m", resolvedFrom: "cli" });
  });

  test("an unmapped tier resolves to default (no binding persisted, no error)", () => {
    const mgr = new PipelineManager(new PipelineStore(new Database(":memory:")));
    mgr.installPack(loadPack(bindingPack()));
    // No modelConfig at all — the adversary tier has nowhere to land.
    const p = mgr.create({ name: "run", pack: "bind-pack", ...tenant });
    expect(p.phases[0].def.provider).toBeUndefined();
    expect(p.phases[0].def.resolvedFrom).toBeUndefined();
  });

  // ── The run session's provider is authoritative (§3) ──────────────────────
  // A run drives ONE bound session on one backend; a binding naming a
  // different provider is skipped at create with a warning naming the rung —
  // same rule as collab adoption — and is NEVER persisted as effective.

  test("a binding naming a provider other than the run session's is skipped with a warning", () => {
    const mgr = new PipelineManager(new PipelineStore(new Database(":memory:")));
    mgr.installPack(loadPack(bindingPack()));
    const warnings: string[] = [];
    const p = mgr.create({
      name: "run",
      pack: "bind-pack",
      ...tenant,
      modelConfig: { modelTiers: TIERS },
      sessionProvider: "codex",
      warn: (m) => warnings.push(m),
    });
    // attack: config-tier resolves to claude ≠ codex → skipped, nothing persisted.
    expect(p.phases[0].def.provider).toBeUndefined();
    expect(p.phases[0].def.model).toBeUndefined();
    expect(p.phases[0].def.resolvedFrom).toBeUndefined();
    // pinned-phase: the codex phase pin MATCHES the session provider → applies.
    expect(p.phases[2].def).toMatchObject({
      provider: "codex",
      model: "codex-max",
      resolvedFrom: "phase-pin",
    });
    // The warning names the rung to fix, and only the skipped binding warned.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/config-tier/);
    expect(warnings[0]).toMatch(/"claude"/);
    expect(warnings[0]).toMatch(/"codex"/);
  });

  test("a skipped binding strips the phase's own pin fields — never rendered as effective", () => {
    const mgr = new PipelineManager(new PipelineStore(new Database(":memory:")));
    mgr.installPack(loadPack(bindingPack()));
    const warnings: string[] = [];
    const p = mgr.create({
      name: "run",
      pack: "bind-pack",
      ...tenant,
      sessionProvider: "claude",
      warn: (m) => warnings.push(m),
    });
    // pinned-phase's own codex pin ≠ claude session → the def must come out
    // CLEAN (persisting the pin would display a binding that won't apply).
    expect(p.phases[2].def.provider).toBeUndefined();
    expect(p.phases[2].def.model).toBeUndefined();
    expect(p.phases[2].def.resolvedFrom).toBeUndefined();
    expect(warnings.join("\n")).toMatch(/phase-pin/);
  });

  test("a model-only pin is validated for the session's backend — skipped when vendor-shaped elsewhere", () => {
    const mgr = new PipelineManager(new PipelineStore(new Database(":memory:")));
    const phases: PhaseDef[] = [{ id: "a", kind: "noop", model: "opus" }];
    // "opus" is a Claude alias: on a codex-bound run session it must NOT ride
    // through — skip with a warning, never a hard failure (§5: the operator
    // never typed this model at create).
    const warnings: string[] = [];
    const skipped = mgr.create({
      name: "run",
      phases,
      ...tenant,
      sessionProvider: "codex",
      warn: (m) => warnings.push(m),
    });
    expect(skipped.phases[0].def.model).toBeUndefined();
    expect(skipped.phases[0].def.resolvedFrom).toBeUndefined();
    expect(warnings.join("\n")).toMatch(/not valid for provider "codex"/);
    // On a claude session the same pin applies (validation passes; the typed
    // string is persisted, not its alias expansion).
    const applied = mgr.create({ name: "run2", phases, ...tenant, sessionProvider: "claude" });
    expect(applied.phases[0].def).toMatchObject({ model: "opus", resolvedFrom: "phase-pin" });
  });

  test("role bindings match role names case-insensitively (one rule with the collab path)", () => {
    const mgr = new PipelineManager(new PipelineStore(new Database(":memory:")));
    mgr.installPack(loadPack(bindingPack()));
    const p = mgr.create({
      name: "run",
      pack: "bind-pack",
      ...tenant,
      roleBindings: { Adversary: { provider: "claude", model: "claude-x" } },
    });
    expect(p.phases[0].def).toMatchObject({
      provider: "claude",
      model: "claude-x",
      resolvedFrom: "cli",
    });
  });
});
