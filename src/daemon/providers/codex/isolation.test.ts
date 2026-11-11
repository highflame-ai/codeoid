import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexIsolationError, codexIsolationArgs, codexMountedNames } from "./isolation.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-codex-iso-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("codex under workstream isolation", () => {
  test("every server its user and project configs declare, but codeoid's, is off — with a placeholder of its kind; apps off", () => {
    const home = join(tmp, "codex");
    mkdirSync(home);
    writeFileSync(join(home, "config.toml"), '[mcp_servers.leaky]\nurl = "https://leaky.example/mcp?token=x"\n\n[profiles.work.mcp_servers.prof]\ncommand = "p"\n\n[mcp_servers.codeoid_memory]\nurl = "x"\n');
    const work = join(tmp, "repo", "sub");
    mkdirSync(join(tmp, "repo", ".codex"), { recursive: true });
    mkdirSync(work, { recursive: true });
    writeFileSync(join(tmp, "repo", ".codex", "config.toml"), '[mcp_servers.proj]\ncommand = "proj-mcp"\n');
    const args = codexIsolationArgs(home, work, new Set(["codeoid_memory"]));
    expect(args).toEqual([
      "-c", 'mcp_servers.leaky.url="http://127.0.0.1:9/codeoid-disabled"', "-c", "mcp_servers.leaky.enabled=false",
      "-c", 'mcp_servers.prof.command="codeoid-disabled"', "-c", "mcp_servers.prof.enabled=false",
      "-c", 'mcp_servers.proj.command="codeoid-disabled"', "-c", "mcp_servers.proj.enabled=false",
      "-c", "features.apps=false",
    ]);
    // The real URL (with its token) never reaches argv.
    expect(args.join(" ")).not.toContain("leaky.example");
  });

  test("no config at all: apps off, nothing else", () => {
    expect(codexIsolationArgs(join(tmp, "none"), tmp, new Set())).toEqual(["-c", "features.apps=false"]);
  });

  test("fails closed: a name it can't write as a key, invalid TOML, or one server declared as both kinds", () => {
    const home = join(tmp, "codex");
    mkdirSync(home);
    writeFileSync(join(home, "config.toml"), '[mcp_servers."has space"]\ncommand = "x"\n');
    expect(() => codexIsolationArgs(home, tmp, new Set())).toThrow(CodexIsolationError);
    writeFileSync(join(home, "config.toml"), "[mcp_servers.x\n");
    expect(() => codexIsolationArgs(home, tmp, new Set())).toThrow(/isn't valid TOML/);
    writeFileSync(join(home, "config.toml"), '[mcp_servers.x]\nurl = "u"\n');
    mkdirSync(join(tmp, ".codex"));
    writeFileSync(join(tmp, ".codex", "config.toml"), '[mcp_servers.x]\ncommand = "c"\n');
    expect(() => codexIsolationArgs(home, tmp, new Set())).toThrow(/both as a URL and as a command/);
  });

  test("codexMountedNames reads the names codeoid's own -c arguments add", () => {
    expect([...codexMountedNames(["-c", 'mcp_servers.codeoid_memory.url="u"', "-c", "mcp_servers.gh.bearer_token_env_var=\"T\"", "-c", "other=1"])].sort()).toEqual(["codeoid_memory", "gh"]);
  });
});
