/**
 * Autonomous mode asks before writing outside the session's working
 * directory (outside-writes.ts), on every backend, at codeoid's own gate:
 *
 *   - each backend's write tool, named and shaped as it reaches the gate
 *     (Claude, opencode, Codex, pi, Qwen Code, the Gemini CLI);
 *   - a symlink in the workdir that leads out, a `..` that leads out, a path
 *     that can't be resolved for certain (none given, `/proc/self/cwd/…`),
 *     the temp dir (inside), a read outside (not asked);
 *   - a shell command whose redirect or `rm`/`cp`/`tee`/… target is outside,
 *     and one whose target the parser can't place (today's behaviour);
 *   - the card says why; guarded mode is unchanged; the autonomous budget
 *     isn't spent; an unattended run parks on it, as on a high-risk command;
 *   - opencode end to end over the fake server.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { type CodeoidConfig, getConfigDir } from "../config.js";
import { outsideWriteOf, writeTargets } from "../daemon/outside-writes.js";
import type { ProviderEvent, SessionProvider } from "../daemon/providers/interface.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { OpencodeProvider } from "../daemon/providers/opencode/index.js";
import { buildOpencodeEnv } from "../daemon/providers/opencode/policy.js";
import { OpencodeServer } from "../daemon/providers/opencode/server.js";
import { sedScriptWrites, shellWriteTargets } from "../daemon/risk/effects.js";
import { Session, type SessionCreateOptions } from "../daemon/session.js";
import { loadShellParser } from "../daemon/shell/parse.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import type { AuthContext, SessionMessage, SessionMode } from "../protocol/types.js";

const FIXTURE = join(import.meta.dir, "fixtures", "fake-opencode.ts");
const AUTH: AuthContext = { sub: "u", scopes: [], delegationDepth: 0, accountId: "a", projectId: "p" };
const BASE_CONFIG = {
  workspaceIndex: { enabled: false, episodeThreshold: 5, timeThresholdMs: 60_000, debounceMs: 15_000 },
  compress: { enabled: false, excludeCommands: [], excludePatterns: [], compressPipes: false, minBytes: 1024 },
  labeling: {},
  telemetry: { osc8: "auto" },
  autoRotate: { enabled: false, warnPct: 0.6, rotatePct: 0.8, hardRotatePct: 0.9, minTurnsBeforeRotate: 3, strategy: "task-anchor" },
  session: {},
};

let root: string;
let workdir: string;
/** A directory beside the workdir: outside it, and not the temp dir's (the tests' own root is under /tmp). */
let elsewhere: string;
let store: Store;
let transcriptStore: TranscriptStore;
const sessions: Session[] = [];

beforeAll(async () => {
  await loadShellParser();
});

beforeEach(() => {
  // Outside the temp dir (the repository may be in it), so "outside the workdir" isn't also "inside the temp dir".
  root = realpathSync(mkdtempSync(join(homedir(), ".codeoid-test-outside-writes-")));
  workdir = join(root, "work");
  elsewhere = join(root, "elsewhere");
  mkdirSync(join(workdir, "src"), { recursive: true });
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(workdir, "out-link"));
  store = new Store(join(root, "codeoid.db"));
  transcriptStore = new TranscriptStore(join(root, "transcripts"));
});

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.interrupt(AUTH).catch(() => {});
  try {
    await transcriptStore.flush();
  } catch {}
  try {
    store.close();
  } catch {}
  rmSync(root, { recursive: true, force: true });
});

describe("what each backend's write tool targets", () => {
  test("names the paths a write, edit, notebook edit, patch, file change or move writes; null for anything else", () => {
    expect(writeTargets("Write", { file_path: "/a" })).toEqual(["/a"]);
    expect(writeTargets("Edit", { file_path: "/a", files: ["/a", "/b"] })).toEqual(["/a", "/a", "/b"]);
    expect(writeTargets("NotebookEdit", { notebook_path: "/n.ipynb" })).toEqual(["/n.ipynb"]);
    expect(writeTargets("codex_file_change", { changes: [{ path: "a.txt", kind: "update" }, { path: "b.txt", kind: { type: "update", move_path: "/x/b.txt" } }] })).toEqual(["a.txt", "b.txt", "/x/b.txt"]);
    expect(writeTargets("codex_file_change", {})).toEqual([null]);
    expect(writeTargets("write", { path: "@src/a.ts" })).toEqual(["src/a.ts"]);
    expect(writeTargets("edit", { path: "src/a.ts" })).toEqual(["src/a.ts"]);
    expect(writeTargets("edit", { file_path: "/q/a.ts" })).toEqual(["/q/a.ts"]);
    expect(writeTargets("write_file", { file_path: "/q/a.ts" })).toEqual(["/q/a.ts"]);
    expect(writeTargets("notebook_edit", { notebook_path: "/q/n.ipynb" })).toEqual(["/q/n.ipynb"]);
    // The real Gemini CLI sends no input: a path can't be told.
    expect(writeTargets("acp_edit", {})).toEqual([null]);
    for (const read of ["Read", "Grep", "Glob", "read_file", "WebFetch", "Bash"]) expect(writeTargets(read, { file_path: "/a" })).toBeNull();
  });
});

