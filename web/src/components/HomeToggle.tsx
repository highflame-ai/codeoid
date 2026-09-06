/**
 * The Conductor ⇄ Sessions toggle (conductor-frontends-design §3.A).
 *
 * Two co-equal homes, one control. Neither is modal — this changes which
 * session you are looking at and nothing else, and every session stays
 * reachable from the list in both homes. That is §3's load-bearing constraint:
 * the conductor is a lens over the same sessions, never a wall, and there must
 * be no state a user can get stuck in.
 *
 * The resolution rules live in `lib/home.ts`; this is the control plus the one
 * effect that acts on the choice.
 */

import { Component, createEffect, createMemo, createSignal } from "solid-js";

import { findConductor, homeTarget, type Home } from "../lib/home";
import { activeHome, setHome } from "../state/layout";
import { focusedSessionId, focusSession, sessionList } from "../state/sessions";

/**
 * The last ordinary session focused before switching to the conductor, so
 * switching back returns you to your work rather than an arbitrary first row.
 *
 * Module-level, not persisted: it is a within-visit convenience, and a
 * remembered id from days ago is more likely to name a destroyed session than
 * to be useful.
 */
const [lastSessionId, setLastSessionId] = createSignal<string | null>(null);

const HomeToggle: Component = () => {
  const conductor = createMemo(() => findConductor(sessionList()));

  // Track where the user was in Sessions, so Conductor → Sessions can return
  // them there. Recorded on every focus change that is not the conductor.
  createEffect(() => {
    const id = focusedSessionId();
    if (!id) return;
    const s = sessionList().find((x) => x.id === id);
    if (s && s.role === undefined) setLastSessionId(id);
  });

  // Acting on the choice is an effect rather than click handling, so the two
  // stay consistent when the population changes underneath — e.g. the conductor
  // is created while Conductor home is already selected.
  createEffect(() => {
    const target = homeTarget(
      sessionList(),
      activeHome(),
      focusedSessionId() ?? null,
      lastSessionId(),
    );
    if (target) focusSession(target);
  });

  return (
    <div
      class="flex items-center rounded border border-border bg-bg p-0.5"
      role="group"
      aria-label="Home"
    >
      <HomeButton home="sessions" label="Sessions" title="Your sessions — the classic list and cockpit" />
      <HomeButton
        home="conductor"
        label="Conductor"
        title={
          conductor()
            ? "The conductor — chat to it and watch the fleet"
            : "No conductor yet — create one to route work across your sessions"
        }
        // Shown but inert-looking when there is none: the toggle should still
        // say the feature exists rather than hiding it until it is used.
        muted={!conductor()}
      />
    </div>
  );
};

const HomeButton: Component<{
  home: Home;
  label: string;
  title: string;
  muted?: boolean;
}> = (props) => {
  const active = () => activeHome() === props.home;
  return (
    <button
      type="button"
      onClick={() => setHome(props.home)}
      title={props.title}
      aria-pressed={active()}
      class={`rounded px-2 py-0.5 text-[11px] font-medium transition ${
        active()
          ? "bg-accent/15 text-accent"
          : props.muted
            ? "text-fg-faint hover:text-fg-muted"
            : "text-fg-muted hover:text-fg"
      }`}
    >
      {props.label}
    </button>
  );
};

/** Reset the remembered session — for tests. */
export function _resetHomeMemoryForTest(): void {
  setLastSessionId(null);
}

export default HomeToggle;
