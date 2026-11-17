/**
 * Saved approval rules (docs/secrets-and-memory-design.md §4.1): an owner's
 * answer to an approval card, kept for a scope. A rule is one of
 * `Bash(<command>)`, `Bash(<command>:*)`, `mcp__<server>__<tool>` or
 * `WebFetch(domain:<host>)`; it allows or denies; it is its owner's own.
 */

export type ApprovalRuleScopeKind = "session" | "repository" | "workstream" | "everywhere";
export type ApprovalRuleEffect = "allow" | "deny";

/** Where a card's answer can be saved: the session's, or its repository's. */
export type ApprovalSaveScope = "session" | "repository";

export interface ApprovalRuleInfo {
  id: string;
  /** As written: `Bash(npm test:*)`. */
  rule: string;
  effect: ApprovalRuleEffect;
  scope: {
    kind: ApprovalRuleScopeKind;
    /** The session id, the repository's workspace id or the workstream id; '' for everywhere. */
    key: string;
    /** What to call it: the session's name, the repository's folder, the workstream. */
    label: string;
  };
  createdAt: number;
  /** When a session rule ends; absent for the others. */
  expiresAt?: number;
  lastUsedAt?: number;
  useCount: number;
}

/** What a card offers to save: the rules its call would add, and where. */
export interface ApprovalRuleOffer {
  rules: string[];
  scopes: ApprovalSaveScope[];
  /** The repository's folder, for the button's label. */
  repository?: string;
}

/** The caller's own rules. Needs settings:read. Replies `approval_rules.list.result`. */
export interface ApprovalRulesListMsg {
  type: "approval_rules.list";
  id: string;
}

export interface ApprovalRulesListResultMsg {
  type: "approval_rules.list.result";
  requestId: string;
  rules: ApprovalRuleInfo[];
}

/**
 * Save a rule. Needs settings:write and an undelegated token. The scope is
 * named by a session (`session`; `repository`: that session's repository),
 * a folder (`repository`), a workstream (`workstream`), or nothing
 * (`everywhere`). Replies `approval_rules.add.result`.
 */
export interface ApprovalRulesAddMsg {
  type: "approval_rules.add";
  id: string;
  rule: string;
  effect: ApprovalRuleEffect;
  scope: ApprovalRuleScopeKind;
  sessionId?: string;
  workdir?: string;
  workstream?: string;
}

export interface ApprovalRulesAddResultMsg {
  type: "approval_rules.add.result";
  requestId: string;
  rule: ApprovalRuleInfo;
}

/** Remove one of the caller's rules. Needs settings:write. Replies `response.ok`. */
export interface ApprovalRulesRemoveMsg {
  type: "approval_rules.remove";
  id: string;
  ruleId: string;
}
