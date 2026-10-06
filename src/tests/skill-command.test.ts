/**
 * Which skill-declared commands can be granted as a `Bash(…)` permission rule
 * (#348), and how one is written to a log line.
 */

import { describe, expect, it } from "bun:test";
import { isUngrantableSkillCommand, redactCommand } from "../daemon/skill-command.js";

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

  it("allows balanced parens and commas inside them — real pack skills", () => {
    expect(isUngrantableSkillCommand('gcloud run services list --format="table(SERVICE,REGION,URL)"')).toBe(false);
    expect(isUngrantableSkillCommand('git rev-parse --show-toplevel 2>/dev/null || echo "(not a git repo)"')).toBe(false);
    expect(isUngrantableSkillCommand("sh ./ethos.sh")).toBe(false);
    expect(isUngrantableSkillCommand("a,b")).toBe(false);
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
