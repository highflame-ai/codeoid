/**
 * PackService — dynamic pack loading (docs/pack-loading.md). Uses temp dirs +
 * an injected fake git (no network / no real clone) + a fake pack registry sink,
 * so the fetch → discover → install → trust → select → remove lifecycle is
 * exercised end to end without a daemon or a real repo.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelBindingConfig } from "./binding";
import type { Pack } from "./interface";
import { PackService, registryNameFromUrl, type PackServiceConfig } from "./pack-service";

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "packsvc-"));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Write a valid pack directory (pack.yaml + one role + ETHOS). */
function writePack(dir: string, id: string, opts: { withCommandGate?: boolean } = {}): void {
  mkdirSync(join(dir, "roles"), { recursive: true });
  writeFileSync(join(dir, "ETHOS.md"), "Be good.");
  writeFileSync(
    join(dir, "roles", "implementer.yaml"),
    "name: implementer\nwrite: true\nnetwork: read-only\nenvelope: all\n",
  );
  const gate = opts.withCommandGate
    ? 'gates:\n  - { id: tests, kind: command, run: "true", at: exit }\n'
    : "";
  const gateRef = opts.withCommandGate ? " gate: tests" : "";
  writeFileSync(
    join(dir, "pack.yaml"),
    `schema: codeoid/pack@v1
id: ${id}
name: Pack ${id}
version: 1.0.0
description: a test pack
constitution: ./ETHOS.md
roles: [./roles/implementer.yaml]
skills:
  - { id: build, kind: prompt, template: "build it" }
${gate}phases:
  - { id: impl, kind: skill, skill: build, role: implementer${gateRef} }
`,
  );
}

/** A registry cache layout: <root>/.git + <root>/packs/<id>/ + <root>/skills/<s>/ */
function writeRegistry(root: string, packIds: string[], skills: string[] = []): void {
  mkdirSync(join(root, ".git"), { recursive: true });
  for (const id of packIds) writePack(join(root, "packs", id), id);
  for (const s of skills) {
    mkdirSync(join(root, "skills", s), { recursive: true });
    writeFileSync(join(root, "skills", s, "SKILL.md"), `# ${s}`);
  }
}

/** A fake pipeline registry sink capturing installPack/unregister. */
function fakeSink() {
  const packs = new Map<string, Pack>();
  return {
    installPack: (p: Pack) => packs.set(p.id, p),
    registries: {
      packs: {
        unregister: (id: string) => packs.delete(id),
        has: (id: string) => packs.has(id),
      },
    },
    _packs: packs,
  };
}

/** Build a PackService with a captured config + a fake git that "clones" by
 *  copying a prepared fixture registry into the cache. */
function makeService(opts: {
  cacheDir: string;
  skillsDir?: string;
  fixture?: string; // a prepared registry dir the fake `git clone` copies in
  sink?: ReturnType<typeof fakeSink>;
  initial?: Partial<PackServiceConfig>;
  modelConfig?: ModelBindingConfig;
}) {
  const persisted: PackServiceConfig[] = [];
  const gitCalls: string[][] = [];
  const svc = new PackService({
    config: {
      defaultPack: opts.initial?.defaultPack ?? null,
      packs: opts.initial?.packs ?? [],
      registries: opts.initial?.registries ?? [],
    },
    cacheDir: opts.cacheDir,
    skillsDir: opts.skillsDir,
    manager: opts.sink ? () => opts.sink! : undefined,
    modelConfig: opts.modelConfig,
    persist: (s) => persisted.push(structuredClone(s)),
    git: async (args, _cwd) => {
      gitCalls.push(args);
      if (args[0] === "clone" && opts.fixture) {
        const dest = args[args.length - 1]!;
        // Emulate a clone by copying the fixture tree into the target.
        cpDir(opts.fixture, dest);
        return { ok: true, stderr: "" };
      }
      if (args[0] === "pull") return { ok: true, stderr: "" };
      return { ok: false, stderr: `unexpected git ${args.join(" ")}` };
    },
  });
  return { svc, persisted, gitCalls };
}

