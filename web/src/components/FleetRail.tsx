/**
 * The conductor's fleet rail — the state-grouped board, docked beside its chat.
 *
 * conductor-frontends-design §4 makes this the primary fleet view: the
 * operator's job is triage, and lanes answer "who needs me / what is running /
 * what is ready to read" faster than a graph. All the classification lives in
 * `lib/fleet-lanes.ts`; this file is the renderer.
 *
 * §3.B is the other rule shaping it: every node is a REAL session, so clicking
 * one focuses that session's ordinary cockpit. "Take over" is not a feature
 * here — it is the existing attach flow, reached from a fleet node.
 */

import { Component, For, Show, createMemo, onCleanup, onMount } from "solid-js";

import { formatCostUsd } from "../lib/format";
import {
  groupIntoLanes,
  needsYouCount,
  type FleetLaneGroup,
  type FleetNode,
  type FleetNodeState,
} from "../lib/fleet-lanes";
import { fleetBoard, subscribeFleet, taskSession, unsubscribeFleet } from "../state/fleet";
import { focusSession } from "../state/sessions";

/**
 * Semantic colours for the status vocabulary (§6). Deliberately separate from
 * the product accent, which is chrome: this is a signal system, and `awaiting`
 * must read as "you" rather than as "conductor".
 *
 * `working` is the only state that animates — motion is the scarcest signal on
 * screen, so spending it anywhere else would devalue it. `disconnected` is
 * quiet grey, never red: a dropped runner is a transport event, and colouring
 * it as an error trains the operator to ignore errors.
 */
const STATE_STYLE: Record<FleetNodeState, { cls: string; title: string }> = {
  awaiting: {
    cls: "border-warn/60 bg-warn/15 text-warn",
    title: "Waiting on you — an approval or a question is blocking this agent",
  },
  blocked: {
    cls: "border-danger/60 bg-danger/15 text-danger",
    title: "Blocked — hit the anti-spin failure limit and will not retry",
  },
  failed: {
    cls: "border-danger/50 bg-danger/10 text-danger",
    title: "Failed — the task errored",
  },
  working: {
    cls: "border-warn/50 bg-warn/10 text-warn animate-pulse",
    title: "Working — running a turn or a tool",
  },
  queued: {
    cls: "border-border bg-bg text-fg-muted",
    title: "Queued — accepted, waiting for a worker slot",
  },
  disconnected: {
    cls: "border-border bg-bg text-fg-faint",
    title: "Disconnected — the runner dropped. Not a failure; the dispatcher reconciles it",
  },
  done: {
    cls: "border-success/40 bg-success/10 text-success",
    title: "Done — the digest came back",
  },
  idle: { cls: "border-border bg-bg text-fg-faint", title: "Idle — settled and quiet" },
};

const FleetRail: Component = () => {
  onMount(() => void subscribeFleet());
  onCleanup(() => unsubscribeFleet());

  const board = fleetBoard;
  const lanes = createMemo<FleetLaneGroup[]>(() => {
    const b = board();
    return groupIntoLanes(b.tasks, (t) => taskSession(b, t));
  });
  const attention = createMemo(() => needsYouCount(lanes()));

  return (
    <aside class="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-border bg-bg-elev/40">
      <header class="sticky top-0 z-10 space-y-1 border-b border-border bg-bg-elev/95 px-3 py-2 backdrop-blur">
        <div class="flex items-center gap-2">
          <h3 class="text-[11px] font-semibold uppercase tracking-wider text-fg-muted">Fleet</h3>
          <Show when={attention() > 0}>
            <span
              class="rounded-full border border-warn/60 bg-warn/15 px-1.5 font-mono text-[10px] text-warn"
              title={`${attention()} node(s) waiting on you`}
            >
              {attention()} needs you
            </span>
          </Show>
          <Show when={board().loading}>
            <span class="ml-auto font-mono text-[10px] text-fg-faint">loading…</span>
          </Show>
        </div>
        <div class="flex items-center gap-3 font-mono text-[10px] text-fg-faint">
          <span title="Tasks not yet terminal">{board().agg.activeTasks} active</span>
          <Show when={board().agg.blockedTasks > 0}>
            <span class="text-danger" title="Tasks that hit the failure limit">
              {board().agg.blockedTasks} blocked
            </span>
          </Show>
          <span class="ml-auto text-accent" title="Fleet cost across every backend">
            {formatCostUsd(board().agg.totalCostUsd)}
          </span>
        </div>
      </header>

      <Show when={board().error}>
        {(err) => (
          <p class="border-b border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            {err()}
          </p>
        )}
      </Show>

      <Show
        when={lanes().length > 0}
        fallback={
          <p class="px-3 py-4 text-xs text-fg-faint">
            {board().fetchedAt === 0
              ? "Connecting to the board…"
              : "Nothing dispatched yet. Ask the conductor to send or spawn work."}
          </p>
        }
      >
        <For each={lanes()}>{(lane) => <Lane group={lane} />}</For>
      </Show>
    </aside>
  );
};

