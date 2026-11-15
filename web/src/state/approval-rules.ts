/**
 * Saved approval rules — client half (protocol: approval-rules.ts,
 * docs/secrets-and-memory-design.md §4.1). The caller's own rules: listed
 * with settings:read, added and removed with settings:write. Every change
 * refetches the list.
 */

import { createSignal } from "solid-js";

import { getClient, newRequestId, request } from "./connection";
import type { ApprovalRuleEffect, ApprovalRuleInfo, ApprovalRuleScopeKind, ApprovalRulesListResultMsg } from "../protocol/types";

interface RulesState {
  loaded: boolean;
  rules: ApprovalRuleInfo[];
  error: string | null;
}

const EMPTY: RulesState = { loaded: false, rules: [], error: null };
const [state, setState] = createSignal<RulesState>(EMPTY);

export const approvalRulesState = state;

export function _resetApprovalRulesForTest(): void {
  setState(EMPTY);
}

export async function fetchApprovalRules(): Promise<void> {
  try {
    const id = newRequestId();
    const res = await getClient().request<ApprovalRulesListResultMsg>(
      { type: "approval_rules.list", id },
      { waitForResult: (m) => (m.type === "approval_rules.list.result" && m.requestId === id ? m : undefined) },
    );
    setState({ loaded: true, rules: res.rules, error: null });
  } catch (e) {
    setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e) }));
  }
}

/** Save a rule. Throws with the daemon's reason (a rule it can't be, a scope that isn't yours). */
export async function addApprovalRule(r: {
  rule: string;
  effect: ApprovalRuleEffect;
  scope: ApprovalRuleScopeKind;
  workdir?: string;
  workstream?: string;
}): Promise<void> {
  await request({ type: "approval_rules.add", id: newRequestId(), ...r });
  await fetchApprovalRules();
}

export async function removeApprovalRule(ruleId: string): Promise<void> {
  await request({ type: "approval_rules.remove", id: newRequestId(), ruleId });
  await fetchApprovalRules();
}