function cpDir(from: string, to: string): void {
  const { cpSync } = require("node:fs");
  cpSync(from, to, { recursive: true });
}

describe("registryNameFromUrl", () => {
  test("derives a name from ssh + https + trailing forms", () => {
    expect(registryNameFromUrl("git@github.com:highflame-ai/ai-factory.git")).toBe("ai-factory");
    expect(registryNameFromUrl("https://github.com/highflame-ai/ai-factory.git")).toBe("ai-factory");
    expect(registryNameFromUrl("https://github.com/x/my-registry/")).toBe("my-registry");
  });
});

describe("addRegistry + discovery", () => {
  test("clones into the cache, persists, and lists cached packs", async () => {
    const fixture = tmp();
    writeRegistry(fixture, ["aif-sdlc", "other-pack"], ["spec"]);
    const cacheDir = join(tmp(), "cache");
    const { svc, persisted } = makeService({ cacheDir, fixture });

    await svc.addRegistry({ url: "git@github.com:highflame-ai/ai-factory.git" });

    const regs = svc.listRegistries();
    expect(regs).toHaveLength(1);
    expect(regs[0]!.name).toBe("ai-factory");
    expect(regs[0]!.cached).toBe(true);
    expect(regs[0]!.packCount).toBe(2);
    expect(persisted.at(-1)!.registries[0]!.url).toContain("ai-factory");

    const avail = svc.available().sort((a, b) => a.id.localeCompare(b.id));
    expect(avail.map((p) => p.id)).toEqual(["aif-sdlc", "other-pack"]);
    expect(avail[0]!.registry).toBe("ai-factory");
    expect(avail[0]!.installed).toBe(false);
  });

  test("rejects re-adding a name with a different url", async () => {
    const fixture = tmp();
    writeRegistry(fixture, ["p"]);
    const { svc } = makeService({ cacheDir: join(tmp(), "c"), fixture });
    await svc.addRegistry({ url: "https://github.com/a/reg.git" });
    await expect(svc.addRegistry({ url: "https://github.com/b/reg.git" })).rejects.toThrow(/different url/);
  });

  test("re-adding the same registry pulls (not clone) and doesn't duplicate", async () => {
    const fixture = tmp();
    writeRegistry(fixture, ["p"]);
    const cacheDir = join(tmp(), "c");
    const { svc } = makeService({ cacheDir, fixture });
    await svc.addRegistry({ url: "https://github.com/a/reg.git" });
    // Second add with the SAME url: the cache exists, so it pulls (fake git
    // returns ok for pull), and the registry list stays length 1.
    await svc.addRegistry({ url: "https://github.com/a/reg.git" });
    expect(svc.listRegistries()).toHaveLength(1);
  });

  test("refresh pulls a cached registry (and no-ops an uncached one)", async () => {
    const fixture = tmp();
    writeRegistry(fixture, ["p"]);
    const { svc } = makeService({
      cacheDir: join(tmp(), "c"),
      fixture,
      initial: { registries: [{ name: "reg", url: "https://github.com/a/reg.git" }] },
    });
    // Not cached yet → refresh is a no-op (doesn't throw).
    await svc.refresh("reg");
    // After adding (clone), refresh pulls it.
    await svc.addRegistry({ url: "https://github.com/a/reg.git", name: "reg" });
    await svc.refresh("reg");
    await svc.refresh(); // all
  });
});

