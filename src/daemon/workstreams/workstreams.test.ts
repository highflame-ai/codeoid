import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkstreamBinding } from "./binding.js";
import { effectiveWorkstreams } from "./effective.js";
import { FolderReader, findGitDirs, parseGitRemotes } from "./folder.js";
import { ancestry, expandHome, matchFolder, normalizeRemote, parseSshAliases, type MatchableWorkstream } from "./match.js";
import { workstreamsSchema } from "./schema.js";
import { WorkstreamService } from "./service.js";

const ws = (id: string, over: Partial<MatchableWorkstream> = {}): MatchableWorkstream => ({
  id,
  abstract: false,
  claim: "suggest",
  paths: [],
  remotes: [],
  ...over,
});

describe("matchFolder", () => {
  test("a path rule matches the folder and everything below it", () => {
    const w = [ws("acme", { paths: ["/home/u/Workspace/acme-*"] })];
    expect(matchFolder(w, { paths: ["/home/u/Workspace/acme-api"] }).best?.workstream).toBe("acme");
    expect(matchFolder(w, { paths: ["/home/u/Workspace/acme-api/src/deep"] }).best?.workstream).toBe("acme");
    expect(matchFolder(w, { paths: ["/home/u/Workspace/other"] }).best).toBeUndefined();
  });

  test("`x/**` also names x itself", () => {
    const w = [ws("s", { paths: ["/w/sentisum/**"] })];
    expect(matchFolder(w, { paths: ["/w/sentisum"] }).best?.workstream).toBe("s");
    expect(matchFolder(w, { paths: ["/w/sentisum/a/b"] }).best?.workstream).toBe("s");
  });

  test("a deeper path match beats a shallower one; any path match beats a remote match", () => {
    const w = [
      ws("broad", { paths: ["/w/**"], remotes: ["github.com/acme/*"] }),
      ws("narrow", { paths: ["/w/acme-api"] }),
      ws("remote", { remotes: ["github.com/acme/api"] }),
    ];
    const r = matchFolder(w, { paths: ["/w/acme-api/src"], origin: "github.com/acme/api" });
    expect(r.best?.workstream).toBe("narrow");
    expect(r.candidates.map((c) => c.workstream)).toEqual(["narrow", "broad", "remote"]);
  });

  test("remote rules: origin keeps the claim, upstream alone only suggests", () => {
    const w = [ws("hf", { claim: "exclusive", remotes: ["github.com/highflame-ai/*"] })];
    const viaOrigin = matchFolder(w, { paths: ["/x"], origin: "github.com/highflame-ai/zeroid" });
    expect(viaOrigin.best).toMatchObject({ workstream: "hf", via: "origin", claim: "exclusive" });
    const viaUpstream = matchFolder(w, { paths: ["/x"], origin: "github.com/saucam/zeroid", upstream: "github.com/highflame-ai/zeroid" });
    expect(viaUpstream.best).toMatchObject({ workstream: "hf", via: "upstream", claim: "suggest" });
  });

  test("two workstreams tied at the top are ambiguous, never a guess", () => {
    // Same literal segments (w) and characters (/w/p vs /w/t): a true tie.
    const w = [ws("a", { paths: ["/w/p*"] }), ws("b", { paths: ["/w/*t"] })];
    const r = matchFolder(w, { paths: ["/w/project"] });
    expect(r.best).toBeUndefined();
    expect(r.ambiguous?.sort()).toEqual(["a", "b"]);
  });

  test("a base workstream never matches", () => {
    expect(matchFolder([ws("base", { abstract: true, paths: ["/w/**"] })], { paths: ["/w/x"] }).best).toBeUndefined();
  });

  test("every spelling counts: a real path matches a rule written through a symlinked parent", () => {
    const w = [ws("acme", { paths: ["/home/u/Workspace/acme-*"] })];
    expect(matchFolder(w, { paths: ["/Workspace/acme-api", "/home/u/Workspace/acme-api"] }).best?.workstream).toBe("acme");
  });

  test("ancestry walks to /", () => {
    expect(ancestry("/a/b/c/")).toEqual(["/a/b/c", "/a/b", "/a", "/"]);
    expect(ancestry("/")).toEqual(["/"]);
  });
});

