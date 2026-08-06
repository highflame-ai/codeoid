/**
 * Pure `codeoid pack` output formatters — no daemon / WebSocket needed.
 */

import { describe, expect, test } from "bun:test";
import type { PackListResultMsg, PackWire } from "../protocol/types";
import { formatPackList, formatPackShow } from "../terminal/pack-format";

const pack = (over: Partial<PackWire> = {}): PackWire => ({
  id: "aif-sdlc",
  name: "AIF SDLC",
  version: "1.0.0",
  description: "spec → ship",
  dir: "/packs/aif-sdlc",
  trusted: false,
  selected: false,
  registry: "ai-factory",
  phases: [
    { id: "spec", role: "implementer" },
    { id: "review", role: "reviewer", gate: "no_blocking" },
  ],
  roles: ["implementer", "reviewer"],
  gates: [{ id: "no_blocking", kind: "review" }],
  active: true,
  ...over,
});

const result = (over: Partial<PackListResultMsg> = {}): PackListResultMsg => ({
  type: "pipeline.pack.list.result",
  requestId: "r",
  installed: [],
  available: [],
  registries: [],
  ...over,
});

describe("formatPackList", () => {
  test("renders registries, installed, and available (not-installed only)", () => {
    const text = formatPackList(
      result({
        registries: [{ name: "ai-factory", url: "git@x/ai-factory.git", cached: true, packCount: 2 }],
        installed: [pack({ trusted: true, selected: true })],
        available: [
          { id: "aif-sdlc", name: "AIF", version: "1.0.0", registry: "ai-factory", dir: "/d", installed: true },
          { id: "lean", name: "Lean", version: "0.2.0", registry: "ai-factory", dir: "/e", installed: false },
        ],
      }),
    ).join("\n");
    expect(text).toContain("ai-factory");
    expect(text).toContain("cached · 2 packs");
    expect(text).toContain("aif-sdlc");
    expect(text).toContain("selected · trusted · active");
    // Installed pack is filtered out of Available; the uninstalled one shows.
    expect(text).toContain("lean");
    expect(text).toMatch(/lean\s+v0\.2\.0\s+from ai-factory/);
  });

  test("empty states for all three sections", () => {
    const text = formatPackList(result()).join("\n");
    expect(text).toContain("(none — add one: codeoid pack registry add <git-url>)");
    expect(text).toContain("(none)");
    expect(text).toContain("(none new)");
  });

  test("a broken installed pack is flagged ERROR", () => {
    const text = formatPackList(result({ installed: [pack({ error: "bad pack.yaml", active: false })] })).join("\n");
    expect(text).toContain("ERROR");
  });
});

describe("formatPackShow", () => {
  test("installed pack shows phases, gates, roles, trust", () => {
    const text = formatPackShow(result({ installed: [pack({ selected: true })] }), "aif-sdlc")!.join("\n");
    expect(text).toContain("AIF SDLC  v1.0.0  (selected)");
    expect(text).toContain("phases:");
    expect(text).toContain("→ spec [implementer]");
    expect(text).toContain("→ review [reviewer] (gate: no_blocking)");
    expect(text).toContain("gates: no_blocking:review");
    expect(text).toContain("roles: implementer, reviewer");
    expect(text).toContain("trust: untrusted");
  });

  test("broken installed pack shows its error, not phases", () => {
    const text = formatPackShow(result({ installed: [pack({ error: "cannot read pack.yaml" })] }), "aif-sdlc")!.join("\n");
    expect(text).toContain("⚠ cannot read pack.yaml");
    expect(text).not.toContain("phases:");
  });

  test("available (not installed) pack shows an install hint", () => {
    const text = formatPackShow(
      result({ available: [{ id: "lean", name: "Lean", version: "0.2.0", registry: "ai-factory", dir: "/e", installed: false }] }),
      "lean",
    )!.join("\n");
    expect(text).toContain("available in ai-factory, not installed");
    expect(text).toContain("codeoid pack install lean");
  });

  test("returns null for an unknown id", () => {
    expect(formatPackShow(result(), "ghost")).toBeNull();
  });
});

describe("formatPackShow --resolve (docs/role-model-binding.md §4)", () => {
  const resolved = pack({
    resolvedRoles: [
      { name: "adversary", tier: "reasoning-max", provider: "claude", model: "claude-fable-5", resolvedFrom: "config-tier" },
      { name: "scribe", tier: "unmapped", resolvedFrom: "default" },
    ],
    phasePins: [{ phase: "review", provider: "codex", model: "codex-max" }],
  });

  test("renders each role's effective binding and lists phase pins separately", () => {
    const text = formatPackShow(result({ installed: [resolved] }), "aif-sdlc", { resolve: true })!.join("\n");
    expect(text).toContain("effective model bindings");
    expect(text).toMatch(/adversary\s+tier=reasoning-max\s+→ claude:claude-fable-5\s+\(config-tier\)/);
    // Unmapped tier says "provider default" — the gap is visible, not hidden.
    expect(text).toMatch(/scribe\s+tier=unmapped\s+→ provider default\s+\(default\)/);
    expect(text).toContain("phase-level pins");
    expect(text).toContain("review: codex:codex-max");
  });

  test("without --resolve the binding view is absent (unchanged output)", () => {
    const text = formatPackShow(result({ installed: [resolved] }), "aif-sdlc")!.join("\n");
    expect(text).not.toContain("effective model bindings");
    expect(text).not.toContain("phase-level pins");
  });

  test("no pins section when the pack declares none", () => {
    const noPins = pack({ resolvedRoles: [{ name: "implementer", resolvedFrom: "default" }], phasePins: [] });
    const text = formatPackShow(result({ installed: [noPins] }), "aif-sdlc", { resolve: true })!.join("\n");
    expect(text).toContain("effective model bindings");
    expect(text).not.toContain("phase-level pins");
  });
});