describe("whether a write leads outside the working directory", () => {
  test("inside: a relative or absolute path in the workdir, a new file under a new dir, the temp dir", () => {
    expect(outsideWriteOf("Write", { file_path: join(workdir, "src", "a.ts") }, workdir)).toBeNull();
    expect(outsideWriteOf("write", { path: "src/new/deeper/a.ts" }, workdir)).toBeNull();
    expect(outsideWriteOf("codex_file_change", { changes: [{ path: "src/a.ts" }] }, workdir)).toBeNull();
    expect(outsideWriteOf("Write", { file_path: join(tmpdir(), "scratch.txt") }, workdir)).toBeNull();
    expect(outsideWriteOf("Write", { file_path: "/tmp/scratch.txt" }, workdir)).toBeNull();
  });

  test("outside: an absolute path elsewhere, a symlink that leads out, a `..` that leads out, a move's destination", () => {
    expect(outsideWriteOf("Write", { file_path: join(elsewhere, "a") }, workdir)).toEqual({ path: join(elsewhere, "a"), resolved: true });
    // Through the workdir's own link: where the write lands.
    expect(outsideWriteOf("Edit", { file_path: join(workdir, "out-link", "a") }, workdir)).toEqual({ path: join(elsewhere, "a"), resolved: true });
    expect(outsideWriteOf("write", { path: "out-link/new/b" }, workdir)).toEqual({ path: join(elsewhere, "new", "b"), resolved: true });
    expect(outsideWriteOf("write_file", { file_path: join(workdir, "src", "..", "..", "elsewhere", "c") }, workdir)).toEqual({ path: join(elsewhere, "c"), resolved: true });
    expect(outsideWriteOf("codex_file_change", { changes: [{ path: "src/a.ts", kind: { type: "update", move_path: join(elsewhere, "a.ts") } }] }, workdir)?.path).toBe(join(elsewhere, "a.ts"));
    // opencode's patch: every file it touches is in `files`.
    expect(outsideWriteOf("Edit", { file_path: join(workdir, "src", "a.ts"), files: [join(workdir, "src", "a.ts"), join(elsewhere, "b.ts")] }, workdir)?.path).toBe(join(elsewhere, "b.ts"));
  });

  test("a path that can't be resolved for certain counts as outside", () => {
    expect(outsideWriteOf("acp_edit", {}, workdir)).toMatchObject({ resolved: false });
    expect(outsideWriteOf("Write", {}, workdir)).toMatchObject({ resolved: false });
    expect(outsideWriteOf("Write", { file_path: "/proc/self/cwd/a" }, workdir)).toEqual({ path: "/proc/self/cwd/a", resolved: false });
    expect(outsideWriteOf("write", { path: "~someone/a" }, workdir)).toEqual({ path: "~someone/a", resolved: false });
  });

  test("a read, search or listing outside isn't a write", () => {
    for (const [tool, input] of [
      ["Read", { file_path: join(elsewhere, "a") }],
      ["Grep", { pattern: "x", path: elsewhere }],
      ["Glob", { pattern: "*", path: elsewhere }],
      ["read_file", { absolute_path: join(elsewhere, "a") }],
    ] as const) {
      expect(outsideWriteOf(tool, input, workdir)).toBeNull();
    }
  });

  test("a shell command: a target the parser names outside is outside; one it can't place asks", () => {
    const bash = (command: string, cwd?: string) => outsideWriteOf("Bash", { command, ...(cwd ? { cwd } : {}) }, workdir);
    expect(bash(`echo hi > ${elsewhere}/x`)?.path).toBe(join(elsewhere, "x"));
    expect(bash("echo hi > out-link/x")?.path).toBe(join(elsewhere, "x"));
    expect(bash("echo hi >> ../elsewhere/log")?.path).toBe(join(elsewhere, "log"));
    expect(bash(`rm -f ${elsewhere}/x`)?.path).toBe(join(elsewhere, "x"));
    expect(bash(`cp src/a ${elsewhere}/`)?.path).toBe(elsewhere);
    expect(bash(`mv ${elsewhere}/a src/a`)?.path).toBe(join(elsewhere, "a"));
    expect(bash(`echo x | tee ${elsewhere}/t`)?.path).toBe(join(elsewhere, "t"));
    expect(bash(`cd ${elsewhere} && touch made`)?.path).toBe(join(elsewhere, "made"));
    expect(bash("touch here", elsewhere)?.path).toBe(join(elsewhere, "here"));
    // Inside, scratch and devices: not outside.
    expect(bash("echo hi > src/x && rm -f src/y")).toBeNull();
    expect(bash("echo hi > /tmp/scratch 2>/dev/null")).toBeNull();
    expect(bash("make 2>&1 >/dev/null")).toBeNull();
    // Reads outside: not writes.
    expect(bash(`cat ${elsewhere}/a > src/copy`)).toBeNull();
    // A word the parser can't know can't be placed: it asks (round 25).
    expect(bash('echo hi > "$OUT"')).toMatchObject({ path: '"$OUT"', resolved: false });
    expect(shellWriteTargets('echo hi > "$OUT"', { workdir })).toEqual([{ path: '"$OUT"', unplaced: '"$OUT" is only known at run time', leaves: true }]);
    // A relative path after a `cd` it can't follow can't be placed: it asks.
    expect(bash("cd $DIR && touch x")).toMatchObject({ path: "x", resolved: false });
  });
});