describe("normalizeRemote", () => {
  test.each([
    ["git@github.com:acme/api.git", "github.com/acme/api"],
    ["https://github.com/acme/api", "github.com/acme/api"],
    ["https://user:tok@GitHub.com/acme/api.git/", "github.com/acme/api"],
    ["ssh://git@github.com:22/acme/api.git", "github.com/acme/api"],
    ["git@gitlab.com:group/sub/proj.git", "gitlab.com/group/sub/proj"],
  ])("%s → %s", (url, want) => {
    expect(normalizeRemote(url)).toBe(want);
  });

  test("an ssh Host alias reads as its HostName", () => {
    const aliases = parseSshAliases("Host github-work\n  HostName github.com\n  User git\nHost *\n  HostName nope\n");
    expect(normalizeRemote("git@github-work:acme/api.git", aliases)).toBe("github.com/acme/api");
    expect(aliases.has("*")).toBe(false);
  });

  test("local paths and nonsense are not remotes", () => {
    expect(normalizeRemote("/srv/git/api.git")).toBeUndefined();
    expect(normalizeRemote("file:///srv/git/api.git")).toBeUndefined();
    expect(normalizeRemote("")).toBeUndefined();
    expect(normalizeRemote("https://github.com/acme/../x")).toBeUndefined();
  });
});

describe("parseGitRemotes", () => {
  test("reads [remote \"…\"] urls only, first url wins", () => {
    const text = [
      "[core]",
      "  url = not-a-remote",
      '[remote "origin"]',
      "  url = git@github.com:acme/api.git  # comment",
      "  url = https://mirror/acme/api",
      '[Remote "upstream"]',
      '  URL = "https://github.com/up/api"',
      '[branch "main"]',
      "  remote = origin",
    ].join("\n");
    const r = parseGitRemotes(text);
    expect(r.get("origin")).toBe("git@github.com:acme/api.git");
    expect(r.get("upstream")).toBe("https://github.com/up/api");
    expect(r.size).toBe(2);
  });
});

describe("expandHome", () => {
  test("only a leading ~ or ~/", () => {
    expect(expandHome("~/x", "/home/u")).toBe("/home/u/x");
    expect(expandHome("~", "/home/u")).toBe("/home/u");
    expect(expandHome("/a/~/b", "/home/u")).toBe("/a/~/b");
  });
});

describe("schema", () => {
  const parse = (v: unknown) => workstreamsSchema.safeParse(v);

  test("defaults: nothing configured, isolation off", () => {
    expect(parse(undefined).data).toEqual({ isolateGlobalServers: false, items: [] });
  });

  test("rejects duplicate ids, unknown or cyclic extends, a bad default, the same rule twice", () => {
    const issues = (v: unknown) => (parse(v).error?.issues ?? []).map((i) => i.message).join("\n");
    expect(issues({ items: [{ id: "a" }, { id: "a" }] })).toMatch(/duplicate workstream id "a"/);
    expect(issues({ items: [{ id: "a", extends: ["nope"] }] })).toMatch(/unknown workstream "nope"/);
    expect(issues({ items: [{ id: "a", extends: ["b"] }, { id: "b", extends: ["a"] }] })).toMatch(/cycle/);
    expect(issues({ default: "x", items: [{ id: "a" }] })).toMatch(/default workstream "x" is not defined/);
    expect(issues({ default: "b", items: [{ id: "b", abstract: true }] })).toMatch(/is a base/);
    expect(issues({ items: [{ id: "a", match: { paths: ["~/w"] } }, { id: "b", match: { paths: ["~/w"] } }] })).toMatch(/is in both "a" and "b"/);
  });

  test("rejects reserved ids, relative path rules and remote rules with a scheme", () => {
    expect(parse({ items: [{ id: "conductor" }] }).success).toBe(false);
    expect(parse({ items: [{ id: "a", match: { paths: ["Workspace/x"] } }] }).success).toBe(false);
    expect(parse({ items: [{ id: "a", match: { paths: ["~/w/../etc"] } }] }).success).toBe(false);
    expect(parse({ items: [{ id: "a", match: { remotes: ["https://github.com/a/*"] } }] }).success).toBe(false);
  });

  test("a base workstream has no match rules", () => {
    expect(parse({ items: [{ id: "b", abstract: true, match: { paths: ["~/w"] } }] }).success).toBe(false);
  });

  test("env values are references, never inline secrets", () => {
    expect(parse({ items: [{ id: "a", env: { GH_TOKEN: "ghp_inline" } }] }).success).toBe(false);
    expect(parse({ items: [{ id: "a", env: { GH_TOKEN: { secret: "gh-a" } } }] }).success).toBe(true);
  });
});

