/**
 * Inline approval bar — when any tool in the focused session is in the
 * `waiting_confirmation` phase, this surfaces ABOVE the prompt with the
 * tool name + description and approve/deny buttons.
 *
 * Rendering one at a time matches the daemon's serialized approval
 * pipeline; if multiple tools are waiting (rare with stream-input
 * mode), the oldest pending one wins.
 *
 * Two distinct shapes:
 *
 *   - Binary tools (Bash, Edit, ExitPlanMode, …): tool description +
 *     approve/refine/deny buttons. Returns just `approved: boolean`.
 *
 *   - Form tools (AskUserQuestion): full question form rendered inline
 *     with radio buttons for single-select / checkboxes for
 *     multi-select, plus an always-available "Other" free-text option.
 *     Submitting builds an `answers` map keyed by question text and
 *     ships it to the daemon as `updatedInput`. The daemon then
 *     shallow-merges that into the SDK's tool input so Claude actually
 *     sees the user's answers — without it, the SDK's tool returns
 *     `answers: {}` and Claude reports "user answered nothing".
 */

import {
  Component,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";

import { newRequestId, request } from "../../state/connection";
import { epochOf, focusedSessionMessages } from "../../state/messages";
import { focusedSession, focusedSessionId } from "../../state/sessions";
import { findPendingApproval } from "../../lib/approvals";
import type { CollaborationCost, SessionMessage } from "../../protocol/types";
import { formatCollaborationCost } from "../../lib/format";

/** Custom event the prompt listens for so "Refine" can focus + hint. */
function focusPromptWithHint(hint: string): void {
  window.dispatchEvent(
    new CustomEvent("codeoid:focus-prompt-with-hint", { detail: { hint } }),
  );
}

interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

function isAskUserQuestion(name: string): boolean {
  return name === "AskUserQuestion" || name === "ask_user_question";
}

function extractQuestions(input: unknown): AskQuestion[] {
  if (!input || typeof input !== "object") return [];
  const qs = (input as { questions?: unknown }).questions;
  if (!Array.isArray(qs)) return [];
  return qs
    .filter(
      (q): q is AskQuestion =>
        !!q &&
        typeof q === "object" &&
        typeof (q as AskQuestion).question === "string" &&
        Array.isArray((q as AskQuestion).options),
    )
    .map((q) => ({
      question: q.question,
      header: q.header,
      multiSelect: q.multiSelect ?? false,
      options: q.options.filter(
        (o): o is { label: string; description?: string } =>
          !!o && typeof o === "object" && typeof o.label === "string",
      ),
    }));
}

const ApprovalBar: Component = () => {
  // Status-gated, turn-bounded scan — see lib/approvals.ts. Tracking the
  // session status here also means the memo re-fires when a racing
  // status_change lands after the tool delta, so the bar still appears.
  // The per-session epoch is tracked too: tool-state deltas mutate message
  // fields in place (array identity stays stable), so without it a second
  // parallel approval flipping to waiting_confirmation mid-turn — with no
  // accompanying status change — would not recompute the memo.
  const pending = createMemo<SessionMessage | null>(() => {
    epochOf(focusedSessionId());
    return findPendingApproval(focusedSessionMessages(), focusedSession()?.status);
  });

  // Resolve the pending state once and gate every callback on its
  // *captured* approvalId. Without this, a stray click that races a
  // delta promoting the tool to `executing` would read
  // `state().approvalId` AFTER the cast — returning `undefined` —
  // and the resulting `session.approve` would either bounce off
  // stale-cleanup or, before the P0 fix, hijack the wrong approval.
  // Each callback also re-checks the current pending: if the bar is
  // still showing but the state already flipped, we no-op rather
  // than firing a doomed request.
  const snapshot = createMemo(() => {
    const m = pending();
    if (!m || !m.tool) return null;
    const s = m.tool.state;
    if (s.phase !== "waiting_confirmation") return null;
    return {
      // Capture sessionId as part of the snapshot so the click sends
      // approval to the SAME session whose pending we rendered —
      // even if the user switches focus between mouseDown and the
      // settled microtask firing the click. Reading
      // `focusedSessionId()` at click time was the agent's race; we
      // now bind it once at snapshot time alongside `approvalId`.
      sessionId: m.sessionId,
      approvalId: s.approvalId,
      description: s.description,
      input: s.input,
      toolName: m.tool.name,
      collaborationCost: s.collaborationCost,
    };
  });

  // One in-flight approve per bar. `busy` disables every button (and gates
  // the keyboard path) so a double-click can't ship the same approvalId
  // twice; `error` surfaces the daemon's rejection inline. Both reset when
  // the pending approval changes — a new approval must not inherit the
  // previous one's error text or disabled state.
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  createEffect(
    on(
      () => snapshot()?.approvalId,
      () => {
        setBusy(false);
        setError(null);
      },
    ),
  );

  const dispatch = (
    sessionId: string,
    approvalId: string,
    approved: boolean,
    updatedInput?: Record<string, unknown>,
  ): void => {
    if (busy()) return;
    setError(null);
    setBusy(true);
    approve(sessionId, approvalId, approved, updatedInput)
      // Success keeps the bar disabled: it dismisses when the daemon's
      // tool-state delta lands, and re-enabling before that would let a
      // second (now stale) approve fire for the same approvalId.
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      });
  };

  // Alt+Y / Alt+D keyboard shortcuts — advertised in the button tooltips but
  // previously never implemented. Binary approve/deny only (AskUserQuestion
  // needs a real answer), and never while typing in an input/textarea.
  onMount(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!ev.altKey) return;
      const k = ev.key.toLowerCase();
      if (k !== "y" && k !== "d") return;
      const cur = snapshot();
      if (!cur || isAskUserQuestion(cur.toolName)) return;
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      ev.preventDefault();
      dispatch(cur.sessionId, cur.approvalId, k === "y");
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <Show when={snapshot()}>
      {(snap) => {
        const isPlanMode = () =>
          snap().toolName === "ExitPlanMode" || snap().toolName === "exit_plan_mode";
        const isAsk = () => isAskUserQuestion(snap().toolName);
        const safeApprove = (approved: boolean, updatedInput?: Record<string, unknown>) => {
          const cur = snapshot();
          if (!cur || cur.approvalId !== snap().approvalId) return;
          if (cur.sessionId !== snap().sessionId) return;
          dispatch(snap().sessionId, snap().approvalId, approved, updatedInput);
        };
        return (
          <>
            <Show when={error()}>
              <div
                role="alert"
                class="border-t border-danger/40 bg-danger/5 px-4 py-1.5 text-center text-[11px] text-danger"
              >
                {error()}
              </div>
            </Show>
            <Show when={isAsk()} fallback={
              <BinaryBar
                toolName={snap().toolName}
                description={snap().description}
                collaborationCost={snap().collaborationCost}
                isPlanMode={isPlanMode()}
                busy={busy()}
                onApprove={() => safeApprove(true)}
                onRefine={() => {
                  safeApprove(false);
                  focusPromptWithHint(
                    isPlanMode()
                      ? "What should change in the plan?"
                      : "What would you like Claude to do instead?",
                  );
                }}
                onDeny={() => safeApprove(false)}
              />
            }>
              <AskUserQuestionForm
                questions={extractQuestions(snap().input)}
                busy={busy()}
                onSubmit={(answers) => safeApprove(true, { answers })}
                onCancel={() => safeApprove(false)}
              />
            </Show>
          </>
        );
      }}
    </Show>
  );
};

