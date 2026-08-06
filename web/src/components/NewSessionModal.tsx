/**
 * New-session creation modal. Triggered by:
 *   - Sidebar "+ new session" button
 *   - Empty-state CTA in the center pane
 *   - Cmd/Ctrl+N anywhere
 *
 * Sends `session.create` and waits for the daemon's `session.list.result`
 * follow-up (or info_update) to populate the new entry. We don't
 * optimistically insert — daemon is canonical.
 */

import {
  Component,
  For,
  Index,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";

import { authIdentity, newRequestId, refreshSessions, request } from "../state/connection";
import { fetchPacks, packsState } from "../state/packs";
import { runPipeline } from "../state/pipelines";
import { focusSession, mergeSession, sessionList } from "../state/sessions";
import type { PackWire, SessionInfo } from "../protocol/types";
import DirectoryPicker from "./files/DirectoryPicker";

/** The modal serves three flows from one dialog: a plain session, a governed
 *  pipeline run (docs/pipeline-run.md — adds a goal box + requires a pack), or
 *  a COLLABORATIVE session (docs/collaborative-session-design.md §9 — a goal
 *  plus role→backend bindings, which the daemon compiles to an ephemeral
 *  one-goal pack; pack vocabulary deliberately stays hidden on that path). */
type Mode = "session" | "pipeline" | "collaborate";

/** One editable role row. Kept as strings so partially-typed input renders;
 *  it is normalized into the wire shape at submit. */
interface CollabRoleRow {
  name: string;
  /** "" = the daemon default backend. */
  providerId: string;
  /** "" = that backend's own default model. */
  model: string;
  count: number;
  /** Opt-in write authority. Default OFF — §3 gives review/search no repo
   *  write, and a read-only child's identity carries no write scope at all. */
  write: boolean;
}

/** The §3 starting profile: an orchestrator plus one worker. The orchestrator
 *  is claude-pinned in v1 (#245) — it is the only backend that mounts the
 *  fleet MCP server, and the daemon rejects anything else. */
function defaultRoles(): CollabRoleRow[] {
  return [
    { name: "orchestrator", providerId: "claude", model: "", count: 1, write: false },
    { name: "search", providerId: "", model: "", count: 1, write: false },
  ];
}

/** The three kinds, in escalating structure. Order is the reading order of the
 *  toggle: one agent → several agents → a governed phase sequence. */
const MODES = ["session", "collaborate", "pipeline"] as const;

const MODE_LABELS: Record<Mode, string> = {
  session: "Single agent",
  collaborate: "Collaborative",
  pipeline: "Pipeline",
};

/**
 * One line per mode, stating what you get — and specifically what a PACK means
 * here, because the same picker means two different things one click apart:
 * ambient activation in `session`, the phase source in `pipeline`. Adjacency is
 * exactly what makes saying so necessary.
 */
const MODE_BLURBS: Record<Mode, string> = {
  session:
    "A session is one agent conversation rooted at a workdir. The daemon registers a per-session ZeroID agent identity automatically. A pack here is AMBIENT — its constitution, skills and subagents load, but no phases are run.",
  collaborate:
    "One goal, several agents in named roles — each on its own backend. This session is the orchestrator; the others come up as its children and hand work to each other through a shared goal blackboard.",
  pipeline:
    "Run an installed pack against a goal. It creates a session, auto-advances through the pack's PHASES, and halts at each boundary for you to Approve / Revise / Reject.",
};

const [openSignal, setOpenSignal] = createSignal(false);
const [mode, setMode] = createSignal<Mode>("session");
const [goalPrefill, setGoalPrefill] = createSignal("");

/** External hook so the empty-state CTA / sidebar button can open it. */
export function openNewSessionModal(): void {
  setMode("session");
  setOpenSignal(true);
}

/** Open the SAME dialog in pipeline mode: a goal / feature box + a required pack.
 *  Submitting starts a governed run and focuses its bound session (the run shows
 *  up as a normal chat). Wired to `/pipeline` and the Pack Browser's Run action. */
/** Open the dialog in COLLABORATIVE mode: one goal worked by several
 *  role-children on their own backends. */
export function openCollaborateModal(goal?: string): void {
  setMode("collaborate");
  setGoalPrefill(goal ?? "");
  setOpenSignal(true);
}

export function openPipelineModal(goal?: string): void {
  setMode("pipeline");
  setGoalPrefill(goal ?? "");
  setOpenSignal(true);
}

const NewSessionModal: Component = () => {
  const [name, setName] = createSignal("");
  const [workdir, setWorkdir] = createSignal("");
  // Pipeline mode only: the feature/goal that seeds the run's spec phase.
  const [goal, setGoal] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [pickerOpen, setPickerOpen] = createSignal(false);
  // "" = daemon default (first advertised provider).
  const [providerId, setProviderId] = createSignal("");
  // Ambient pack activation (docs/pack-loading.md): "" = freestyle (no pack).
  const [packId, setPackId] = createSignal("");
  // Capability role declared by the chosen pack; "" = no role restriction.
  const [packRole, setPackRole] = createSignal("");

  // ── Collaborative mode ────────────────────────────────────────────────────
  // One row per role. The orchestrator is always present and is NOT removable:
  // the daemon requires exactly one, and the session being created IS it.
  const [roles, setRoles] = createSignal<CollabRoleRow[]>(defaultRoles());

  const updateRole = (i: number, patch: Partial<CollabRoleRow>): void => {
    setRoles((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };
  const addRole = (): void => {
    setRoles((rs) => [...rs, { name: "", providerId: "", model: "", count: 1, write: false }]);
  };
  const removeRole = (i: number): void => {
    setRoles((rs) => rs.filter((_, j) => j !== i));
  };

  /** Client-side pre-flight. The daemon re-validates everything — this only
   *  spares a round-trip on the mistakes that are obvious locally. */
  const collabProblem = createMemo<string | null>(() => {
    if (mode() !== "collaborate") return null;
    if (!goal().trim()) return "a goal is required";
    const named = roles().filter((r) => r.name.trim());
    if (named.length !== roles().length) return "every role needs a name";
    const seen = new Set<string>();
    for (const r of named) {
      const key = r.name.trim().toLowerCase();
      if (seen.has(key)) return `duplicate role "${r.name.trim()}"`;
      seen.add(key);
    }
    if (!seen.has("orchestrator")) return 'one role must be named "orchestrator"';
    // Pack adoption (docs/role-model-binding.md §6.1): role names bind
    // STRICTLY to the pack's declared roles — mirror the daemon's rule so the
    // mistake surfaces before the round-trip. The daemon still re-validates.
    if (packId()) {
      const declared = new Set(packRoles().map((n) => n.toLowerCase()));
      if (!declared.has("orchestrator")) {
        return `pack "${packId()}" declares no orchestrator role — it can't be adopted by a collaboration`;
      }
      for (const r of named) {
        if (!declared.has(r.name.trim().toLowerCase())) {
          return `pack "${packId()}" declares no role "${r.name.trim()}"`;
        }
      }
    }
    return null;
  });

  // Backends this daemon registered (auth.ok `providers`, default first).
  // Older daemons don't advertise — hide the picker, sessions stay claude.
  const providers = createMemo<string[]>(() => authIdentity()?.providers ?? []);

  // Installed packs from the daemon-canonical pack state. Empty when none are
  // installed OR when the fetch was rejected (e.g. the session token lacks
  // `pipeline:read`) — either way we degrade to a subtle note and never block
  // freestyle session creation.
  const installedPacks = createMemo<PackWire[]>(() => packsState().installed ?? []);
  const selectedPack = createMemo<PackWire | undefined>(() =>
    installedPacks().find((p) => p.id === packId()),
  );
  // Roles the chosen pack declares (populate the role <select>).
  const packRoles = createMemo<string[]>(() => selectedPack()?.roles ?? []);

  /** The pack's currently-effective binding for a collab role name (Slice 2's
   *  `resolvedRoles`) — shown as the model input's placeholder so an empty
   *  field reads as what the daemon will actually resolve to. */
  const effectiveBinding = (name: string) =>
    selectedPack()?.resolvedRoles?.find(
      (rr) => rr.name.toLowerCase() === name.trim().toLowerCase(),
    );

  // Pipeline runs need an ACTIVE (registered) pack — an inactive/broken pack
  // can't back a run; ambient session mode can pick any installed pack.
  const packOptions = createMemo<PackWire[]>(() =>
    mode() === "pipeline" ? installedPacks().filter((p) => p.active && !p.error) : installedPacks(),
  );

  /**
   * Switching into pipeline mode with an inactive pack selected: the pack list
   * narrows to active packs, so the selection would silently disappear and Start
   * would sit disabled with nothing explaining why. Name it instead.
   *
   * Deliberately NOT auto-cleared — the user picked that pack, and the fix they
   * want is usually "activate it", not "lose it".
   */
  const inactivePackWarning = createMemo<string | null>(() => {
    if (mode() !== "pipeline" || !packId()) return null;
    if (packOptions().some((p) => p.id === packId())) return null;
    const chosen = installedPacks().find((p) => p.id === packId());
    if (!chosen) return null;
    return chosen.error
      ? `${chosen.name} failed to load (${chosen.error}) — a pipeline needs a healthy pack. Fix it or pick another via /packs.`
      : `${chosen.name} is installed but not active — activate it via /packs to run its phases, or pick an active pack.`;
  });

  // Changing the pack invalidates any previously-picked role. `defer` so this
  // doesn't clobber the initial empty state on first run. In collaborate mode
  // it also clears the non-orchestrator role NAMES — a name only means
  // something relative to the pack that declares it. Signal updates only: the
  // rows themselves are reused (the <Index> below keys by position), so no
  // input is remounted and focus survives.
  createEffect(
    on(
      packId,
      () => {
        setPackRole("");
        if (mode() === "collaborate") {
          setRoles((rs) =>
            rs.map((r) =>
              r.name.trim().toLowerCase() === "orchestrator" ? r : { ...r, name: "" },
            ),
          );
        }
      },
      { defer: true },
    ),
  );

  // Pipeline mode requires a pack, so default the picker to the selected/first
  // active pack once the (async) pack list lands — otherwise the <select> shows
  // a pack visually while packId() is still "" (and Start stays disabled).
  createEffect(() => {
    if (mode() !== "pipeline" || !openSignal() || packId()) return;
    const opts = packOptions();
    const def = opts.find((p) => p.selected)?.id ?? opts[0]?.id;
    if (def) setPackId(def);
  });

  /**
   * Mode switching PRESERVES the pack, deliberately.
   *
   * Switching pipeline → session with the pack kept is not data loss, it is the
   * other legitimate use of the same pack: "I want the constitution, not the
   * phases." Clearing it would force a re-pick to express that. The reverse
   * direction is equally useful — pick a pack, realise you want its phases,
   * switch to Pipeline and Start.
   *
   * `packRole` is the exception: it is session-only (a pipeline applies each
   * phase's role per-phase), so it is dropped when leaving session mode rather
   * than silently ignored by the daemon.
   */
  createEffect(
    on(
      mode,
      (m) => {
        if (m !== "session") setPackRole("");
      },
      // `defer` so opening the dialog doesn't count as a switch. Matches the
      // packId effect above; a `prev === undefined` guard would be wrong here —
      // Solid passes prev undefined on the first deferred run, which silently
      // skipped the clear.
      { defer: true },
    ),
  );

  let nameRef: HTMLInputElement | undefined;

  // Recent workdirs from past sessions, deduped and sorted by frequency.
  // Click a chip to fill the input — quick path for "I want another
  // session in the same repo" without retyping the path.
  const recentWorkdirs = createMemo<string[]>(() => {
    const counts = new Map<string, number>();
    for (const s of sessionList()) {
      if (!s.workdir) continue;
      counts.set(s.workdir, (counts.get(s.workdir) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([wd]) => wd)
      .slice(0, 8);
  });

  // Global Cmd/Ctrl+N opens; Esc closes.
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setOpenSignal(true);
      } else if (e.key === "Escape" && openSignal() && !pickerOpen()) {
        // When the directory picker is open, let ITS Esc handler close only the
        // picker — don't also tear down the modal and lose the typed name/workdir.
        e.preventDefault();
        setOpenSignal(false);
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  // Reset state on close, focus name input on open.
  createEffect(
    on(openSignal, (v) => {
      if (v) {
        setBusy(false);
        setError(null);
        if (mode() === "pipeline" || mode() === "collaborate") setGoal(goalPrefill());
        if (mode() === "collaborate") {
          setRoles(defaultRoles());
          // Fresh dialog = free-form default; a pack left over from a prior
          // session-mode open would silently bind the default roster.
          setPackId("");
        }
        // Refresh the pack list every open. fetchPacks swallows its own
        // errors (it sets pack-state.error rather than rejecting), but guard
        // anyway so a rejected read can never break opening the modal.
        void fetchPacks().catch(() => {});
        requestAnimationFrame(() => nameRef?.focus());
      }
    }),
  );

  async function submit(ev: Event): Promise<void> {
    ev.preventDefault();
    if (busy()) return;
    const n = name().trim();

    // ── Pipeline run ──────────────────────────────────────────────────────────
    if (mode() === "pipeline") {
      const g = goal().trim();
      if (!packId()) {
        setError("pick a pack to run");
        return;
      }
      if (!g) {
        setError("a goal / feature description is required");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        // runPipeline creates the run, focuses its bound session (the run shows
        // up as a normal chat), and drives it — catching its own errors into
        // pipeline state, so we can close as soon as it returns.
        await runPipeline({
          pack: packId(),
          goal: g,
          workdir: workdir().trim() || ".",
          ...(n ? { name: n } : {}),
          ...(providerId() ? { provider: providerId() } : {}),
        });
        setBusy(false);
        setOpenSignal(false);
        setName("");
        setWorkdir("");
        setGoal("");
        setProviderId("");
        setPackId("");
        setPackRole("");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      }
      return;
    }

    // ── Collaborative session ─────────────────────────────────────────────────
    if (mode() === "collaborate") {
      const problem = collabProblem();
      if (problem) {
        setError(problem);
        return;
      }
      if (!n) {
        setError("name required");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const data = (await request({
          type: "session.create",
          id: newRequestId(),
          name: n,
          workdir: workdir().trim() || ".",
          // Pack ADOPTION (docs/role-model-binding.md §6): the pack — not the
          // collab machinery — defines what each role is. Omitted = free-form.
          ...(packId() ? { pack: packId() } : {}),
          collaboration: {
            goal: goal().trim(),
            roles: roles().map((r) => ({
              name: r.name.trim(),
              // A blank picker means "daemon default"; the wire field is
              // required, so resolve it to the advertised default here.
              providerId: r.providerId || providers()[0] || "claude",
              ...(r.model.trim() ? { model: r.model.trim() } : {}),
              ...(r.count > 1 ? { count: r.count } : {}),
              // Under a pack, write authority comes from the role YAML — the
              // daemon rejects a spec that argues with it, so send nothing.
              ...(r.write && !packId() ? { write: true } : {}),
            })),
          },
          // providerId is deliberately NOT sent: a collaborative session IS its
          // orchestrator, so the daemon derives the backend from that role and
          // rejects a conflicting explicit value.
        })) as SessionInfo | undefined;
        if (data && typeof data === "object" && "id" in data) {
          mergeSession(data);
          focusSession(data.id);
        } else {
          await refreshSessions().catch(() => []);
        }
        setBusy(false);
        setOpenSignal(false);
        setName("");
        setWorkdir("");
        setGoal("");
        setRoles(defaultRoles());
        setPackId("");
      } catch (err) {
        // The daemon's message is the useful one here — it names the exact
        // rule broken (unknown provider, non-claude orchestrator, over the
        // child ceiling), so surface it verbatim rather than paraphrasing.
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      }
      return;
    }

    // ── Plain session ─────────────────────────────────────────────────────────
    if (!n) {
      setError("name required");
      return;
    }
    const wd = workdir().trim() || ".";
    setBusy(true);
    setError(null);
    try {
      // request() (not fire-and-forget send + a 450ms guess): the daemon acks
      // with the created SessionInfo, so a rejection (bad scope/workdir) surfaces
      // as an error instead of silently "succeeding", and we focus the exact new
      // id rather than name-matching (which picked the wrong one on duplicates).
      const data = (await request({
        type: "session.create",
        id: newRequestId(),
        name: n,
        workdir: wd,
        ...(providerId() ? { providerId: providerId() } : {}),
        ...(packId() ? { pack: packId() } : {}),
        ...(packRole() ? { packRole: packRole() } : {}),
      })) as SessionInfo | undefined;
      if (data && typeof data === "object" && "id" in data) {
        mergeSession(data);
        focusSession(data.id);
      } else {
        // Older daemon without a data payload — fall back to a list refresh.
        const list = await refreshSessions().catch(() => []);
        const created = list.find((s) => s.name === n);
        if (created) focusSession(created.id);
      }
      setBusy(false);
      setOpenSignal(false);
      setName("");
      setWorkdir("");
      setProviderId("");
      setPackId("");
      setPackRole("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Show when={openSignal()}>
      <div
        class="fixed inset-0 z-40 flex items-start justify-center bg-bg/70 backdrop-blur-sm"
        onClick={(e) => {
          if (e.target === e.currentTarget) setOpenSignal(false);
        }}
      >
        <form
          onSubmit={submit}
          class="mt-[16vh] w-full max-w-md space-y-4 rounded-lg border border-border bg-bg-elev p-5 shadow-2xl"
        >
          <header class="space-y-2">
            <h2 class="text-base font-semibold tracking-tight text-fg">
              {mode() === "pipeline"
                ? "Start a pipeline run"
                : mode() === "collaborate"
                  ? "New collaborative session"
                  : "New session"}
            </h2>
            {/* All three kinds are toggles on the SAME dialog, per design §9:
                "the run IS a session plus a goal and a config, so it extends the
                existing create-session dialog rather than a bespoke panel."
                Pipeline used to be reachable only from /pipeline and the Pack
                Browser's Run action, so someone who came looking for pack-driven
                phases in this dialog found the pack picker — which means AMBIENT
                activation here — and no phase tracing. Same dialog, three honest
                choices.

                Rendered in EVERY mode, including pipeline: arriving from Pack
                Browser → Run used to hide the toggle entirely, leaving you in a
                mode you could neither see nor leave. */}
            <div class="flex gap-1" role="radiogroup" aria-label="Session kind">
              <For each={MODES}>
                  {(m) => (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={mode() === m}
                      onClick={() => setMode(m)}
                      class={`rounded border px-2 py-0.5 text-[12px] transition ${
                        mode() === m
                          ? "border-accent/60 bg-accent/10 text-accent"
                          : "border-border bg-bg text-fg-muted hover:border-accent/40 hover:text-fg"
                      }`}
                      disabled={busy()}
                    >
                      {MODE_LABELS[m]}
                    </button>
                  )}
              </For>
            </div>
            <p class="text-xs text-fg-muted">{MODE_BLURBS[mode()]}</p>
          </header>

          <label class="block space-y-1.5">
            <span class="text-[11px] font-medium uppercase tracking-wider text-fg-faint">
              Name{mode() === "pipeline" ? " (optional)" : ""}
            </span>
            <input
              ref={nameRef}
              type="text"
              autocomplete="off"
              spellcheck={false}
              placeholder={mode() === "pipeline" ? "defaults to the goal" : "e.g. shield-refactor"}
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              class="w-full rounded border border-border bg-bg px-3 py-1.5 font-mono text-sm text-fg outline-none focus:border-accent"
              disabled={busy()}
              required={mode() === "session"}
            />
          </label>

          <label class="block space-y-1.5">
            <span class="text-[11px] font-medium uppercase tracking-wider text-fg-faint">
              Workdir
            </span>
            <div class="flex gap-1.5">
              <input
                type="text"
                autocomplete="off"
                spellcheck={false}
                placeholder="."
                value={workdir()}
                onInput={(e) => setWorkdir(e.currentTarget.value)}
                class="flex-1 rounded border border-border bg-bg px-3 py-1.5 font-mono text-sm text-fg outline-none focus:border-accent"
                disabled={busy()}
              />
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                class="rounded border border-border bg-bg px-3 py-1.5 text-sm text-fg-muted transition hover:border-accent/40 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                disabled={busy()}
                title="Browse the daemon host's filesystem"
              >
                Browse…
              </button>
            </div>
            <Show when={recentWorkdirs().length > 0}>
              <div class="space-y-1">
                <span class="text-[10px] uppercase tracking-wider text-fg-faint">
                  Recent
                </span>
                <div class="flex flex-wrap gap-1">
                  <For each={recentWorkdirs()}>
                    {(wd) => (
                      <button
                        type="button"
                        onClick={() => setWorkdir(wd)}
                        class={`max-w-full truncate rounded border px-1.5 py-0.5 font-mono text-[11px] transition ${
                          workdir() === wd
                            ? "border-accent/60 bg-accent/10 text-accent"
                            : "border-border bg-bg text-fg-muted hover:border-accent/40 hover:text-fg"
                        }`}
                        title={wd}
                      >
                        {compactPath(wd)}
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>
            <p class="text-[10px] text-fg-faint">
              Path on the daemon host. Defaults to the daemon's CWD when blank.
            </p>
          </label>

          <Show when={mode() === "pipeline" || mode() === "collaborate"}>
            <label class="block space-y-1.5">
              <span class="text-[11px] font-medium uppercase tracking-wider text-fg-faint">
                Goal{mode() === "collaborate" ? "" : " / feature"}
              </span>
              <textarea
                rows={mode() === "collaborate" ? 3 : 4}
                placeholder={
                  mode() === "collaborate"
                    ? "The one goal every role works on — e.g. Add rate limiting to the public API"
                    : "Describe the feature to build — this seeds the run's spec phase…"
                }
                value={goal()}
                onInput={(e) => setGoal(e.currentTarget.value)}
                class="w-full resize-y rounded border border-border bg-bg px-3 py-1.5 font-mono text-sm leading-6 text-fg outline-none focus:border-accent"
                disabled={busy()}
                aria-label="Goal"
              />
            </label>
          </Show>

          {/* Role→backend bindings (§3: a role is data, not an enum — the names
              are free-form, and the five defaults are just a starting profile). */}
          <Show when={mode() === "collaborate"}>
            <div class="block space-y-2">
              <span class="text-[11px] font-medium uppercase tracking-wider text-fg-faint">
                Roles
              </span>
              <Index each={roles()}>
                {(r, i) => {
                  const isOrchestrator = () => r().name.trim().toLowerCase() === "orchestrator";
                  return (
                    <div class="space-y-1.5 rounded border border-border bg-bg p-2">
                      <div class="flex gap-1.5">
                        {/* Under an adopted pack, names bind STRICTLY to the
                            pack's declared roles (§6.1) — a <select> makes the
                            legal set visible instead of letting a free-typed
                            name bounce off the daemon. Same row slot either
                            way: the <Index> keeps rows stable, only this
                            element swaps. */}
                        <Show
                          when={packId() && !isOrchestrator()}
                          fallback={
                            <input
                              type="text"
                              placeholder="role name"
                              value={r().name}
                              onInput={(e) => updateRole(i, { name: e.currentTarget.value })}
                              class="min-w-0 flex-1 rounded border border-border bg-bg-elev px-2 py-1 font-mono text-[12px] text-fg outline-none focus:border-accent"
                              disabled={busy() || isOrchestrator()}
                              aria-label="Role name"
                            />
                          }
                        >
                          <select
                            value={r().name}
                            onChange={(e) => updateRole(i, { name: e.currentTarget.value })}
                            class="min-w-0 flex-1 rounded border border-border bg-bg-elev px-2 py-1 font-mono text-[12px] text-fg outline-none focus:border-accent"
                            disabled={busy()}
                            aria-label="Role name"
                          >
                            <option value="">pick a role…</option>
                            <For each={packRoles().filter((n) => n.toLowerCase() !== "orchestrator")}>
                              {(n) => <option value={n}>{n}</option>}
                            </For>
                          </select>
                        </Show>
                        <select
                          value={r().providerId}
                          onChange={(e) => updateRole(i, { providerId: e.currentTarget.value })}
                          class="rounded border border-border bg-bg-elev px-2 py-1 font-mono text-[12px] text-fg outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
                          /* Claude-only in v1: it is the only backend that
                             mounts the fleet MCP server (#245), and the daemon
                             rejects any other orchestrator outright. */
                          disabled={busy() || isOrchestrator()}
                          aria-label="Backend"
                        >
                          <Show when={!isOrchestrator()}>
                            <option value="">default</option>
                          </Show>
                          <For each={providers()}>{(id) => <option value={id}>{id}</option>}</For>
                        </select>
                        <button
                          type="button"
                          onClick={() => removeRole(i)}
                          class="rounded border border-border px-2 py-1 text-[12px] text-fg-muted transition hover:border-danger/40 hover:text-danger disabled:cursor-not-allowed disabled:opacity-30"
                          /* The daemon requires exactly one orchestrator, and
                             this session IS it — so it can't be removed. */
                          disabled={busy() || isOrchestrator()}
                          title={isOrchestrator() ? "the orchestrator is required" : "remove role"}
                          aria-label="Remove role"
                        >
                          ×
                        </button>
                      </div>
                      <div class="flex flex-wrap items-center gap-2">
                        <input
                          type="text"
                          // Under a pack, an empty model resolves through the
                          // binding chain — surface the currently-effective
                          // model (Slice 2's resolvedRoles) as the placeholder
                          // so "blank" reads as what it will actually mean.
                          placeholder={(() => {
                            const eff = packId() ? effectiveBinding(r().name) : undefined;
                            return eff?.model
                              ? `${eff.model} (${eff.resolvedFrom})`
                              : "model (optional)";
                          })()}
                          value={r().model}
                          onInput={(e) => updateRole(i, { model: e.currentTarget.value })}
                          class="min-w-0 flex-1 rounded border border-border bg-bg-elev px-2 py-1 font-mono text-[11px] text-fg outline-none focus:border-accent"
                          disabled={busy()}
                          aria-label="Model"
                        />
                        <Show when={!isOrchestrator()}>
                          <label class="flex items-center gap-1 text-[11px] text-fg-muted">
                            ×
                            <input
                              type="number"
                              min={1}
                              max={8}
                              value={r().count}
                              onInput={(e) =>
                                updateRole(i, {
                                  count: Math.max(1, Number(e.currentTarget.value) || 1),
                                })
                              }
                              class="w-12 rounded border border-border bg-bg-elev px-1 py-1 text-center font-mono text-[11px] text-fg outline-none focus:border-accent"
                              disabled={busy()}
                              aria-label="Count"
                            />
                          </label>
                          {/* Under a pack, write authority is the role
                              YAML's call (§6.1) — offering the checkbox
                              would only manufacture daemon rejections. */}
                          <Show when={!packId()}>
                            <label
                              class="flex items-center gap-1 text-[11px] text-fg-muted"
                              title="Off = this role's agents hold no write scope at all and cannot edit files"
                            >
                              <input
                                type="checkbox"
                                checked={r().write}
                                onChange={(e) => updateRole(i, { write: e.currentTarget.checked })}
                                disabled={busy()}
                              />
                              can write
                            </label>
                          </Show>
                        </Show>
                      </div>
                    </div>
                  );
                }}
              </Index>
              <button
                type="button"
                onClick={addRole}
                class="rounded border border-border px-2 py-1 text-[12px] text-fg-muted transition hover:border-accent/40 hover:text-fg disabled:opacity-50"
                disabled={busy()}
              >
                + add role
              </button>
              <p class="text-[10px] text-fg-faint">
                {packId()
                  ? "Pack adopted: role names bind strictly to the pack's declared roles, and each role's write/network envelope comes from its role YAML. Backend, model and fan-out stay yours."
                  : "Roles are free-form. Known names (search, architecture, reasoning, review) come with a default blackboard scope; anything else starts with none. Read-only is the default — the daemon gives a non-writing role an identity that holds no write scope."}
              </p>
            </div>
          </Show>

          <Show when={providers().length > 1}>
            <div class="block space-y-1.5">
              <span class="text-[11px] font-medium uppercase tracking-wider text-fg-faint">
                Backend
              </span>
              <div class="flex flex-wrap gap-1" role="radiogroup" aria-label="Backend">
                <For each={providers()}>
                  {(id, i) => (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={providerId() === id || (!providerId() && i() === 0)}
                      onClick={() => setProviderId(i() === 0 ? "" : id)}
                      class={`rounded border px-2 py-0.5 font-mono text-[12px] transition ${
                        providerId() === id || (!providerId() && i() === 0)
                          ? "border-accent/60 bg-accent/10 text-accent"
                          : "border-border bg-bg text-fg-muted hover:border-accent/40 hover:text-fg"
                      }`}
                      disabled={busy()}
                    >
                      {id}
                      {i() === 0 ? " (default)" : ""}
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>

          {/* Pack. Session mode: OPTIONAL ambient activation (constitution +
              skills/subagents + an optional capability role). Pipeline mode:
              REQUIRED — the run's phases come from the pack, and each phase's
              role is applied per-phase (so no role picker here). */}
          <div class="block space-y-1.5">
            <span class="text-[11px] font-medium uppercase tracking-wider text-fg-faint">
              Pack{mode() === "pipeline" ? " (required)" : ""}
            </span>
            <Show
              when={packOptions().length > 0}
              fallback={
                <p class="text-[10px] text-fg-faint">
                  {mode() === "pipeline"
                    ? "No active packs — install + activate one via /packs to run a pipeline."
                    : "No packs installed — this session runs freestyle. Install one via /packs."}
                </p>
              }
            >
              <select
                value={packId()}
                onChange={(e) => setPackId(e.currentTarget.value)}
                class="w-full rounded border border-border bg-bg px-3 py-1.5 font-mono text-sm text-fg outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
                disabled={busy()}
                aria-label="Pack"
              >
                <Show when={mode() !== "pipeline"}>
                  <option value="">
                    {mode() === "collaborate" ? "None (free-form roles)" : "None (freestyle)"}
                  </option>
                </Show>
                <For each={packOptions()}>
                  {(p) => <option value={p.id}>{p.name}</option>}
                </For>
              </select>
              <Show when={inactivePackWarning()}>
                <p class="text-[10px] text-warn">{inactivePackWarning()}</p>
              </Show>
              {/* Role is SESSION-mode only: a pipeline applies each phase's own
                  role per-phase, so a manual override here would fight the pack. */}
              <Show when={mode() === "session" && selectedPack() && packRoles().length > 0}>
                <label class="block space-y-1">
                  <span class="text-[10px] uppercase tracking-wider text-fg-faint">
                    Role (optional)
                  </span>
                  <select
                    value={packRole()}
                    onChange={(e) => setPackRole(e.currentTarget.value)}
                    class="w-full rounded border border-border bg-bg px-3 py-1.5 font-mono text-sm text-fg outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={busy()}
                    aria-label="Pack role"
                  >
                    <option value="">Default (no role restriction)</option>
                    <For each={packRoles()}>
                      {(r) => <option value={r}>{r}</option>}
                    </For>
                  </select>
                </label>
              </Show>
            </Show>
          </div>

          <Show when={error()}>
            <div class="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
              {error()}
            </div>
          </Show>

          <Show when={mode() === "collaborate" && !error() && collabProblem()}>
            {/* A disabled Create with no explanation is the worst version of
                this form — say which rule is unmet. */}
            <p class="text-[11px] text-fg-faint">{collabProblem()}</p>
          </Show>

          <div class="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setOpenSignal(false)}
              class="rounded border border-border px-3 py-1.5 text-sm text-fg-muted hover:bg-bg-hover"
              disabled={busy()}
            >
              cancel
            </button>
            <button
              type="submit"
              class="ml-auto rounded bg-accent px-3 py-1.5 text-sm font-semibold text-bg transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              disabled={
                busy() ||
                (mode() === "pipeline"
                  ? !packId() || !goal().trim()
                  : mode() === "collaborate"
                    ? !name().trim() || collabProblem() !== null
                    : !name().trim())
              }
            >
              {busy()
                ? mode() === "pipeline"
                  ? "starting…"
                  : "creating…"
                : mode() === "pipeline"
                  ? "start run"
                  : mode() === "collaborate"
                    ? "create collaboration"
                    : "create"}
            </button>
          </div>
        </form>
        <DirectoryPicker
          open={pickerOpen()}
          {...(workdir() ? { initialPath: workdir() } : {})}
          onPick={(p) => setWorkdir(p)}
          onClose={() => setPickerOpen(false)}
        />
      </div>
    </Show>
  );
};

/** Tighten "/home/ydatta/Workspace/foo" → "~/Workspace/foo". */
function compactPath(p: string): string {
  // The daemon's home is the user this client typically runs against —
  // best-effort string replace; if it doesn't match we render the path
  // verbatim. The full path is always available on hover via title.
  return p.replace(/^\/home\/[^/]+/, "~");
}

export default NewSessionModal;