describe("round 24: a target is judged where the kernel writes it", () => {
  const bash = (command: string) => outsideWriteOf("Bash", { command }, workdir);

  test("a dangling symlink leads to its target, in the workdir and in the temp dir", () => {
    symlinkSync(join(elsewhere, "made-later"), join(workdir, "dangling"));
    expect(outsideWriteOf("Write", { file_path: join(workdir, "dangling") }, workdir)).toEqual({ path: join(elsewhere, "made-later"), resolved: true });
    expect(bash("echo x > dangling")?.path).toBe(join(elsewhere, "made-later"));
    const planted = join(tmpdir(), `ow-dangle-${randomUUID()}`);
    symlinkSync(join(elsewhere, "from-tmp"), planted);
    try {
      expect(outsideWriteOf("Write", { file_path: planted }, workdir)?.path).toBe(join(elsewhere, "from-tmp"));
      expect(bash(`echo x > ${planted}`)?.path).toBe(join(elsewhere, "from-tmp"));
    } finally {
      rmSync(planted, { force: true });
    }
    expect(existsSync(join(elsewhere, "made-later"))).toBe(false);
  });

  test("a link loop can't be resolved: it asks", () => {
    symlinkSync(join(workdir, "loop-b"), join(workdir, "loop-a"));
    symlinkSync(join(workdir, "loop-a"), join(workdir, "loop-b"));
    expect(outsideWriteOf("Write", { file_path: join(workdir, "loop-a") }, workdir)).toEqual({ path: join(workdir, "loop-a"), resolved: false });
  });

  test("an existing file with another hard link can't be placed: it asks", () => {
    writeFileSync(join(elsewhere, "victim"), "orig");
    linkSync(join(elsewhere, "victim"), join(workdir, "hard"));
    expect(outsideWriteOf("Write", { file_path: join(workdir, "hard") }, workdir)).toEqual({ path: join(workdir, "hard"), resolved: false });
    expect(bash("echo x >> hard")).toMatchObject({ resolved: false });
    // A plain file inside is still inside.
    writeFileSync(join(workdir, "plain"), "x");
    expect(outsideWriteOf("Write", { file_path: join(workdir, "plain") }, workdir)).toBeNull();
  });

  test("`ln` writes what it links to: a hard link's source, a symlink's target (from the link's directory)", () => {
    writeFileSync(join(elsewhere, "victim"), "orig");
    expect(bash(`ln ${elsewhere}/victim ./hard`)?.path).toBe(join(elsewhere, "victim"));
    expect(bash(`ln -s ${elsewhere}/missing ./k`)?.path).toBe(join(elsewhere, "missing"));
    expect(bash("ln -sf ../../elsewhere/x src/k")?.path).toBe(join(elsewhere, "x"));
    expect(bash("ln -s -t src ../elsewhere/y")).toBeNull();
    expect(bash("ln -s a.ts src/b.ts")).toBeNull();
    expect(bash("ln -sr src/a.ts src/c.ts")).toBeNull();
  });

  test("a link the line makes, then a write: the write can't be placed", () => {
    expect(bash(`ln -s ${elsewhere} newl && echo x > newl/pwn`)).not.toBeNull();
    expect(bash("ln -s ../../x newl && echo x > newl/pwn")).not.toBeNull();
    // The link's own target looks inside: what's written through it can't be placed, but its text stays inside (round 26: best effort).
    expect(shellWriteTargets("ln -s src newl && echo x > newl/pwn", { workdir })).toContainEqual({ path: join(workdir, "newl", "pwn"), unplaced: "the line makes or moves a link that may lead it elsewhere" });
    expect(bash("ln -s src newl && echo x > newl/pwn")).toBeNull();
    expect(bash("ln -s src newl; ln -s x newl/y")).toBeNull();
    expect(bash("cp -s src/a src/b; echo x > src/c")).toBeNull();
    // One whose text leads outside still asks.
    expect(bash("ln -s src newl && echo x > newl/../../pwn")).toMatchObject({ resolved: false });
  });

  test("`..` after a link in a shell target is the link's parent, not the text's", () => {
    mkdirSync(join(elsewhere, "inner"));
    symlinkSync(join(elsewhere, "inner"), join(workdir, "deep-link"));
    expect(bash("echo x > deep-link/../escaped.txt")?.path).toBe(join(elsewhere, "escaped.txt"));
    expect(bash("rm deep-link/../f")?.path).toBe(join(elsewhere, "f"));
    expect(bash("cd ./deep-link && rm ../victim")?.path).toBe(join(elsewhere, "victim"));
    // A `..` with no link before it stays inside.
    expect(bash("echo x > src/../ok.txt")).toBeNull();
  });

  test("`/proc` and `~name` shell targets ask, as file tools' do", () => {
    expect(bash("echo x > /proc/self/cwd/../pwn")).toEqual({ path: "/proc/self/cwd/../pwn", resolved: false });
    expect(bash("echo x >> ~someone/.bashrc")).toMatchObject({ path: "~someone/.bashrc", resolved: false });
  });

  test("a `cd` that may not move the shell leaves the cwd unknown: a relative target after it asks", () => {
    mkdirSync(join(workdir, "sub", "deeper"), { recursive: true });
    for (const line of [
      "cd nosuchdir/deeper; echo x > ../../b.txt",
      "cd nosuchdir 2>/dev/null || :; touch ../c.txt",
      "true && (cd ./sub/deeper && :) ; touch ../../f.txt",
      "(cd ./sub/deeper); echo x > ../../elsewhere/d.txt",
      "cd ./sub/deeper | true; touch ../../g.txt",
      "cd ./sub/deeper & touch ../../h.txt",
      "false && cd ./sub/deeper; touch ../../i.txt",
      "if true; then cd ./sub/deeper; fi; touch ../../j.txt",
    ]) {
      expect([line, bash(line)?.resolved]).toEqual([line, false]);
    }
    // One that surely moves it is followed.
    expect(bash("cd ./sub/deeper && touch ../x.txt")).toBeNull();
    expect(bash("cd ./sub/deeper; touch ../../../elsewhere/x")?.path).toBe(join(elsewhere, "x"));
  });

  test("pi: every path key is judged", () => {
    expect(outsideWriteOf("edit", { path: "../elsewhere/x", file_path: join(workdir, "a"), edits: [] }, workdir)?.path).toBe(join(elsewhere, "x"));
    expect(outsideWriteOf("write", { path: "a", file_path: join(elsewhere, "x") }, workdir)?.path).toBe(join(elsewhere, "x"));
    expect(outsideWriteOf("write_file", { file_path: join(workdir, "a"), path: join(elsewhere, "x") }, workdir)?.path).toBe(join(elsewhere, "x"));
    expect(outsideWriteOf("NotebookEdit", { notebook_path: join(workdir, "a"), file_path: join(elsewhere, "x") }, workdir)?.path).toBe(join(elsewhere, "x"));
  });

  test("a name starting with `..` is inside", () => {
    expect(outsideWriteOf("Write", { file_path: join(workdir, "..foo") }, workdir)).toBeNull();
    expect(bash("touch ./..foo && echo hi > ..bar")).toBeNull();
  });

  test("the temp dir's exemption doesn't cover codeoid's own entries there", () => {
    expect(outsideWriteOf("Write", { file_path: join(tmpdir(), "codeoid-login-abc", ".claude", ".credentials.json") }, workdir)).toMatchObject({ resolved: true });
    expect(bash(`echo x > ${tmpdir()}/codeoid-pi-bridge-x/codeoid-bridge.js`)).toMatchObject({ resolved: true });
    expect(outsideWriteOf("Write", { file_path: join(tmpdir(), "scratch-codeoid.txt") }, workdir)).toBeNull();
  });

  test("the Gemini CLI: an edit is judged by the locations its request names", () => {
    expect(outsideWriteOf("acp_edit", { locations: [join(workdir, "src", "a.ts")] }, workdir)).toBeNull();
    expect(outsideWriteOf("acp_edit", { locations: [{ path: join(workdir, "src", "a.ts"), line: 3 }] }, workdir)).toBeNull();
    expect(outsideWriteOf("acp_edit", { locations: [join(workdir, "a"), join(elsewhere, "b")] }, workdir)?.path).toBe(join(elsewhere, "b"));
    expect(outsideWriteOf("acp_edit", { title: "Edit", locations: [] }, workdir)).toMatchObject({ resolved: false });
  });
});