describe("install / trust / select / remove", () => {
  test("install from a registry: registers into the manager, persists, links skills", async () => {
    const fixture = tmp();
    writeRegistry(fixture, ["aif-sdlc"], ["spec", "review"]);
    const cacheDir = join(tmp(), "cache");
    const skillsDir = join(tmp(), "skills");
    const sink = fakeSink();
    const { svc, persisted } = makeService({ cacheDir, skillsDir, fixture, sink });
    await svc.addRegistry({ url: "https://github.com/highflame-ai/ai-factory.git" });

    const installed = svc.install({ packId: "aif-sdlc", trusted: true });
    const pack = installed.find((p) => p.id === "aif-sdlc")!;
    expect(pack).toBeTruthy();
    expect(pack.trusted).toBe(true);
    expect(pack.active).toBe(true); // registered into the sink
    expect(pack.registry).toBe("ai-factory");
    expect(pack.phases.map((ph) => ph.id)).toEqual(["impl"]);
    expect(pack.roles).toEqual(["implementer"]);
    expect(sink._packs.has("aif-sdlc")).toBe(true);
    // config persisted, and skills linked into the skills dir (trusted pack)
    expect(persisted.at(-1)!.packs).toHaveLength(1);
    expect(existsSync(join(skillsDir, "spec"))).toBe(true);
    expect(existsSync(join(skillsDir, "review"))).toBe(true);
    // available() now marks it installed
    expect(svc.available().find((p) => p.id === "aif-sdlc")!.installed).toBe(true);
  });

  test("install from a local dir (no registry)", () => {
    const dir = join(tmp(), "local-pack");
    writePack(dir, "local");
    const sink = fakeSink();
    const { svc } = makeService({ cacheDir: join(tmp(), "c"), sink });
    const installed = svc.install({ dir });
    expect(installed.find((p) => p.id === "local")!.registry).toBeUndefined();
    expect(sink._packs.has("local")).toBe(true);
  });

  test("clones with `--` before the url (option-injection guard)", async () => {
    const fixture = tmp();
    writeRegistry(fixture, ["p"]);
    const { svc, gitCalls } = makeService({ cacheDir: join(tmp(), "c"), fixture });
    await svc.addRegistry({ url: "https://github.com/a/reg.git", name: "reg" });
    const clone = gitCalls.find((a) => a[0] === "clone")!;
    const sep = clone.indexOf("--");
    expect(sep).toBeGreaterThan(0);
    // url + dir come strictly after the `--` separator.
    expect(clone[sep + 1]).toBe("https://github.com/a/reg.git");
  });

  test("skill-linking does NOT propagate a symlinked skill dir (lstat, not stat)", async () => {
    const fixture = tmp();
    writeRegistry(fixture, ["p"], ["real"]);
    // Add a hostile symlink INSIDE the registry's skills/: skills/evil -> /etc.
    // statSync would resolve it to a dir and link it; lstatSync must skip it.
    symlinkSync("/etc", join(fixture, "skills", "evil"), "dir");
    const skillsDir = join(tmp(), "skills");
    const { svc } = makeService({ cacheDir: join(tmp(), "c"), skillsDir, fixture });
    await svc.addRegistry({ url: "https://github.com/a/reg.git" });
    svc.install({ packId: "p", trusted: true });
    expect(existsSync(join(skillsDir, "real"))).toBe(true); // a real skill dir is linked
    expect(existsSync(join(skillsDir, "evil"))).toBe(false); // the symlink is NOT
  });

  test("an UNTRUSTED pack links no skills (declaring is not executing)", async () => {
    const fixture = tmp();
    writeRegistry(fixture, ["p"], ["spec", "review"]);
    const skillsDir = join(tmp(), "skills");
    const sink = fakeSink();
    const { svc } = makeService({ cacheDir: join(tmp(), "c"), skillsDir, fixture, sink });
    await svc.addRegistry({ url: "https://github.com/a/reg.git" });

    // Default trust is false. The pack still installs and indexes...
    const installed = svc.install({ packId: "p" });
    expect(installed.find((x) => x.id === "p")!.trusted).toBe(false);
    expect(sink._packs.has("p")).toBe(true);
    // ...but its `!`…`` skill frontmatter must not become runnable host shell
    // without an explicit trust opt-in, exactly like its command gates.
    expect(existsSync(join(skillsDir, "spec"))).toBe(false);
    expect(existsSync(join(skillsDir, "review"))).toBe(false);
  });

  test("skill-linking never clobbers an existing skill", async () => {
    const fixture = tmp();
    writeRegistry(fixture, ["p"], ["spec"]);
    const skillsDir = join(tmp(), "skills");
    mkdirSync(join(skillsDir, "spec"), { recursive: true });
    writeFileSync(join(skillsDir, "spec", "SKILL.md"), "PRE-EXISTING");
    const { svc } = makeService({ cacheDir: join(tmp(), "c"), skillsDir, fixture });
    await svc.addRegistry({ url: "https://github.com/a/reg.git" });
    svc.install({ packId: "p", trusted: true });
    // The pre-existing skill dir is untouched (not a symlink to the registry).
    expect(require("node:fs").readFileSync(join(skillsDir, "spec", "SKILL.md"), "utf8")).toBe("PRE-EXISTING");
  });

  test("trust toggle re-registers at the new trust level", async () => {
    const fixture = tmp();
    writeRegistry(fixture, ["p"]);
    const sink = fakeSink();
    const { svc } = makeService({ cacheDir: join(tmp(), "c"), fixture, sink });
    await svc.addRegistry({ url: "https://github.com/a/reg.git" });
    svc.install({ packId: "p", trusted: false });
    const after = svc.trust("p", true);
    expect(after.find((x) => x.id === "p")!.trusted).toBe(true);
  });

  test("trusting an installed-untrusted pack links its skills (no re-install)", async () => {
    const fixture = tmp();
    writeRegistry(fixture, ["p"], ["spec"]);
    const skillsDir = join(tmp(), "skills");
    const { svc } = makeService({ cacheDir: join(tmp(), "c"), skillsDir, fixture });
    await svc.addRegistry({ url: "https://github.com/a/reg.git" });

    svc.install({ packId: "p" }); // untrusted → not linked
    expect(existsSync(join(skillsDir, "spec"))).toBe(false);

    svc.trust("p", true); // trusting it must make the skill runnable
    expect(existsSync(join(skillsDir, "spec"))).toBe(true);
  });

  test("select sets the default pack (and rejects an uninstalled id)", () => {
    const dir = join(tmp(), "p");
    writePack(dir, "sel");
    const { svc, persisted } = makeService({ cacheDir: join(tmp(), "c") });
    svc.install({ dir });
    expect(() => svc.select("nope")).toThrow(/not installed/);
    const after = svc.select("sel");
    expect(after.find((p) => p.id === "sel")!.selected).toBe(true);
    expect(persisted.at(-1)!.defaultPack).toBe("sel");
    expect(svc.selectedPack).toBe("sel");
  });

  test("remove unregisters + drops config + clears selection", () => {
    const dir = join(tmp(), "p");
    writePack(dir, "gone");
    const sink = fakeSink();
    const { svc } = makeService({ cacheDir: join(tmp(), "c"), sink });
    svc.install({ dir });
    svc.select("gone");
    const after = svc.remove("gone");
    expect(after).toHaveLength(0);
    expect(sink._packs.has("gone")).toBe(false);
    expect(svc.selectedPack).toBeNull();
  });

  test("install of an unknown packId throws", () => {
    const { svc } = makeService({ cacheDir: join(tmp(), "c") });
    expect(() => svc.install({ packId: "ghost" })).toThrow(/not found in any registry/);
  });

  test("install with neither packId nor dir throws", () => {
    const { svc } = makeService({ cacheDir: join(tmp(), "c") });
    expect(() => svc.install({})).toThrow(/provide `packId` or `dir`/);
  });

  test("trust of an uninstalled pack throws", () => {
    const { svc } = makeService({ cacheDir: join(tmp(), "c") });
    expect(() => svc.trust("ghost", true)).toThrow(/not installed/);
  });

  test("select(null) clears the default", () => {
    const dir = join(tmp(), "p");
    writePack(dir, "d");
    const { svc } = makeService({ cacheDir: join(tmp(), "c") });
    svc.install({ dir });
    svc.select("d");
    expect(svc.selectedPack).toBe("d");
    svc.select(null);
    expect(svc.selectedPack).toBeNull();
  });
});

