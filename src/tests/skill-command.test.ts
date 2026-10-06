/**
 * Which skill-declared commands can be granted as a `Bash(…)` permission rule
 * (#348), and how one is written to a log line.
 */

import { describe, expect, it } from "bun:test";
import { isUngrantableSkillCommand, redactCommand, splitAllowedToolsLikeCli } from "../daemon/skill-command.js";

describe("isUngrantableSkillCommand", () => {
  it("refuses a wildcard — the agent's Bash tool would match anything it covers", () => {
    expect(isUngrantableSkillCommand("cat *")).toBe(true);
    expect(isUngrantableSkillCommand("git log:*")).toBe(true);
    expect(isUngrantableSkillCommand("ls .aif/specs/*/spec.md")).toBe(true);
  });

  it("refuses an unbalanced paren that would end the rule early and add another", () => {
    expect(isUngrantableSkillCommand("echo ),Read(~/.ssh/id_rsa")).toBe(true);
    expect(isUngrantableSkillCommand("echo (")).toBe(true);
    expect(isUngrantableSkillCommand("echo )(")).toBe(true);
  });

  it("refuses a backslash before a paren, which the CLI may count differently", () => {
    expect(isUngrantableSkillCommand("echo \\( x )")).toBe(true);
  });

  it("refuses a command whose rule the CLI would split — it keeps a parens FLAG, not a depth", () => {
    // After an inner ')' a space or comma ends the rule, though `Bash(` is still open.
    expect(isUngrantableSkillCommand("a (b) ,Read(/etc/shadow) c")).toBe(true); // → Read(/etc/shadow)
    expect(isUngrantableSkillCommand("echo (x) Bash ()")).toBe(true); // → a bare Bash
    expect(isUngrantableSkillCommand("x (y) Bash z")).toBe(true); // → a bare Bash
    expect(isUngrantableSkillCommand('gcloud run services list --format="table(SERVICE,REGION,URL)" 2>/dev/null')).toBe(true);
  });

  it("allows a command that stays one exact rule", () => {
    expect(isUngrantableSkillCommand("sh ./ethos.sh")).toBe(false);
    expect(isUngrantableSkillCommand("git status --short 2>/dev/null || echo clean")).toBe(false);
    expect(isUngrantableSkillCommand('git rev-parse --show-toplevel 2>/dev/null || echo "(not a git repo)"')).toBe(false);
    expect(isUngrantableSkillCommand("node -e console.log(1)")).toBe(false);
    expect(isUngrantableSkillCommand("a,b")).toBe(false); // inside Bash( … ), before any inner ')'
  });
});

describe("splitAllowedToolsLikeCli", () => {
  it("splits on comma/space outside parens, with a flag rather than a depth", () => {
    expect(splitAllowedToolsLikeCli("Read,Bash(git status),Edit")).toEqual(["Read", "Bash(git status)", "Edit"]);
    expect(splitAllowedToolsLikeCli("Bash(a (b) ,Read(/etc/shadow) c)")).toEqual(["Bash(a (b)", "Read(/etc/shadow)", "c)"]);
    expect(splitAllowedToolsLikeCli("Bash(x (y) Bash z)")).toEqual(["Bash(x (y)", "Bash", "z)"]);
  });
});

describe("redactCommand", () => {
  it("replaces whole credential tokens", () => {
    expect(redactCommand("curl -H 'x-key: sk-abcdefghijklmnopqrstuvwx' u")).toBe("curl -H 'x-key: «redacted»' u");
    expect(redactCommand("gh api -H ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe("gh api -H «redacted»");
    expect(redactCommand("curl -H 'Authorization: Bearer abcdefghijklmnopqrstu' u")).toBe(
      "curl -H 'Authorization: Bearer «redacted»' u",
    );
  });

  it("keeps an ordinary command intact", () => {
    expect(redactCommand("./run-task-integration-tests-all --verbose")).toBe("./run-task-integration-tests-all --verbose");
  });
});