const BinaryBar: Component<{
  toolName: string;
  description: string;
  /** Present only for a send-class fleet dispatch from a collaborative session. */
  collaborationCost?: CollaborationCost;
  isPlanMode: boolean;
  busy: boolean;
  onApprove: () => void;
  onRefine: () => void;
  onDeny: () => void;
}> = (props) => (
  <div class="border-t border-accent/30 bg-accent/5 px-4 py-3">
    <div class="mx-auto flex max-w-3xl items-center gap-2">
      <div class="flex flex-1 flex-col min-w-0">
        <div class="flex items-center gap-2 text-xs text-accent">
          <span class="font-semibold uppercase tracking-wider">
            {props.isPlanMode ? "Plan ready" : "Approval needed"}
          </span>
          <span class="font-mono">{props.toolName}</span>
        </div>
        <div class="mt-1 truncate text-sm text-fg">
          {props.isPlanMode
            ? "Review the plan above. Approve to start coding, refine to give Claude feedback."
            : props.description}
        </div>
        {/* What the goal has already cost, on the button that authorizes more.
            Shared formatter so web, Telegram and the TUI show the owner the
            same number in the same words. */}
        <Show when={props.collaborationCost}>
          {(c) => (
            <div class="mt-1 truncate font-mono text-[11px] text-warn" title="Rolled up across this collaboration's orchestrator and its live role-children">
              ◇ {formatCollaborationCost(c())}
            </div>
          )}
        </Show>
      </div>
      <button
        type="button"
        disabled={props.busy}
        class="rounded bg-success/90 px-3 py-1.5 text-xs font-semibold text-bg transition hover:bg-success disabled:cursor-not-allowed disabled:opacity-50"
        onClick={props.onApprove}
        title="Approve · Alt+Y"
      >
        {props.isPlanMode ? "approve plan" : "approve"}
      </button>
      <button
        type="button"
        disabled={props.busy}
        class="rounded border border-accent/60 bg-bg px-3 py-1.5 text-xs font-semibold text-accent transition hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-50"
        onClick={props.onRefine}
        title="Deny + focus prompt for follow-up feedback"
      >
        refine
      </button>
      <button
        type="button"
        disabled={props.busy}
        class="rounded border border-danger/60 bg-bg px-3 py-1.5 text-xs font-semibold text-danger transition hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50"
        onClick={props.onDeny}
        title="Deny · Alt+D"
      >
        {props.isPlanMode ? "cancel" : "deny"}
      </button>
    </div>
  </div>
);