describe("effectiveWorkstreams", () => {
  test("bases merge in order, own entries last, exclude after; match/claim/share never inherited", () => {
    const cfg = workstreamsSchema.parse({
      items: [
        { id: "base", abstract: true, mcpServers: ["web", "notes", "github"], skillDirs: ["~/skills"], accounts: { claude: "max" }, share: "closed", env: { A: { secret: "a" } } },
        {
          id: "d",
          extends: ["base"],
          match: { paths: ["~/d/**"] },
          mcpServers: ["+linear", { server: "github", credential: "gh-d" }],
          exclude: ["notes"],
          accounts: { codex: "work" },
        },
      ],
    });
    const d = effectiveWorkstreams(cfg.items).get("d");
    expect(d?.servers).toEqual([
      { server: "web", from: "base" },
      { server: "linear", from: "d" },
      { server: "github", credential: "gh-d", from: "d" },
    ]);
    expect(d?.skillDirs).toEqual(["~/skills"]);
    expect(d?.accounts).toEqual({ claude: "max", codex: "work" });
    expect(d?.env).toEqual({ A: { secret: "a" } });
    expect(d?.share).toBe("ask");
    expect(d?.match.paths).toEqual(["~/d/**"]);
  });
});

describe("readWorkstreamBinding", () => {
  test("accepts what the daemon writes", () => {
    expect(readWorkstreamBinding({ id: "acme", source: "matched", matchedBy: "~/w/*", revision: "abc" })).toEqual({
      id: "acme",
      source: "matched",
      matchedBy: "~/w/*",
      revision: "abc",
    });
    expect(readWorkstreamBinding({ source: "none", revision: "abc" })).toEqual({ source: "none", revision: "abc" });
  });

  test("drops anything malformed", () => {
    for (const bad of [null, [], "x", { source: "nope", revision: "r" }, { id: "Bad Id", source: "matched", revision: "r" }, { source: "none", id: "a", revision: "r" }, { id: "a", source: "matched" }, { source: "matched", revision: "r" }]) {
      expect(readWorkstreamBinding(bad)).toBeUndefined();
    }
  });
});

// ── Against real folders ────────────────────────────────────────────────────

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-ws-")));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function repo(dir: string, remotes: Record<string, string>): void {
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(
    join(dir, ".git", "config"),
    Object.entries(remotes)
      .map(([n, u]) => `[remote "${n}"]\n\turl = ${u}\n`)
      .join(""),
  );
}

describe("FolderReader", () => {
  test("reads origin and upstream of a repo, from a subfolder, without running git", () => {
    const r = join(tmp, "api");
    repo(r, { origin: "git@github-work:acme/api.git", upstream: "https://github.com/up/api" });
    mkdirSync(join(r, "src"));
    const reader = new FolderReader({ home: tmp, sshConfig: "Host github-work\n  HostName github.com\n" });
    expect(reader.remotes(join(r, "src"))).toEqual({ origin: "github.com/acme/api", upstream: "github.com/up/api" });
  });

  test("follows a linked worktree's .git file to the common dir's config", () => {
    const main = join(tmp, "main");
    repo(main, { origin: "https://github.com/acme/api" });
    const wtGit = join(main, ".git", "worktrees", "wt1");
    mkdirSync(wtGit, { recursive: true });
    writeFileSync(join(wtGit, "commondir"), "../..\n");
    const wt = join(tmp, "api-worktrees", "wt1");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, ".git"), `gitdir: ${wtGit}\n`);
    expect(findGitDirs(wt)?.commonDir).toBe(join(main, ".git"));
    expect(new FolderReader({ home: tmp, sshConfig: "" }).remotes(wt)).toEqual({ origin: "github.com/acme/api" });
  });

  test("a folder outside any repo has no remotes", () => {
    expect(new FolderReader({ home: tmp, sshConfig: "" }).remotes(tmp)).toEqual({});
  });

  test("finds the alias of a folder linked from where a rule points", () => {
    const real = join(tmp, "real", "acme-api");
    mkdirSync(real, { recursive: true });
    mkdirSync(join(tmp, "home", "Workspace"), { recursive: true });
    symlinkSync(real, join(tmp, "home", "Workspace", "acme-api"));
    const reader = new FolderReader({ home: join(tmp, "home"), sshConfig: "" });
    const rule = `${tmp}/home/Workspace/acme-*`;
    expect(reader.spellings(join(real, "src"), [rule])).toContain(`${tmp}/home/Workspace/acme-api/src`);
  });
});