describe("round 25: a shell target is placed only when the reader is sure of it", () => {
  const bash = (command: string, shellCwd?: string | null) => outsideWriteOf("Bash", { command }, workdir, shellCwd);
  const asks = (lines: string[], shellCwd?: string | null) => {
    for (const line of lines) expect([line, bash(line, shellCwd) !== null]).toEqual([line, true]);
  };
  const runs = (lines: string[], shellCwd?: string | null) => {
    for (const line of lines) expect([line, bash(line, shellCwd)]).toEqual([line, null]);
  };
  beforeEach(() => {
    mkdirSync(join(workdir, "sub"));
    mkdirSync(join(workdir, "outside"));
    mkdirSync(join(elsewhere, "outside"));
    writeFileSync(join(workdir, "inside.txt"), "i");
    writeFileSync(join(elsewhere, "f"), "f");
    symlinkSync(join(elsewhere, "f"), join(workdir, "sub", "notes"));
  });

  test("a word that expands into what could lead outside — a `..`, an absolute alternative, a variable, a substitution, `~` mid-word — asks", () => {
    asks([
      "touch {..,zz}/escaped",
      `touch {${elsewhere},zz}/escaped`,
      "echo x | tee {..,zz}/escaped",
      "touch s*/../../escaped",
      "sed -i s/a/b/ {..,zz}/victim",
      "chmod 600 {..,zz}/victim",
      "touch ./{x,..}/pwn",
      "touch .[.]/pwn",
      "touch a{-../}b",
      "echo x > /tmp/codeoid-login-*/f",
      "cp inside.txt /tmp/codeoid-*/x",
      "echo x > $F",
      "touch $(cat list)",
      "echo x | tee >(cat)",
      "dd if=inside.txt of=~/x",
    ]);
    expect(bash("touch {..,zz}/escaped")).toEqual({ path: "{..,zz}/escaped", resolved: false, why: "{..,zz}/escaped is a pattern that may expand to other names" });
    // A relative pattern with no `..` isn't judged (round 26: best effort), even one through a link (docs/approvals.md's known limits).
    runs(["mv inside.txt [o]ut-link/b", "echo x > ou?-link/victim"]);
  });

  test("a writing program's options are an allow-list: any other form asks when its words could lead outside", () => {
    asks([
      `cp -at ${elsewhere} inside.txt`,
      `cp -t${elsewhere}x inside.txt`,
      `install -Dt ${elsewhere} inside.txt`,
      `mv --target=${elsewhere} inside.txt`,
      "sed -i'../*' s/a/b/ inside.txt",
      "sed -n 's/a/b/w /etc/out' inside.txt",
      "find -L . -name x -delete",
      `find . -fprint ${elsewhere}/list`,
    ]);
    // Round 26: one whose words all stay relative, with no `..` or expansion, runs.
    runs(["cp -T inside.txt sub", "mv -b -S x inside.txt sub/y", "cp inside.txt -t sub copy", "sed -f script.sed -i inside.txt", "sed -n 's/a/b/w out' inside.txt", "sed '1e true' inside.txt"]);
    // Forms it knows for certain are judged: `-t DIR` attached or bundled, `--target-directory=`.
    expect(bash(`cp -vt ${elsewhere} inside.txt`)?.path).toBe(elsewhere);
    expect(bash(`mv --target-directory=${elsewhere} inside.txt`)?.path).toBe(elsewhere);
    expect(bash(`mv -t${elsewhere} inside.txt`)?.path).toBe(elsewhere);
  });

  test("a `cp` that may copy a link, or an `mv` of anything but a plain file, leaves the line's other targets unplaced: asked when their text could lead outside", () => {
    symlinkSync(elsewhere, join(workdir, "shipped-link"));
    expect(shellWriteTargets("cp -a shipped-link r; echo x >> r/f", { workdir })).toContainEqual({ path: join(workdir, "r", "f"), unplaced: "the line makes or moves a link that may lead it elsewhere" });
    asks(["cp -a shipped-link r; echo x >> r/../../f", "mv shipped-link r; echo x >> $R/f"]);
    // Round 26: best effort, a write through a link the line copies or moves isn't judged (docs/approvals.md's known limits).
    runs(["cp -P sub/notes copied; echo x >> copied", "cp -a shipped-link r; echo x >> r/f", "mv shipped-link r; echo x >> r/f", "mv inside.txt moved.txt; echo x >> moved.txt"]);
  });

  test("a `cd` by a bare name is followed when CDPATH is known unset; a line that sets CDPATH asks", () => {
    symlinkSync(elsewhere, join(workdir, "away"));
    const cdpathUnset = (line: string) => outsideWriteOf("Bash", { command: line }, workdir, undefined, { cdpathUnset: true });
    // Unset: followed, so where it really leads is judged.
    expect(cdpathUnset("cd away && touch planted")).toEqual({ path: join(elsewhere, "planted"), resolved: true });
    expect(cdpathUnset("cd outside && touch planted")).toBeNull();
    // Not known: not followed, but a plain relative target after it doesn't ask.
    runs(["cd outside && touch planted", "pushd sub && touch x", "cd ./outside && touch planted", `cd ${workdir}/sub && touch x`]);
    // The line's own CDPATH may send it anywhere.
    asks(["CDPATH=/; cd outside && touch planted", "export CDPATH=..; cd sub && touch x"]);
    expect(cdpathUnset("CDPATH=/; cd outside && touch planted")).not.toBeNull();
  });

  test("removing or renaming a link judges the link, not what it leads to; writing through it still asks", () => {
    symlinkSync(elsewhere, join(workdir, "lnk"));
    writeFileSync(join(workdir, "hard1"), "h");
    linkSync(join(workdir, "hard1"), join(workdir, "sub", "hard2"));
    runs(["rm lnk", "rm -f sub/notes", "unlink lnk", "mv lnk lnk2", "rm hard1", "rmdir sub/notes"]);
    asks(["rm -r lnk/", "rm -r lnk/.", "echo x > hard1", "echo x >> sub/notes", "mv inside.txt lnk", "rm lnk/f"]);
    expect(bash("rm lnk/../f")?.path).toBe(join(root, "f"));
  });

  test("relative targets are judged from the shell's reported cwd; an unknown one asks; one outside makes them outside", () => {
    expect(bash("echo x >> notes", join(workdir, "sub"))).toEqual({ path: join(elsewhere, "f"), resolved: true });
    expect(bash("echo planted > my-skill/NOTE.md", elsewhere)).toEqual({ path: join(elsewhere, "my-skill", "NOTE.md"), resolved: true });
    expect(bash("echo x > notes.txt", null)).toMatchObject({ path: "notes.txt", resolved: false });
    // An absolute target doesn't depend on it; the input's own cwd key wins over the reported one.
    expect(bash(`echo x > ${workdir}/a.txt`, null)).toBeNull();
    expect(outsideWriteOf("Bash", { command: "touch x", cwd: workdir }, workdir, elsewhere)).toBeNull();
    runs(["touch x"], join(workdir, "sub"));
  });

  test("ordinary writes inside the workdir still run unasked", () => {
    runs([
      "touch inside.txt",
      "echo hi > out.txt",
      'echo hi >> "my file.txt"',
      "mkdir -p build/out",
      "rm -rf build dist",
      "cp inside.txt copy.txt",
      "cp -f inside.txt sub/",
      "mv inside.txt renamed.txt",
      "mv -t sub inside.txt",
      "sed -i 's/a/b/g' inside.txt",
      "sed -i.bak -e 's/a/b/' -e '/^$/d' inside.txt",
      "sed -n '1,20p' inside.txt > head.txt",
      "echo x | tee -a log.txt",
      "chmod +x run.sh",
      "chmod -R 755 sub",
      "truncate -s 0 log.txt",
      "touch /tmp/scratch.txt",
      "git status > status.txt 2>&1",
      "npm test > /dev/null 2>&1",
      "install -m 755 inside.txt bin/tool",
      "ln -s inside.txt alias.txt",
      "find build -name '*.o' -delete",
      "dd if=/dev/zero of=blob.bin bs=1k count=1",
      "rm -f /tmp/x.txt",
    ]);
  });

});