const AskUserQuestionForm: Component<{
  questions: AskQuestion[];
  busy: boolean;
  onSubmit: (answers: Record<string, string>) => void;
  onCancel: () => void;
}> = (props) => {
  // Per-question state. Single-select: stored as the selected label (or
  // "" if the user hasn't picked yet). Multi-select: comma-joined labels.
  // "Other" answers live in their own per-question text field; if non-empty
  // they replace the radio/checkbox value at submit time.
  const [selections, setSelections] = createSignal<Record<string, string[]>>({});
  const [otherText, setOtherText] = createSignal<Record<string, string>>({});

  // Functional setters everywhere — two rapid clicks across different
  // questions both used to read the same `selections()` snapshot and
  // both wrote back, second overwriting the first's update for the
  // OTHER question. Same pattern PromptBox already adopted; missed
  // here in the original.
  function setSelection(q: string, labels: string[]): void {
    setSelections((prev) => ({ ...prev, [q]: labels }));
  }
  function setOther(q: string, text: string): void {
    setOtherText((prev) => ({ ...prev, [q]: text }));
  }
  function toggleMulti(q: string, label: string): void {
    setSelections((prev) => {
      const cur = prev[q] ?? [];
      const next = cur.includes(label)
        ? cur.filter((l) => l !== label)
        : [...cur, label];
      return { ...prev, [q]: next };
    });
  }
  function setSingle(q: string, label: string): void {
    setSelection(q, [label]);
  }

  const allAnswered = createMemo(() => {
    return props.questions.every((q) => {
      const picks = selections()[q.question] ?? [];
      const other = (otherText()[q.question] ?? "").trim();
      return picks.length > 0 || other.length > 0;
    });
  });

  function handleSubmit(): void {
    const answers: Record<string, string> = {};
    for (const q of props.questions) {
      const other = (otherText()[q.question] ?? "").trim();
      if (other) {
        answers[q.question] = other;
      } else {
        const picks = selections()[q.question] ?? [];
        answers[q.question] = picks.join(", ");
      }
    }
    props.onSubmit(answers);
  }

  return (
    <div class="border-t border-accent/30 bg-accent/5 px-4 py-3">
      <div class="mx-auto flex max-w-3xl flex-col gap-3">
        <div class="flex items-center gap-2 text-xs text-accent">
          <span class="font-semibold uppercase tracking-wider">
            Claude is asking
          </span>
          <span class="font-mono">AskUserQuestion</span>
          <Show when={props.questions.length > 1}>
            <span class="text-fg-muted">· {props.questions.length} questions</span>
          </Show>
        </div>
        <For each={props.questions}>
          {(q) => (
            <fieldset class="rounded border border-border bg-bg/60 p-3">
              <legend class="px-1 text-sm font-medium text-fg">
                <Show when={q.header}>
                  <span class="mr-2 rounded bg-accent/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-accent">
                    {q.header}
                  </span>
                </Show>
                {q.question}
                <Show when={q.multiSelect}>
                  <span class="ml-2 text-[10px] text-fg-faint">(pick one or more)</span>
                </Show>
              </legend>
              <ul class="mt-1 flex flex-col gap-1">
                <For each={q.options}>
                  {(opt) => {
                    const picks = () => selections()[q.question] ?? [];
                    const checked = () => picks().includes(opt.label);
                    return (
                      <li>
                        <label class="flex cursor-pointer items-start gap-2 rounded px-2 py-1 text-sm hover:bg-bg-active/40">
                          <input
                            type={q.multiSelect ? "checkbox" : "radio"}
                            name={`q-${q.question}`}
                            class="mt-1 accent-accent"
                            checked={checked()}
                            onChange={() => {
                              if (q.multiSelect) toggleMulti(q.question, opt.label);
                              else setSingle(q.question, opt.label);
                            }}
                          />
                          <span class="flex flex-1 flex-col">
                            <span class="text-fg">{opt.label}</span>
                            <Show when={opt.description}>
                              <span class="text-[11px] text-fg-muted">
                                {opt.description}
                              </span>
                            </Show>
                          </span>
                        </label>
                      </li>
                    );
                  }}
                </For>
                <li>
                  <label class="flex cursor-text items-start gap-2 rounded px-2 py-1 text-sm">
                    <span class="mt-1 text-fg-muted">Other:</span>
                    <input
                      type="text"
                      class="flex-1 rounded border border-border bg-bg px-2 py-1 text-sm text-fg outline-none focus:border-accent"
                      placeholder="type a custom answer…"
                      value={otherText()[q.question] ?? ""}
                      onInput={(e) => setOther(q.question, e.currentTarget.value)}
                    />
                  </label>
                </li>
              </ul>
            </fieldset>
          )}
        </For>
        <div class="flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={props.busy}
            class="rounded border border-danger/60 bg-bg px-3 py-1.5 text-xs font-semibold text-danger transition hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={props.onCancel}
            title="Cancel — Claude will see this as a denied tool call"
          >
            cancel
          </button>
          <button
            type="button"
            disabled={!allAnswered() || props.busy}
            class="rounded bg-success/90 px-3 py-1.5 text-xs font-semibold text-bg transition hover:bg-success disabled:cursor-not-allowed disabled:opacity-50"
            onClick={handleSubmit}
            title={
              allAnswered()
                ? "Submit answers"
                : "Pick an option (or type into Other) for every question first"
            }
          >
            submit answers
          </button>
        </div>
      </div>
    </div>
  );
};

/** Ship an approval decision and await the daemon's answer — a rejection
 * (stale approvalId, permission) rejects the promise so callers can surface
 * it instead of assuming the fire-and-forget went through. */
export function approve(
  sessionId: string,
  approvalId: string,
  approved: boolean,
  updatedInput?: Record<string, unknown>,
): Promise<unknown> {
  return request({
    type: "session.approve",
    id: newRequestId(),
    sessionId,
    approvalId,
    approved,
    ...(updatedInput ? { updatedInput } : {}),
  });
}

export default ApprovalBar;