describe("WorkstreamService", () => {
  const service = (items: unknown[], extra: Record<string, unknown> = {}) =>
    new WorkstreamService(workstreamsSchema.parse({ items, ...extra }), new FolderReader({ home: tmp, sshConfig: "" }));

  test("no workstreams configured: no binding at all, as before", () => {
    const s = service([]);
    expect(s.configured).toBe(false);
    expect(s.forCreate(tmp)).toEqual({ ok: true, binding: undefined, warnings: [] });
    expect(s.forResume(undefined, tmp)).toEqual({ binding: undefined, migrated: false });
  });

  test("matched, default and none", () => {
    mkdirSync(join(tmp, "acme"));
    const s = service([{ id: "acme", match: { paths: ["~/acme"] } }, { id: "personal" }], { default: "personal" });
    const matched = s.forCreate(join(tmp, "acme"));
    expect(matched.ok && matched.binding).toMatchObject({ id: "acme", source: "matched", matchedBy: "~/acme" });
    const def = s.forCreate(tmp);
    expect(def.ok && def.binding).toMatchObject({ id: "personal", source: "default" });
    const none = service([{ id: "acme", match: { paths: ["~/acme"] } }]).forCreate(tmp);
    expect(none.ok && none.binding).toMatchObject({ source: "none" });
  });

  test("an explicit choice past an exclusive claim is a conflict; past a suggestion it wins", () => {
    mkdirSync(join(tmp, "client"));
    mkdirSync(join(tmp, "research"));
    const s = service([
      { id: "client", claim: "exclusive", allowOverride: false, match: { paths: ["~/client"] } },
      { id: "research", claim: "suggest", match: { paths: ["~/research"] } },
      { id: "mine" },
    ]);
    const c = s.forCreate(join(tmp, "client"), "mine");
    expect(c.ok).toBe(false);
    if (!c.ok && c.kind === "workstream_conflict") expect(c.resolution.conflict).toEqual({ folder: "client", chosen: "mine", overridable: false });
    const r = s.forCreate(join(tmp, "research"), "mine");
    expect(r.ok && r.binding).toMatchObject({ id: "mine", source: "explicit" });
    expect(s.forCreate(join(tmp, "client"), "client").ok).toBe(true);
  });

  test("an unknown or base workstream is refused", () => {
    const s = service([{ id: "base", abstract: true }]);
    const unknown = s.forCreate(tmp, "nope");
    expect(!unknown.ok && unknown.kind).toBe("workstream_unknown");
    const base = s.forCreate(tmp, "base");
    expect(!base.ok && base.kind === "workstream_unknown" && base.error).toMatch(/base workstream/);
  });

  test("a tie with no choice gets no home and a warning; choosing one settles it", () => {
    mkdirSync(join(tmp, "x"));
    const s = service([
      { id: "a", match: { paths: ["~/*"] } },
      { id: "b", match: { paths: ["~/?"] } },
    ]);
    const tie = s.forCreate(join(tmp, "x"));
    expect(tie.ok && tie.binding).toMatchObject({ source: "none" });
    expect(tie.ok && tie.warnings[0]).toMatch(/both match this folder equally/);
    expect(s.forCreate(join(tmp, "x"), "b").ok).toBe(true);
  });

  test("resume keeps a stored home; a pre-workstreams session is resolved once, failing closed", () => {
    mkdirSync(join(tmp, "acme"));
    const s = service([{ id: "acme", match: { paths: ["~/acme"] } }]);
    const stored = { id: "other", source: "explicit" as const, revision: "old" };
    expect(s.forResume(stored, join(tmp, "acme"))).toEqual({ binding: stored, migrated: false });
    expect(s.forResume(undefined, join(tmp, "acme")).binding).toMatchObject({ id: "acme", source: "migrated" });
    expect(s.forResume(undefined, tmp)).toMatchObject({ binding: { source: "none" }, migrated: true });
    expect(s.forResume(undefined, tmp, "conductor").binding).toMatchObject({ id: "conductor", source: "reserved" });
  });

  test("info: name and color from the live config; a deleted home is orphaned", () => {
    const s = service([{ id: "acme", name: "Acme Corp", color: "orange" }]);
    expect(s.info({ id: "acme", source: "explicit", revision: "r" })).toEqual({ id: "acme", name: "Acme Corp", color: "orange", source: "explicit" });
    expect(s.info({ id: "gone", source: "matched", revision: "r" })).toEqual({ id: "gone", orphaned: true, source: "matched" });
    expect(s.info({ source: "none", revision: "r" })).toEqual({ source: "none" });
  });

  test("the revision changes with the config and only with it", () => {
    const a = service([{ id: "a" }]);
    expect(service([{ id: "a" }]).revision).toBe(a.revision);
    expect(service([{ id: "b" }]).revision).not.toBe(a.revision);
  });

  test("summaries list env names, never values", () => {
    const s = service([{ id: "a", env: { GH_TOKEN: { secret: "gh-a" } } }]);
    expect(s.summaries()[0].env).toEqual(["GH_TOKEN"]);
    expect(JSON.stringify(s.summaries())).not.toContain("gh-a");
  });
});