describe("round 26: shell is best-effort guidance — only a target that could plausibly leave asks", () => {
  const bash = (command: string, opts: { cdpathUnset?: boolean } = {}) => outsideWriteOf("Bash", { command }, workdir, undefined, opts);
  beforeEach(() => {
    for (const d of ["src", "sub", "build"]) mkdirSync(join(workdir, d), { recursive: true });
  });

  test("common in-workdir work never asks, whether CDPATH is known unset or not", () => {
    const lines = [
      "cd src && sed -i 's/foo/bar/g' index.ts",
      "cd sub && touch x",
      "mkdir -p a/b && cd a/b && touch x",
      "cp -r src dist",
      "cp -R src dist",
      "cp -a src dist",
      "cp --preserve=mode a b",
      "rm -rf dist/*",
      "rm -f *.log",
      "find src -name '*.ts' -exec sed -i 's/a/b/' {} \\;",
      "find src -name '*.ts' -exec sed -i 's/a$/b/' {} +",
      "cd build && make > log 2>&1",
      "touch {a,b}.txt",
      "echo hi > sub/new && mv sub/new sub/n2",
    ];
    for (const cdpathUnset of [false, true]) for (const line of lines) expect([line, cdpathUnset, bash(line, { cdpathUnset })]).toEqual([line, cdpathUnset, null]);
  });

  test("clear outside writes still ask", () => {
    for (const cdpathUnset of [false, true]) {
      for (const line of ["echo x > /etc/x", "cp a ~/x", "rm ../x", "cd /tmp/../home && touch x", `cd ${elsewhere} && touch x`]) {
        expect([line, bash(line, { cdpathUnset }) !== null]).toEqual([line, true]);
      }
    }
    expect(bash("cp a ~/x")).toEqual({ path: join(homedir(), "x"), resolved: true });
  });

  test("a line that sets HOME moves `~`: a `~` target, and a bare `cd`, ask", () => {
    for (const line of [
      "HOME=/somewhere; echo pwn > ~/f",
      `HOME=${elsewhere} bash -c 'mkdir -p ~/w && echo x > ~/w/hz'`,
      "export HOME=/x; cd; touch f",
      "unset HOME; echo x > ~/f",
      `HOME=${elsewhere}; cd ~/w && touch f`,
    ]) {
      expect([line, bash(line) !== null]).toEqual([line, true]);
    }
    // Without it, `~` is the daemon's home: placed, and judged.
    expect(bash(`echo x > ~/${relative(homedir(), workdir)}/f`)).toBeNull();
    expect(bash(`HOME=/x; echo x > ~/${relative(homedir(), workdir)}/f`)).toMatchObject({ resolved: false, why: "the line sets HOME, which moves ~" });
  });

  test("a word only known at run time, a `cd` to one, `cd -`, input of unknown origin, and a find that follows links or reads its roots from a file ask", () => {
    for (const line of [
      'echo x > "$OUT"',
      "touch `cat list`",
      'cd "$DIR" && touch x',
      "cd - && touch x",
      "popd && touch x",
      "ls | xargs rm",
      "find .. -name '*.o' -exec rm {} \\;",
      "find -L . -name x -delete",
      "find -D tree -L . -name victim -delete",
      "find -files0-from LIST -delete",
      "touch .[.]/pwn",
      "cp -r src ~/dist",
    ]) {
      expect([line, bash(line) !== null]).toEqual([line, true]);
    }
  });
});