describe("resolveActivation (ambient pack activation)", () => {
  test("resolves constitution + role + registry subagents", async () => {
    const fixture = tmp();
    writeRegistry(fixture, ["aif"], ["spec"]);
    // add a subagent file at the registry root's agents/ dir
    mkdirSync(join(fixture, "agents"), { recursive: true });
    writeFileSync(join(fixture, "agents", "rev.md"), "---\nname: rev\ndescription: reviewer bot\n---\nReview well.");
    const { svc } = makeService({ cacheDir: join(tmp(), "c"), fixture });
    await svc.addRegistry({ url: "https://github.com/a/ai-factory.git", name: "ai-factory" });
    svc.install({ packId: "aif" });

    // no role → constitution + subagents, no role
    const a = svc.resolveActivation("aif");
    expect(a.id).toBe("aif");
    expect(a.constitution).toBe("Be good."); // writePack writes ETHOS.md = "Be good."
    expect(a.role).toBeUndefined();
    expect(a.subagents.map((s) => s.name)).toEqual(["rev"]);

    // with a declared role → role resolved (writePack declares "implementer")
    const withRole = svc.resolveActivation("aif", "implementer");
    expect(withRole.roleName).toBe("implementer");
    expect(withRole.role?.write).toBe(true);
  });

  test("throws on an uninstalled pack or an unknown role", async () => {
    const fixture = tmp();
    writeRegistry(fixture, ["aif"]);
    const { svc } = makeService({ cacheDir: join(tmp(), "c"), fixture });
    await svc.addRegistry({ url: "https://github.com/a/reg.git" });
    svc.install({ packId: "aif" });
    expect(() => svc.resolveActivation("ghost")).toThrow(/not installed/);
    expect(() => svc.resolveActivation("aif", "wizard")).toThrow(/no role "wizard"/);
  });

  test("a local-dir install has no registry → no subagents", () => {
    const dir = join(tmp(), "local");
    writePack(dir, "loc");
    const { svc } = makeService({ cacheDir: join(tmp(), "c") });
    svc.install({ dir });
    expect(svc.resolveActivation("loc").subagents).toEqual([]);
  });
});

