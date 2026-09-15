/**
 * The findings loop as pack DATA: `findings:` on a phase compiles to a
 * FindingsSpec with defaults, refuses a read-only or unknown fix role, the
 * `review` gate kind produces a real verdict from the loop state, and create
 * binds the fix leg's model through the same rungs as a phase.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newLoopState } from "./findings";
import type { PipelineState } from "./interface";
import { PipelineManager } from "./manager";
import { loadPack } from "./pack";
import { createRegistries } from "./registry";
import { PipelineStore } from "./store";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writePack(manifest: string): string {
  const dir = mkdtempSync(join(tmpdir(), "findings-pack-"));
  dirs.push(dir);
  mkdirSync(join(dir, "roles"));
  writeFileSync(join(dir, "roles", "reviewer.yaml"), "name: reviewer\nwrite: false\nnetwork: read-only\nenvelope: [read, grep, glob, bash]\n");
  writeFileSync(
    join(dir, "roles", "implementer.yaml"),
    "name: implementer\ntier: mechanical\nwrite: true\nnetwork: read-only\nenvelope: all\n",
  );
  writeFileSync(join(dir, "pack.yaml"), manifest);
  return dir;
}

const MANIFEST = (phase: string) => `schema: codeoid/pack@v1
id: fp
name: Findings Pack
version: 0.1.0
roles: [./roles/reviewer.yaml, ./roles/implementer.yaml]
skills:
  - { id: review, kind: prompt, template: "Review it." }
gates:
  - { id: bench_clear, kind: review }
  - { id: tests_pass, kind: command, run: "true" }
phases:
${phase}
`;

const tenant = { accountId: "a", projectId: "p", createdBy: "u" };

function stateFor(pack: ReturnType<typeof loadPack>): PipelineState {
  return {
    id: "run",
    name: "run",
    packId: pack.id,
    phases: pack.pipeline.map((def) => ({ def, state: { status: "running", startedAt: 1, attempts: 0 } })),
    cursor: 0,
    status: "running",
    accountId: "a",
    projectId: "p",
    createdBy: "u",
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("findings: on a pack phase", () => {
  test("compiles with defaults (blocking critical+high, 2 rounds) and accepts the object form with pins", () => {
    const pack = loadPack(
      writePack(
        MANIFEST(`  - { id: review, skill: review, role: reviewer, gate: bench_clear, findings: { fixWith: implementer } }
  - id: adversary
    skill: review
    role: reviewer
    findings:
      fixWith: { role: implementer, model: claude-fable-5 }
      blocking: [critical]
      maxRounds: 3
      gate: tests_pass`),
      ),
    );
    expect(pack.pipeline[0]!.findings).toEqual({
      fixWith: { role: "implementer" },
      blocking: ["critical", "high"],
      maxRounds: 2,
    });
    expect(pack.pipeline[1]!.findings).toEqual({
      fixWith: { role: "implementer", model: "claude-fable-5" },
      blocking: ["critical"],
      maxRounds: 3,
      gate: "tests_pass",
    });
  });

  test("refuses a read-only fix role and an unknown one at load", () => {
    expect(() =>
      loadPack(writePack(MANIFEST("  - { id: review, skill: review, role: reviewer, findings: { fixWith: reviewer } }"))),
    ).toThrow(/fixWith role "reviewer" is read-only/);
    expect(() =>
      loadPack(writePack(MANIFEST("  - { id: review, skill: review, role: reviewer, findings: { fixWith: ghost } }"))),
    ).toThrow(/unknown role "ghost"/);
  });

  test("the `review` gate kind is the loop's verdict: fails while a blocking finding is open, passes when clean or absent", async () => {
    const pack = loadPack(
      writePack(MANIFEST("  - { id: review, skill: review, role: reviewer, gate: bench_clear, findings: { fixWith: implementer } }")),
    );
    const r = createRegistries();
    pack.register(r);
    const gate = r.gates.resolve("fp/bench_clear")!;
    const s = stateFor(pack);
    const phase = s.phases[0]!;
    // No loop state yet (never ran) → pass, the human is the reviewer.
    expect((await gate.evaluate({ pipeline: s, phase: phase.def })).pass).toBe(true);
    // Open blocking finding → fail, with the ledger in the reason.
    phase.findings = newLoopState();
    phase.findings.rounds.push({ findings: [{ id: "F1", severity: "critical", title: "boom" }] });
    const v = await gate.evaluate({ pipeline: s, phase: phase.def });
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("1 blocking finding still open after 0 fix legs");
    expect(v.reason).toContain("| F1 | critical | boom |");
    // Only non-blocking left → pass.
    phase.findings.rounds.push({ findings: [{ id: "F2", severity: "low", title: "nit" }] });
    expect((await gate.evaluate({ pipeline: s, phase: phase.def })).pass).toBe(true);
  });

  test("create validates the fix gate and binds the fix leg's model through the role's tier", () => {
    const pack = loadPack(
      writePack(
        MANIFEST("  - { id: review, skill: review, role: reviewer, findings: { fixWith: implementer, gate: tests_pass } }"),
      ),
    );
    const mgr = new PipelineManager(new PipelineStore(new Database(":memory:")));
    mgr.installPack(pack);
    const warnings: string[] = [];
    const run = mgr.create({
      ...tenant,
      name: "r",
      pack: "fp",
      sessionProvider: "claude",
      modelConfig: { modelTiers: { mechanical: { provider: "claude", model: "claude-fable-5" } }, modelRoles: {} },
      warn: (m) => warnings.push(m),
    });
    const fw = run.phases[0]!.def.findings?.fixWith;
    expect(fw).toEqual({ role: "implementer", resolvedFrom: "config-tier", provider: "claude", model: "claude-fable-5" });
    // The reviewer phase itself has no tier → stays unbound; no warnings.
    expect(run.phases[0]!.def.model).toBeUndefined();
    expect(warnings).toEqual([]);

    // An unknown fix gate is a create-time error, like any other gate.
    const broken = loadPack(
      writePack(MANIFEST("  - { id: review, skill: review, role: reviewer, findings: { fixWith: implementer, gate: nope } }")),
    );
    const mgr2 = new PipelineManager(new PipelineStore(new Database(":memory:")));
    mgr2.installPack(broken);
    expect(() => mgr2.create({ ...tenant, name: "r", pack: "fp" })).toThrow(/unknown findings fix gate "nope"/);
  });

  test("a cross-provider fix binding is skipped with a warning, never persisted", () => {
    const pack = loadPack(
      writePack(MANIFEST("  - { id: review, skill: review, role: reviewer, findings: { fixWith: { role: implementer, provider: codex } } }")),
    );
    const mgr = new PipelineManager(new PipelineStore(new Database(":memory:")));
    mgr.installPack(pack);
    const warnings: string[] = [];
    const run = mgr.create({ ...tenant, name: "r", pack: "fp", sessionProvider: "claude", warn: (m) => warnings.push(m) });
    expect(run.phases[0]!.def.findings?.fixWith).toEqual({ role: "implementer" });
    expect(warnings.join("\n")).toContain('fix leg (role "implementer")');
    expect(warnings.join("\n")).toContain('targets provider "codex"');
  });
});