describe("round 25: sed scripts", () => {
  test("only a script that surely writes no file and runs no command is read as safe", () => {
    for (const s of ["s/a/b/", "s/a/b/g; s|c|d|2", "1,20p", "/foo/d", "/start/,/end/d", "$d", "y/abc/xyz/", "/x/{p;d}", "1!G;h;$!d", "s/w/e/gI", "a appended text", "#n"]) {
      expect([s, sedScriptWrites(s)]).toEqual([s, null]);
    }
    for (const s of ["w out", "s/a/b/w out", "s/a/b/e", "1e date", "/x/W out", "s/a/b", "v", "/a[/]b/d"]) {
      expect([s, sedScriptWrites(s) === null]).toEqual([s, false]);
    }
  });
});

function makeSession(provider: SessionProvider, mode: SessionMode): { session: Session; cards: SessionMessage[] } {
  const id = randomUUID();
  store.createSession({
    id, name: "ow", workdir, status: "idle", createdBy: AUTH.sub,
    createdAt: new Date().toISOString(), attachedClients: 0, accountId: AUTH.accountId, projectId: AUTH.projectId,
  });
  const opts: SessionCreateOptions = {
    name: "ow", workdir, auth: AUTH, store, transcriptStore, existingId: id, _testProvider: provider,
    initialMode: { mode, ...(mode === "autonomous" ? { maxTurns: 10 } : {}) },
    config: BASE_CONFIG as unknown as CodeoidConfig,
  };
  const session = new Session(opts);
  sessions.push(session);
  const cards: SessionMessage[] = [];
  session.attach({ id: "c", auth: AUTH, send: (m: { type: string; role?: string }) => { if (m.type === "session.message" && m.role === "tool_call") cards.push(structuredClone(m) as SessionMessage); } } as never);
  return { session, cards };
}

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await Bun.sleep(5);
  }
}

type Card = { phase: string; risk?: { level: string; reasons: string[] } };