describe("installed() resilience", () => {
  test("a broken pack dir surfaces as an error entry, not a throw", () => {
    const dir = join(tmp(), "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pack.yaml"), "schema: codeoid/pack@v1\nid: broke\nname: B\nversion: 1.0.0\nphases: []\n");
    // phases: [] violates min(1) → loadPack throws, installed() must not.
    const { svc } = makeService({
      cacheDir: join(tmp(), "c"),
      initial: { packs: [{ dir, trusted: false }] },
    });
    const installed = svc.installed();
    expect(installed).toHaveLength(1);
    expect(installed[0]!.error).toBeTruthy();
    expect(installed[0]!.active).toBe(false);
  });
});

describe("refreshRegistry", () => {
  test("reloads a changed pack.yaml into the live manager without reinstall", async () => {
    const fixture = tmp();
    writeRegistry(fixture, ["ref-pack"]);
    const cacheDir = tmp();
    const base = fakeSink();
    let installCallCount = 0;
    const sink = {
      installPack: (p: Pack) => { installCallCount++; base.installPack(p); },
      registries: base.registries,
      _packs: base._packs,
    } as ReturnType<typeof fakeSink>;

    const { svc } = makeService({ cacheDir, fixture, sink });
    await svc.addRegistry({ url: "https://github.com/x/reg.git", name: "reg" });
    svc.install({ packId: "ref-pack", trusted: true });
    const countAfterInstall = installCallCount;

    // Simulate git pull delivering a second phase to the pack.yaml.
    const packYamlPath = join(cacheDir, "reg", "packs", "ref-pack", "pack.yaml");
    const original = readFileSync(packYamlPath, "utf8");
    writeFileSync(
      packYamlPath,
      original.replace(
        "phases:\n  - { id: impl",
        "phases:\n  - { id: plan, kind: skill, skill: build, role: implementer }\n  - { id: impl",
      ),
    );

    await svc.refreshRegistry("reg");

    expect(installCallCount).toBe(countAfterInstall + 1); // installPack called exactly once on refresh
    const reloaded = sink._packs.get("ref-pack");
    expect(reloaded).toBeTruthy();
    expect(reloaded!.pipeline).toHaveLength(2); // was 1, now 2 after reload
  });

  test("does not link skills for untrusted packs on refresh", async () => {
    const fixture = tmp();
    writeRegistry(fixture, ["untrusted-pack"], ["spec"]);
    const cacheDir = tmp();
    const skillsDir = tmp();
    const sink = fakeSink();
    const { svc } = makeService({ cacheDir, skillsDir, fixture, sink });

    await svc.addRegistry({ url: "https://github.com/x/reg.git", name: "reg" });
    svc.install({ packId: "untrusted-pack", trusted: false });

    await svc.refreshRegistry("reg");

    // No skills should be linked — untrusted packs never get #linkSkills called.
    expect(readdirSync(skillsDir)).toHaveLength(0);
  });
});

