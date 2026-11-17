/**
 * Settings → Approvals (docs/secrets-and-memory-design.md §4.1): the rules
 * your answers to approval cards saved, and ones added here, for a session,
 * a repository, a workstream or everywhere. Each says where it applies, when
 * it last ran a call, and how often; removing one takes it out of use at once.
 */

import { type Component, For, Show, createSignal, onMount } from "solid-js";

import type { ApprovalRuleEffect, ApprovalRuleInfo, ApprovalRuleScopeKind } from "../protocol/types";
import { addApprovalRule, approvalRulesState, fetchApprovalRules, removeApprovalRule } from "../state/approval-rules";

const label = "text-[11px] font-medium uppercase tracking-wider text-fg-faint";
const input =
  "w-full rounded border border-border bg-bg px-3 py-1.5 font-mono text-sm text-fg focus:border-accent focus:outline-none";
const button =
  "rounded border border-border bg-bg px-2.5 py-1 text-[12px] text-fg-muted transition hover:border-accent/40 hover:text-fg disabled:opacity-50";

const SCOPE_WORDS: Record<ApprovalRuleScopeKind, string> = {
  session: "this session",
  repository: "repository",
  workstream: "workstream",
  everywhere: "everywhere",
};

function when(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function scopeText(r: ApprovalRuleInfo): string {
  if (r.scope.kind === "everywhere") return "everywhere";
  if (r.scope.kind === "session") return `session ${r.scope.label}`;
  return `${SCOPE_WORDS[r.scope.kind]} ${r.scope.label}`;
}

export const ApprovalRulesPanel: Component = () => {
  onMount(() => void fetchApprovalRules());
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [adding, setAdding] = createSignal(false);
  const run = async (fn: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="space-y-4">
      <div>
        <h3 class="text-[15px] font-semibold text-fg">Approvals</h3>
        <p class="mt-1 text-[12px] text-fg-muted">
          In guarded mode a call matching an allow rule runs without asking; a deny rule refuses it in every mode. A command
          rated high or not understood, or one naming a credential file, still asks whatever rules you have.
        </p>
      </div>
      <Show when={error() ?? approvalRulesState().error}>
        <div class="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">
          {error() ?? approvalRulesState().error}
        </div>
      </Show>
      <div class="divide-y divide-border rounded border border-border">
        <Show when={approvalRulesState().loaded && approvalRulesState().rules.length === 0}>
          <div class="px-3 py-3 text-[12px] text-fg-muted">
            No rules yet. Approve a card with “allow for this session” or “allow in this repository”, or add one here.
          </div>
        </Show>
        <For each={approvalRulesState().rules}>
          {(r) => (
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2" data-testid={`approval-rule-${r.id}`}>
              <span class={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${r.effect === "deny" ? "border-danger/50 text-danger" : "border-success/50 text-success"}`}>
                {r.effect}
              </span>
              <span class="min-w-0 font-mono [overflow-wrap:anywhere] text-[13px] text-fg">{r.rule}</span>
              <span class="min-w-0 text-[11px] [overflow-wrap:anywhere] text-fg-muted">{scopeText(r)}</span>
              <span class="text-[11px] text-fg-faint">
                {r.useCount > 0 ? `used ${r.useCount}×, last ${when(r.lastUsedAt ?? r.createdAt)}` : "not used yet"}
                <Show when={r.expiresAt}>{(t) => <> · ends {when(t())}</>}</Show>
              </span>
              <span class="ml-auto">
                <button type="button" class={button} disabled={busy()} onClick={() => void run(() => removeApprovalRule(r.id))}>
                  Remove
                </button>
              </span>
            </div>
          )}
        </For>
      </div>
      <Show
        when={adding()}
        fallback={
          <button type="button" class={button} onClick={() => setAdding(true)}>
            Add rule
          </button>
        }
      >
        <AddRule busy={busy()} onDone={() => setAdding(false)} run={run} />
      </Show>
    </div>
  );
};

const AddRule: Component<{ busy: boolean; onDone: () => void; run: (fn: () => Promise<void>) => Promise<boolean> }> = (props) => {
  const [rule, setRule] = createSignal("");
  const [effect, setEffect] = createSignal<ApprovalRuleEffect>("allow");
  const [scope, setScope] = createSignal<Exclude<ApprovalRuleScopeKind, "session">>("repository");
  const [where, setWhere] = createSignal("");
  const save = () =>
    void props
      .run(() =>
        addApprovalRule({
          rule: rule().trim(),
          effect: effect(),
          scope: scope(),
          ...(scope() === "repository" ? { workdir: where().trim() } : {}),
          ...(scope() === "workstream" ? { workstream: where().trim() } : {}),
        }),
      )
      .then((ok) => ok && props.onDone());
  return (
    <div class="space-y-2 rounded border border-border p-3" data-testid="approval-rule-add">
      <label class="block space-y-1">
        <span class={label}>Rule</span>
        <input class={input} placeholder="Bash(npm test:*) · mcp__linear__list_issues · WebFetch(domain:docs.rs)" value={rule()} onInput={(e) => setRule(e.currentTarget.value)} />
      </label>
      <div class="flex flex-wrap gap-2">
        <label class="space-y-1">
          <span class={label}>Effect</span>
          <select class={input} value={effect()} onChange={(e) => setEffect(e.currentTarget.value as ApprovalRuleEffect)}>
            <option value="allow">allow</option>
            <option value="deny">deny</option>
          </select>
        </label>
        <label class="space-y-1">
          <span class={label}>Where</span>
          <select class={input} value={scope()} onChange={(e) => setScope(e.currentTarget.value as "repository" | "workstream" | "everywhere")}>
            <option value="repository">a repository</option>
            <option value="workstream">a workstream</option>
            <option value="everywhere">everywhere</option>
          </select>
        </label>
        <Show when={scope() !== "everywhere"}>
          <label class="min-w-[12rem] flex-1 space-y-1">
            <span class={label}>{scope() === "repository" ? "Folder" : "Workstream"}</span>
            <input class={input} placeholder={scope() === "repository" ? "/home/me/src/app" : "acme"} value={where()} onInput={(e) => setWhere(e.currentTarget.value)} />
          </label>
        </Show>
      </div>
      <div class="flex gap-2">
        <button type="button" class={`${button} border-accent/50 text-accent`} disabled={props.busy || rule().trim() === ""} onClick={save}>
          Save rule
        </button>
        <button type="button" class={button} onClick={props.onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
};