/** One call of `name`/`input` through a real Session's gate: whether it asked, its card, the budget after. */
async function gateCall(name: string, input: Record<string, unknown>, mode: SessionMode, opts: { unattended?: boolean; shellCwd?: string | null; cdpathUnset?: boolean } = {}) {
  const events: ProviderEvent[] = [
    { type: "tool_start", toolId: "t1", sdkToolUseId: "sdk-t1", name, input, approvalId: "ap-1", ...(opts.shellCwd !== undefined ? { shellCwd: opts.shellCwd } : {}) },
    { type: "turn_done", result: { providerId: "mock", model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: 0, durationMs: 1 } },
  ];
  const provider = new MockSessionProvider("mock", [events]);
  if (opts.cdpathUnset) Object.assign(provider, { shellCdpathUnset: true });
  const { session, cards } = makeSession(provider, mode);
  const release = opts.unattended ? session.beginUnattended() : null;
  void session.send("go", AUTH);
  await until(() => provider.canUseToolResults.length > 0 || session.pendingToolApprovals().length > 0);
  const pending = session.pendingToolApprovals();
  const card = cards[0]?.tool?.state as Card | undefined;
  const status = session.status;
  const budget = session.turnsRemaining;
  if (pending.length > 0) await session.interrupt(AUTH);
  release?.();
  return { asked: pending.length > 0, pending, card, status, budget, behavior: provider.canUseToolResults[0]?.behavior };
}

describe("autonomous mode asks before a write outside the working directory, at the session's gate", () => {
  const outsideCalls = (workdir: string, elsewhere: string): Array<[string, string, Record<string, unknown>]> => [
    ["Claude Write", "Write", { file_path: join(elsewhere, "a.ts"), content: "x" }],
    ["Claude Edit", "Edit", { file_path: join(elsewhere, "a.ts"), old_string: "a", new_string: "b" }],
    ["Claude MultiEdit", "MultiEdit", { file_path: join(elsewhere, "a.ts"), edits: [] }],
    ["Claude NotebookEdit", "NotebookEdit", { notebook_path: join(elsewhere, "n.ipynb"), new_source: "" }],
    ["opencode patch", "Edit", { file_path: join(workdir, "src", "a.ts"), files: [join(workdir, "src", "a.ts"), join(elsewhere, "a.ts")], patch: "…" }],
    ["Codex file change", "codex_file_change", { changes: [{ path: join(elsewhere, "a.ts"), kind: "add", diff: "+x" }] }],
    ["pi write", "write", { path: "../elsewhere/a.ts", content: "x" }],
    ["pi edit", "edit", { path: "out-link/a.ts", edits: [] }],
    ["Qwen Code write_file", "write_file", { file_path: join(elsewhere, "a.ts"), content: "x" }],
    ["Qwen Code edit", "edit", { file_path: join(elsewhere, "a.ts"), old_string: "a", new_string: "b" }],
    ["Qwen Code notebook_edit", "notebook_edit", { notebook_path: join(elsewhere, "n.ipynb") }],
    ["Gemini CLI edit (no path given)", "acp_edit", {}],
    ["a shell redirect", "Bash", { command: `echo hi > ${join(elsewhere, "x")}` }],
    ["pi's shell", "bash", { command: `rm -f ${join(elsewhere, "x")}` }],
  ];

  for (const [label] of outsideCalls("/w", "/e")) {
    test(`${label}: asked, the card says why, the budget isn't spent`, async () => {
      // `workdir` and `elsewhere` are made per test.
      const [, n, i] = outsideCalls(workdir, elsewhere).find(([l]) => l === label)!;
      const r = await gateCall(n, i, "autonomous");
      expect(r.asked).toBe(true);
      expect(r.card?.phase).toBe("waiting_confirmation");
      expect(r.card?.risk?.reasons[0]).toStartWith("writes outside the working directory: ");
      expect(r.pending[0]?.risk?.reasons[0]).toBe(r.card?.risk?.reasons[0]);
      expect(r.budget).toBe(10);
    });
  }

  test("the card names the resolved path: a link's target, not the link", async () => {
    const r = await gateCall("Write", { file_path: join(workdir, "out-link", "a.ts"), content: "x" }, "autonomous");
    expect(r.card?.risk).toEqual({ level: "medium", reasons: [`writes outside the working directory: ${join(elsewhere, "a.ts")}`] });
    const unresolved = await gateCall("acp_edit", {}, "autonomous");
    expect(unresolved.card?.risk?.reasons[0]).toContain("can't be resolved for certain");
  });

  test("inside the workdir or the temp dir, and reads outside, run unasked as before", async () => {
    for (const [name, input] of [
      ["Write", { file_path: join(workdir, "src", "a.ts"), content: "x" }],
      ["write", { path: "src/b.ts", content: "x" }],
      ["Write", { file_path: join(tmpdir(), `ow-scratch-${randomUUID()}.txt`), content: "x" }],
      ["Read", { file_path: join(elsewhere, "a.ts") }],
      ["Grep", { pattern: "x", path: elsewhere }],
      ["Bash", { command: "echo hi > src/x" }],
    ] as Array<[string, Record<string, unknown>]>) {
      const r = await gateCall(name, input, "autonomous");
      expect([name, r.asked, r.behavior]).toEqual([name, false, "allow"]);
      expect(r.card?.risk?.reasons[0] ?? "").not.toContain("outside the working directory");
    }
  });

  test("a shell call is judged from the cwd its backend reports: outside or unknown asks, the card and the pending list agree (round 25)", async () => {
    mkdirSync(join(workdir, "sub"));
    writeFileSync(join(elsewhere, "f"), "f");
    symlinkSync(join(elsewhere, "f"), join(workdir, "sub", "notes"));
    const out = await gateCall("Bash", { command: "echo x >> notes" }, "autonomous", { shellCwd: join(workdir, "sub") });
    expect([out.asked, out.card?.risk?.reasons[0]]).toEqual([true, `writes outside the working directory: ${join(elsewhere, "f")}`]);
    expect(out.pending[0]?.risk?.reasons[0]).toBe(`writes outside the working directory: ${join(elsewhere, "f")}`);
    const skills = await gateCall("Bash", { command: "echo planted > my-skill/NOTE.md" }, "autonomous", { shellCwd: elsewhere });
    expect(skills.asked).toBe(true);
    const unknown = await gateCall("Bash", { command: "echo x > notes.txt" }, "autonomous", { shellCwd: null });
    expect(unknown.asked).toBe(true);
    // In the workdir, or a backend that reports none: as before.
    for (const shellCwd of [workdir, undefined]) {
      const r = await gateCall("Bash", { command: "echo x > notes.txt" }, "autonomous", { shellCwd });
      expect([shellCwd, r.asked, r.behavior]).toEqual([shellCwd, false, "allow"]);
    }
  });

  test("round 26: a backend whose shell has CDPATH unset has a bare `cd` followed", async () => {
    mkdirSync(join(workdir, "sub"));
    symlinkSync(elsewhere, join(workdir, "away"));
    const followed = await gateCall("Bash", { command: "cd away && touch planted" }, "autonomous", { cdpathUnset: true });
    expect(followed.asked).toBe(true);
    expect(followed.card?.risk?.reasons).toContain(`writes outside the working directory: ${join(elsewhere, "planted")}`);
    for (const cdpathUnset of [false, true]) {
      const inside = await gateCall("Bash", { command: "cd sub && touch x" }, "autonomous", { cdpathUnset });
      expect([cdpathUnset, inside.asked, inside.behavior]).toEqual([cdpathUnset, false, "allow"]);
    }
  });

  test("round 26: a Grep's relative path is judged from the cwd the backend reports, at the session's gate", async () => {
    const moved = join(getConfigDir(), "moved-into");
    const r = await gateCall("Grep", { pattern: "apiKey", path: "../config.json" }, "autonomous", { shellCwd: moved });
    expect([r.asked, r.behavior]).toEqual([false, "deny"]);
    const unknown = await gateCall("Grep", { pattern: "apiKey", path: "src" }, "autonomous", { shellCwd: null });
    expect(unknown.asked).toBe(true);
    const plain = await gateCall("Grep", { pattern: "apiKey", path: "src" }, "autonomous");
    expect([plain.asked, plain.behavior]).toEqual([false, "allow"]);
  });

  test("guarded mode is unchanged: a write asks as it always did, with no outside-write reason", async () => {
    const r = await gateCall("Write", { file_path: join(elsewhere, "a.ts"), content: "x" }, "guarded");
    expect(r.asked).toBe(true);
    expect(r.card?.risk).toBeUndefined();
  });

  test("a high-risk command outside keeps its level and its own reason first, the outside write said after", async () => {
    const r = await gateCall("Bash", { command: `rm -rf ${elsewhere}` }, "autonomous");
    expect(r.asked).toBe(true);
    expect(r.card?.risk?.level).toBe("high");
    expect(r.card?.risk?.reasons[0]).not.toContain("outside the working directory");
    expect(r.card?.risk?.reasons.at(-1)).toBe(`writes outside the working directory: ${elsewhere}`);
  });

  test("an unattended run parks on it for the owner, as on a high-risk command", async () => {
    const r = await gateCall("Write", { file_path: join(elsewhere, "a.ts"), content: "x" }, "autonomous", { unattended: true });
    expect(r.asked).toBe(true);
    expect(r.status).toBe("waiting_approval");
    expect(r.budget).toBe(10);
  });
});