describe("installed() — model-binding resolve view (pack show --resolve)", () => {
  /** A pack exercising every pack-side binding source: a mapped tier, an
   *  unmapped tier, and a phase-level pin. */
  function writeBindingPack(dir: string): void {
    mkdirSync(join(dir, "roles"), { recursive: true });
    writeFileSync(
      join(dir, "roles", "adversary.yaml"),
      "name: adversary\ntier: reasoning-max\nwrite: false\nenvelope: [read]\n",
    );
    writeFileSync(
      join(dir, "roles", "scribe.yaml"),
      "name: scribe\ntier: unmapped-tier\nwrite: true\nenvelope: all\n",
    );
    writeFileSync(
      join(dir, "pack.yaml"),
      `schema: codeoid/pack@v1
id: bind-pack
name: Binding
version: 1.0.0
roles: [./roles/adversary.yaml, ./roles/scribe.yaml]
phases:
  - { id: attack, kind: noop, role: adversary }
  - { id: pinned, kind: noop, role: scribe, provider: codex, model: codex-max }
`,
    );
  }

  test("reports each role's effective binding and lists phase pins separately", () => {
    const packDir = join(tmp(), "bind-pack");
    writeBindingPack(packDir);
    const { svc } = makeService({
      cacheDir: join(tmp(), "cache"),
      modelConfig: { modelTiers: { "reasoning-max": { provider: "claude", model: "claude-fable-5" } } },
    });
    svc.install({ dir: packDir });

    const [wire] = svc.installed();
    expect(wire!.resolvedRoles).toEqual([
      { name: "adversary", tier: "reasoning-max", provider: "claude", model: "claude-fable-5", resolvedFrom: "config-tier" },
      // Unmapped tier → provider default; the view says so rather than hiding it.
      { name: "scribe", tier: "unmapped-tier", provider: undefined, model: undefined, resolvedFrom: "default" },
    ]);
    // The phase pin is NOT folded into the per-role view (it would mask what
    // the tier map picks) — it is listed on its own so staleness is visible.
    expect(wire!.phasePins).toEqual([{ phase: "pinned", provider: "codex", model: "codex-max" }]);
  });

  test("modelRoles surgical override shows as config-role in the view", () => {
    const packDir = join(tmp(), "bind-pack");
    writeBindingPack(packDir);
    const { svc } = makeService({
      cacheDir: join(tmp(), "cache"),
      modelConfig: {
        modelTiers: { "reasoning-max": { provider: "claude", model: "claude-fable-5" } },
        modelRoles: { "bind-pack/adversary": { provider: "openai", model: "o9" } },
      },
    });
    svc.install({ dir: packDir });
    const [wire] = svc.installed();
    expect(wire!.resolvedRoles?.[0]).toMatchObject({ name: "adversary", provider: "openai", model: "o9", resolvedFrom: "config-role" });
  });
});
