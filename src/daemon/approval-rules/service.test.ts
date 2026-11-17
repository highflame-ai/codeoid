import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store.js";
import { parseRule, type RulePattern } from "./rules.js";
import { ApprovalRuleService } from "./service.js";

const OWNER = { accountId: "a", projectId: "p", owner: "u" };
const SUBJECT = { ...OWNER, sessionId: "s1", workspaceId: "ws1", workstreamId: "proj" };

let tmp: string;
let store: Store;
let now: number;

function pattern(text: string, effect: "allow" | "deny" = "allow"): RulePattern {
  const p = parseRule(text, effect);
  if (!p.ok) throw new Error(p.error);
  return p.pattern;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-rule-svc-"));
  store = new Store(join(tmp, "codeoid.db"));
  now = 1_000_000;
});
afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("ApprovalRuleService", () => {
  test("a session's rule ends after sessionGrantHours, and saving it again moves its end on", () => {
    const svc = new ApprovalRuleService(store, { now: () => now, sessionGrantHours: () => 2 });
    const first = svc.add(OWNER, { pattern: pattern("Bash(npm test:*)"), effect: "allow", scope: "session", key: "s1", label: "s" });
    expect(first.created).toBe(true);
    expect(first.expiresAt).toBe(now + 2 * 3_600_000);
    now += 3_600_000;
    const again = svc.add(OWNER, { pattern: pattern("Bash(npm test:*)"), effect: "allow", scope: "session", key: "s1", label: "s" });
    expect(again).toMatchObject({ id: first.id, created: false, expiresAt: now + 2 * 3_600_000 });
    now += 2 * 3_600_000 + 1;
    expect(svc.rulesFor(SUBJECT)).toEqual([]);
    expect(svc.list(OWNER)).toEqual([]);
  });

  test("picks the rules for a session by scope, and only its owner's", () => {
    const svc = new ApprovalRuleService(store, { now: () => now });
    const add = (scope: "session" | "repository" | "workstream" | "everywhere", key: string, text: string) =>
      svc.add(OWNER, { pattern: pattern(text), effect: "allow", scope, key, label: key });
    add("session", "s1", "Bash(make test:*)");
    add("session", "s2", "Bash(make lint:*)");
    add("repository", "ws1", "Bash(npm test:*)");
    add("repository", "ws2", "Bash(npm run lint:*)");
    add("workstream", "proj", "Bash(cargo test:*)");
    add("workstream", "other", "Bash(cargo build:*)");
    add("everywhere", "", "Bash(go test:*)");
    svc.add({ ...OWNER, owner: "someone" }, { pattern: pattern("Bash(go vet:*)"), effect: "allow", scope: "everywhere", key: "", label: "" });
    expect(svc.rulesFor(SUBJECT).map((r) => r.text).sort()).toEqual(["Bash(cargo test:*)", "Bash(go test:*)", "Bash(make test:*)", "Bash(npm test:*)"]);
    expect(svc.rulesFor({ ...SUBJECT, workstreamId: undefined }).map((r) => r.text)).not.toContain("Bash(cargo test:*)");
  });

  test("a removed rule and a destroyed session's rules are out of use at once", () => {
    const svc = new ApprovalRuleService(store, { now: () => now });
    const r = svc.add(OWNER, { pattern: pattern("Bash(npm test:*)"), effect: "allow", scope: "everywhere", key: "", label: "" });
    svc.add(OWNER, { pattern: pattern("Bash(make test:*)"), effect: "allow", scope: "session", key: "s1", label: "s" });
    expect(svc.rulesFor(SUBJECT)).toHaveLength(2);
    expect(svc.remove({ ...OWNER, owner: "someone" }, r.id)).toBe(false);
    expect(svc.remove(OWNER, r.id)).toBe(true);
    svc.endSession("s1");
    expect(svc.rulesFor(SUBJECT)).toEqual([]);
  });

  test("an allow rule the rules no longer accept is dropped; a deny rule is kept", () => {
    const svc = new ApprovalRuleService(store, { now: () => now });
    store.addApprovalRule(OWNER, { id: "old-allow", scopeKind: "everywhere", scopeKey: "", scopeLabel: "", rule: "Bash(git:*)", effect: "allow", expiresAt: null }, now);
    store.addApprovalRule(OWNER, { id: "old-deny", scopeKind: "everywhere", scopeKey: "", scopeLabel: "", rule: "Bash(ssh:*)", effect: "deny", expiresAt: null }, now);
    expect(svc.rulesFor(SUBJECT).map((r) => r.id)).toEqual(["old-deny"]);
  });

  test("use is counted on the rule", () => {
    const svc = new ApprovalRuleService(store, { now: () => now });
    const r = svc.add(OWNER, { pattern: pattern("Bash(npm test:*)"), effect: "allow", scope: "everywhere", key: "", label: "" });
    svc.noteUse(OWNER, r.id);
    svc.noteUse(OWNER, r.id);
    expect(svc.list(OWNER)[0]).toMatchObject({ useCount: 2, lastUsedAt: now });
    expect(new ApprovalRuleService(store, { now: () => now }).list(OWNER)[0]).toMatchObject({ useCount: 2 });
  });
});
