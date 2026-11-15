/**
 * Saved approval rules, kept (docs/secrets-and-memory-design.md §4.1): an
 * owner's rules in their tenant, and which of them apply to a session. The
 * store is the record; this caches each owner's active rules until one of
 * theirs changes. Deciding a call with them is Session's (rules.ts).
 */
import { randomUUID } from "node:crypto";
import type { ApprovalRuleInfo, ApprovalRuleScopeKind } from "../../protocol/index.js";
import type { ApprovalRuleRow, Store } from "../store.js";
import { formatRule, type MatchableRule, parseRule, type RuleEffect, type RulePattern } from "./rules.js";

/** Whose rules: a user in a tenant. */
export interface RuleOwner {
  accountId: string;
  projectId: string;
  owner: string;
}

/** The session a call is made in: what picks the rules that apply to it. */
export interface RuleSubject extends RuleOwner {
  sessionId: string;
  workspaceId: string;
  workstreamId?: string;
}

export interface StoredRule extends MatchableRule {
  text: string;
  scopeKey: string;
}

/** How long a session's rule lasts when the config doesn't say (`approvals.sessionGrantHours`). */
export const DEFAULT_SESSION_GRANT_HOURS = 8;

const SCOPE_KINDS: ReadonlySet<string> = new Set(["session", "repository", "workstream", "everywhere"]);

export class ApprovalRuleService {
  readonly #store: Store;
  readonly #now: () => number;
  readonly #sessionGrantHours: () => number;
  readonly #byOwner = new Map<string, Array<{ row: ApprovalRuleRow; rule: StoredRule }>>();

  constructor(store: Store, opts: { now?: () => number; sessionGrantHours?: () => number | undefined } = {}) {
    this.#store = store;
    this.#now = opts.now ?? Date.now;
    this.#sessionGrantHours = () => opts.sessionGrantHours?.() ?? DEFAULT_SESSION_GRANT_HOURS;
  }

  /** The rules that apply to a call in this session: the owner's for it, its repository, its workstream, and everywhere. */
  rulesFor(s: RuleSubject): StoredRule[] {
    return this.#rows(s)
      .filter(({ rule }) => {
        if (rule.scope === "everywhere") return true;
        if (rule.scope === "session") return rule.scopeKey === s.sessionId;
        if (rule.scope === "repository") return rule.scopeKey === s.workspaceId;
        return s.workstreamId !== undefined && rule.scopeKey === s.workstreamId;
      })
      .map(({ rule }) => rule);
  }

  list(o: RuleOwner): ApprovalRuleInfo[] {
    return this.#rows(o).map(({ row }) => infoOf(row));
  }

  /** Save a rule; the one already saved for the same scope, rule and effect is kept (a session's lasts longer). */
  add(o: RuleOwner, r: { pattern: RulePattern; effect: RuleEffect; scope: ApprovalRuleScopeKind; key: string; label: string }): ApprovalRuleInfo {
    const now = this.#now();
    const expiresAt = r.scope === "session" ? now + this.#sessionGrantHours() * 3_600_000 : null;
    const { id } = this.#store.addApprovalRule(
      o,
      { id: randomUUID(), scopeKind: r.scope, scopeKey: r.key, scopeLabel: r.label, rule: formatRule(r.pattern), effect: r.effect, expiresAt },
      now,
    );
    this.#byOwner.delete(ownerKey(o));
    const row = this.#rows(o).find((x) => x.row.id === id)?.row;
    if (!row) throw new Error("the rule wasn't saved");
    return infoOf(row);
  }

  remove(o: RuleOwner, id: string): boolean {
    const removed = this.#store.removeApprovalRule(o, id);
    this.#byOwner.delete(ownerKey(o));
    return removed;
  }

  /** A rule ran a call: recorded, so the settings list says when and how often. */
  noteUse(o: RuleOwner, id: string): void {
    this.#store.noteApprovalRuleUse(id, this.#now());
    const entry = this.#byOwner.get(ownerKey(o))?.find((x) => x.row.id === id);
    if (entry) {
      entry.row.lastUsedAt = this.#now();
      entry.row.useCount += 1;
    }
  }

  /** A destroyed session's own rules end with it. */
  endSession(sessionId: string): void {
    this.#store.removeSessionApprovalRules(sessionId);
    this.#byOwner.clear();
  }

  #rows(o: RuleOwner): Array<{ row: ApprovalRuleRow; rule: StoredRule }> {
    const key = ownerKey(o);
    let rows = this.#byOwner.get(key);
    if (!rows) {
      rows = [];
      for (const row of this.#store.listApprovalRules(o, this.#now())) {
        const parsed = parseRule(row.rule);
        // A rule that can't be one any more (the rules got stricter) is left out, never read loosely.
        if (!parsed.ok || !SCOPE_KINDS.has(row.scopeKind) || (row.effect !== "allow" && row.effect !== "deny")) continue;
        rows.push({
          row,
          rule: { id: row.id, pattern: parsed.pattern, effect: row.effect, scope: row.scopeKind as ApprovalRuleScopeKind, text: row.rule, scopeKey: row.scopeKey },
        });
      }
      this.#byOwner.set(key, rows);
    }
    const now = this.#now();
    return rows.filter(({ row }) => row.expiresAt === null || row.expiresAt > now);
  }
}

function ownerKey(o: RuleOwner): string {
  return `${o.accountId}\u0000${o.projectId}\u0000${o.owner}`;
}

function infoOf(row: ApprovalRuleRow): ApprovalRuleInfo {
  return {
    id: row.id,
    rule: row.rule,
    effect: row.effect as ApprovalRuleInfo["effect"],
    scope: { kind: row.scopeKind as ApprovalRuleScopeKind, key: row.scopeKey, label: row.scopeLabel },
    createdAt: row.createdAt,
    ...(row.expiresAt !== null ? { expiresAt: row.expiresAt } : {}),
    ...(row.lastUsedAt !== null ? { lastUsedAt: row.lastUsedAt } : {}),
    useCount: row.useCount,
  };
}