describe("opencode's write outside the working directory, end to end", () => {
  let server: OpencodeServer;
  let serverDir: string;
  beforeAll(() => {
    serverDir = mkdtempSync(join(tmpdir(), "codeoid-ow-srv-"));
    server = new OpencodeServer({ command: process.execPath, argsPrefix: [FIXTURE], dbPath: join(serverDir, "opencode.db"), env: () => buildOpencodeEnv(), userConfigDir: null });
  });
  afterAll(async () => {
    await server.stop();
    rmSync(serverDir, { recursive: true, force: true });
  });

  async function opencodeWrite(path: string, mode: SessionMode) {
    const provider = new OpencodeProvider({ sessionId: randomUUID(), initialBackingId: "ow", server, store: { setClaudeCodeSessionId: () => {} } as unknown as Store });
    const { session, cards } = makeSession(provider, mode);
    void session.send(`ask-write:${JSON.stringify({ path, content: "x" })}`, AUTH);
    await until(() => session.pendingToolApprovals().length > 0 || session.canonicalHistory.at(-1)?.role === "assistant");
    const pending = session.pendingToolApprovals();
    const card = cards.find((c) => c.tool?.name === "Write")?.tool?.state as Card | undefined;
    for (const p of pending) session.approve(p.approvalId, false, AUTH);
    await until(() => session.status === "idle" && session.canonicalHistory.at(-1)?.role === "assistant");
    return { asked: pending.length > 0, card, reply: String(session.canonicalHistory.at(-1)?.content ?? "") };
  }

  test("asked in autonomous mode, its card naming where it lands; inside, it runs unasked", async () => {
    const out = await opencodeWrite(join(workdir, "out-link", "a.ts"), "autonomous");
    expect(out.asked).toBe(true);
    expect(out.card?.risk?.reasons[0]).toBe(`writes outside the working directory: ${join(elsewhere, "a.ts")}`);
    expect(out.reply).toContain("not allowed");
    const inside = await opencodeWrite(join(workdir, "src", "a.ts"), "autonomous");
    expect(inside.asked).toBe(false);
    expect(inside.reply).toContain("wrote it");
  }, 30_000);
});
