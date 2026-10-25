import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProbeGate, detectEcosystem, type ProbeSpec } from "./gate-probes";
import type { GateCtx, PipelineState } from "./interface";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "probe-test-"));
}

/** Minimal GateCtx over a workdir — the only field the probes read. */
function ctx(workdir: string | undefined): GateCtx {
  const pipeline = { workdir } as unknown as PipelineState;
  return { pipeline, phase: { id: "x", kind: "noop" } };
}

async function evalProbe(spec: ProbeSpec, workdir: string | undefined, trusted = false) {
  return buildProbeGate("g", spec, "exit", trusted).evaluate(ctx(workdir));
}

describe("detectEcosystem", () => {
  test("go.mod → go build/test/vet", () => {
    const d = tmp();
    writeFileSync(join(d, "go.mod"), "module x\n");
    const eco = detectEcosystem(d);
    expect(eco.build).toBe("go build ./...");
    expect(eco.test).toBe("go test ./...");
    expect(eco.lint).toContain("go vet");
  });

  test("package.json → package-manager scripts; pnpm-lock selects pnpm", () => {
    const d = tmp();
    writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { build: "x", test: "y" } }));
    writeFileSync(join(d, "pnpm-lock.yaml"), "");
    const eco = detectEcosystem(d);
    expect(eco.build).toBe("pnpm run build");
    expect(eco.test).toBe("pnpm run test");
  });

  test("pyproject.toml → pytest + ruff (no build)", () => {
    const d = tmp();
    writeFileSync(join(d, "pyproject.toml"), "");
    const eco = detectEcosystem(d);
    expect(eco.build).toBeUndefined();
    expect(eco.test).toBe("pytest -q");
    expect(eco.lint).toBe("ruff check .");
  });

  test("Cargo.toml → cargo build/test/clippy", () => {
    const d = tmp();
    writeFileSync(join(d, "Cargo.toml"), "");
    const eco = detectEcosystem(d);
    expect(eco.build).toBe("cargo build");
    expect(eco.test).toBe("cargo test");
  });

  test("unrecognized workspace → empty ecosystem", () => {
    expect(detectEcosystem(tmp())).toEqual({});
  });

  test("package.json only derives commands whose scripts exist (no false lint)", () => {
    const d = tmp();
    writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { build: "x", test: "y" } }));
    const eco = detectEcosystem(d);
    expect(eco.build).toContain("run build");
    expect(eco.test).toContain("run test");
    expect(eco.lint).toBeUndefined(); // no lint script → not derived (would fail the gate falsely)
  });

  test("bun test is derived without a script; other commands are not", () => {
    const d = tmp();
    writeFileSync(join(d, "package.json"), "{}");
    writeFileSync(join(d, "bun.lockb"), "");
    const eco = detectEcosystem(d);
    expect(eco.test).toBe("bun test");
    expect(eco.build).toBeUndefined();
    expect(eco.lint).toBeUndefined();
  });
});

describe("file-exists / glob-nonempty probes (read-only, run untrusted)", () => {
  test("passes when a bare path exists", async () => {
    const d = tmp();
    writeFileSync(join(d, "spec.md"), "# spec");
    const v = await evalProbe({ type: "file-exists", paths: ["spec.md"] }, d);
    expect(v.pass).toBe(true);
  });

  test("passes when a glob matches", async () => {
    const d = tmp();
    writeFileSync(join(d, "spec.md"), "# spec");
    const v = await evalProbe({ type: "file-exists", paths: ["**/*.md"] }, d);
    expect(v.pass).toBe(true);
  });

  test("fails with a reason when nothing matches", async () => {
    const v = await evalProbe({ type: "file-exists", paths: ["specs/**/spec.md"] }, tmp());
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("no file matches");
  });

  test("fails when no paths declared", async () => {
    const v = await evalProbe({ type: "file-exists" }, tmp());
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("no paths");
  });

  test("a `..` escaping path is fail-closed, not a host-filesystem existence oracle", async () => {
    const v = await evalProbe({ type: "file-exists", paths: ["../../../../etc/hosts"] }, tmp());
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("escape");
  });

  test("an escaping glob is fail-closed too", async () => {
    const v = await evalProbe({ type: "glob-nonempty", paths: ["../*"] }, tmp());
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("escape");
  });
});

describe("execution probes (trust-gated)", () => {
  test("fail closed on an untrusted pack — the command never runs", async () => {
    const d = tmp();
    writeFileSync(join(d, "go.mod"), "module x\n");
    const v = await evalProbe({ type: "test" }, d, /* trusted */ false);
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("requires a trusted pack");
  });

  test("fail when the ecosystem defines no such command (trusted but unrecognized)", async () => {
    const v = await evalProbe({ type: "build" }, tmp(), /* trusted */ true);
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("no build command auto-derived");
  });
});

describe("workdir guard", () => {
  test("any probe fails closed with no workdir set on the run", async () => {
    const v = await evalProbe({ type: "file-exists", paths: ["x"] }, undefined);
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("needs a workdir");
  });
});

describe("probe evidence", () => {
  test("a test probe that ran no tests fails as inconclusive, and its check is recorded", async () => {
    const d = tmp();
    writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: "echo 'Ran 0 tests across 0 files.'" } }));
    const seen: string[] = [];
    const c: GateCtx = {
      ...ctx(d),
      runCheck: async (spec, cwd) => {
        seen.push(`${spec.id}@${cwd}:${spec.expectTests}`);
        const { ephemeralCheck } = await import("../evidence/service");
        const run = await ephemeralCheck(spec, cwd);
        return { ...run, record: { ...run.outcome, id: "ev_1" } as never };
      },
    };
    const v = await buildProbeGate("g", { type: "test" }, "exit", true).evaluate(c);
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("inconclusive");
    expect(v.evidenceIds).toEqual(["ev_1"]);
    expect(seen).toEqual([`x:g:test@${d}:true`]);
  });
});