const Lane: Component<{ group: FleetLaneGroup }> = (props) => (
  <section class="flex flex-col">
    <h4
      class="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-fg-muted"
      aria-label={`${props.group.label}, ${props.group.nodes.length} item(s)`}
    >
      {props.group.label}
      <span class="ml-1 font-mono text-fg-faint">{props.group.nodes.length}</span>
    </h4>
    <ul class="flex flex-col">
      <For each={props.group.nodes}>{(node) => <NodeRow node={node} />}</For>
    </ul>
  </section>
);

const NodeRow: Component<{ node: FleetNode }> = (props) => {
  const style = () => STATE_STYLE[props.node.state];
  // A task with no session yet (a queued spawn) has nowhere to drill into, so
  // it renders as a plain row rather than a button that would do nothing.
  const target = () => props.node.session;
  const label = () =>
    props.node.session?.name ?? `${props.node.task.kind} ${props.node.task.id.slice(0, 8)}`;

  const body = (
    <>
      <div class="flex items-center gap-2">
        <span
          class={`shrink-0 rounded border px-1 font-mono text-[10px] uppercase tracking-wider ${style().cls}`}
          title={style().title}
        >
          {props.node.state}
        </span>
        <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-fg">{label()}</span>
        <span
          class="shrink-0 font-mono text-[10px] text-fg-faint"
          title={`${props.node.task.kind} · ${props.node.task.shape}`}
        >
          {props.node.task.shape}
        </span>
      </div>
      {/* The digest is why "Ready to review" is a lane — clamped, because the
          rail is a board, not a reader. */}
      <Show when={props.node.task.resultDigest}>
        {(d) => (
          <p class="line-clamp-2 pl-1 text-[11px] leading-snug text-fg-muted">{d()}</p>
        )}
      </Show>
      <Show when={props.node.task.error}>
        {(e) => <p class="line-clamp-2 pl-1 text-[11px] leading-snug text-danger">{e()}</p>}
      </Show>
      <Show when={props.node.task.attempts > 0 && props.node.state !== "done"}>
        <p class="pl-1 font-mono text-[10px] text-fg-faint">
          attempt {props.node.task.attempts + 1}
        </p>
      </Show>
    </>
  );

  return (
    <li class="border-b border-border/40 last:border-b-0">
      <Show
        when={target()}
        fallback={<div class="flex flex-col gap-1 px-3 py-2">{body}</div>}
      >
        {(s) => (
          <button
            type="button"
            onClick={() => focusSession(s().id)}
            title={`Open ${s().name} — take over from the conductor`}
            class="flex w-full flex-col gap-1 px-3 py-2 text-left transition hover:bg-bg-hover"
          >
            {body}
          </button>
        )}
      </Show>
    </li>
  );
};

export default FleetRail;
