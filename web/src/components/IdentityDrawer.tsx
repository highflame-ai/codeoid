/**
 * Identity drawer — surfaces the full ZeroID provenance for the current
 * connection. Triggered by:
 *   - clicking the identity chip in the StatusBar
 *   - the `/who` slash command
 *
 * Daemon-canonical: every value comes straight from the auth.ok payload
 * or focused SessionInfo — no client-side embellishment. Click any
 * SPIFFE/WIMSE URI to copy it.
 */

import { Component, For, Show, createSignal, onCleanup, onMount, type JSX } from "solid-js";

import { authIdentity } from "../state/connection";
import { focusedSession } from "../state/sessions";
import { identityColorClass } from "../lib/identity";

const [openSignal, setOpenSignal] = createSignal(false);

export function openIdentityDrawer(): void {
  setOpenSignal(true);
}

export function closeIdentityDrawer(): void {
  setOpenSignal(false);
}

const IdentityDrawer: Component = () => {
  // Esc closes
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && openSignal()) {
        e.preventDefault();
        setOpenSignal(false);
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <Show when={openSignal()}>
      <div
        class="fixed inset-0 z-50 flex items-start justify-end bg-bg/60 backdrop-blur-sm"
        onClick={(e) => {
          if (e.target === e.currentTarget) setOpenSignal(false);
        }}
      >
        <aside class="h-full w-full max-w-md overflow-y-auto border-l border-border bg-bg-elev p-5 shadow-2xl">
          <header class="mb-4 flex items-center gap-2">
            <h2 class="text-base font-semibold tracking-tight text-fg">
              Identity
            </h2>
            <button
              type="button"
              onClick={() => setOpenSignal(false)}
              class="ml-auto text-fg-faint hover:text-fg"
              title="Close (Esc)"
            >
              ✕
            </button>
          </header>

          <LocalModeNotice />
          <ConnectedAs />
          <FrontendInfo />
          <SessionAgent />
          <Subagents />
          <Scopes />
        </aside>
      </div>
    </Show>
  );
};

/**
 * Local-mode disclaimer, first thing in the drawer.
 *
 * This panel's whole premise is ZeroID provenance. In local mode there is none,
 * so every field below it is self-asserted — saying so up front is the
 * difference between an honest surface and a misleading one.
 */
const LocalModeNotice: Component = () => (
  <Show when={authIdentity()?.authMode === "local"}>
    <div class="mb-4 rounded border border-warn/40 bg-warn/10 p-3 text-[11px] leading-relaxed text-warn">
      <div class="mb-1 font-semibold uppercase tracking-wider">Local mode — no verified identity</div>
      This daemon runs without ZeroID, so everything below is{" "}
      <strong>self-asserted</strong>, not cryptographically verified. Per-agent and
      sub-agent identities, delegated tokens, scope attenuation, and cascading
      revocation are all off. The audit log still records every action, but not who
      it can prove made it.
      <div class="mt-1.5 text-fg-muted">
        For real identities: <code class="font-mono">codeoid login</code>, then restart
        the daemon without <code class="font-mono">--local</code>.
      </div>
    </div>
  </Show>
);

const Section: Component<{ title: string; children: JSX.Element }> = (props) => (
  <section class="mb-5">
    <h3 class="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-fg-faint">
      {props.title}
    </h3>
    {props.children}
  </section>
);

const Field: Component<{ label: string; value: string; hint?: string }> = (
  props,
) => (
  <div class="mb-2">
    <div class="text-[10px] uppercase tracking-wider text-fg-faint">
      {props.label}
    </div>
    <div class="font-mono text-[12px] text-fg">{props.value}</div>
    <Show when={props.hint}>
      <div class="text-[10px] text-fg-faint">{props.hint}</div>
    </Show>
  </div>
);

const CopyableUri: Component<{ uri: string; label?: string }> = (props) => {
  const [copied, setCopied] = createSignal(false);
  function copy(): void {
    void navigator.clipboard?.writeText(props.uri).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <div class="mb-2">
      <Show when={props.label}>
        <div class="text-[10px] uppercase tracking-wider text-fg-faint">
          {props.label}
        </div>
      </Show>
      <button
        type="button"
        onClick={copy}
        class="group flex w-full items-center gap-2 rounded border border-border bg-bg px-2 py-1.5 text-left transition hover:border-accent/40"
        title="Click to copy"
      >
        <span class="flex-1 break-all font-mono text-[11px] text-fg">
          {props.uri}
        </span>
        <span class="shrink-0 font-mono text-[10px] text-fg-faint group-hover:text-accent">
          {copied() ? "copied" : "copy"}
        </span>
      </button>
    </div>
  );
};

const ConnectedAs: Component = () => (
  <Show when={authIdentity()}>
    {(auth) => {
      const id = () => auth().identity;
      return (
        <Section title="Connected as">
          <div class="mb-2 flex items-baseline gap-2">
            <span class={`text-base font-semibold ${identityColorClass(id().type)}`}>
              {id().name ?? "(unnamed)"}
            </span>
            <span class="rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-fg-muted">
              {id().type}
            </span>
          </div>
          <CopyableUri uri={id().sub} label="SPIFFE / WIMSE URI" />
          <Show when={auth().protocolVersion != null}>
            <Field
              label="Protocol version"
              value={String(auth().protocolVersion)}
              hint="Daemon's wire-protocol revision"
            />
          </Show>
        </Section>
      );
    }}
  </Show>
);

const FrontendInfo: Component = () => (
  <Section title="Frontend">
    <Field label="Client" value="Codeoid Web" />
    <Field
      label="User agent"
      value={navigator.userAgent.split(" ").slice(-2).join(" ")}
      hint="Browser identity (truncated for readability)"
    />
    <Field label="Origin" value={window.location.origin} />
  </Section>
);

const SessionAgent: Component = () => (
  <Show when={focusedSession()}>
    {(s) => (
      <Section title="Session agent">
        <Field label="Session" value={s().name} />
        <Show
          when={s().agentUri && !s().agentUri!.startsWith("anonymous:")}
          fallback={
            <div class="mb-2 text-[11px] italic text-fg-faint">
              Anonymous (no ZeroID agent registered yet — first send registers one).
            </div>
          }
        >
          <CopyableUri uri={s().agentUri!} label="Agent SPIFFE / WIMSE URI" />
        </Show>
        <Show when={s().model}>
          <Field label="Model" value={s().model!} />
        </Show>
        <Field label="Workdir" value={s().workdir} />
      </Section>
    )}
  </Show>
);

const Subagents: Component = () => (
  <Show
    when={
      focusedSession()?.subagents &&
      focusedSession()!.subagents!.length > 0
    }
  >
    <Section title="Sub-agents">
      <For each={focusedSession()!.subagents}>
        {(sa) => (
          <div class="mb-2 rounded border border-border bg-bg px-2 py-1.5">
            <div class="flex items-center gap-2">
              <span class="font-mono text-[12px] text-role-tool">
                {sa.agentType}
              </span>
              <span
                class={`rounded border px-1 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                  sa.active
                    ? "border-success/40 text-success"
                    : "border-border text-fg-faint"
                }`}
              >
                {sa.active ? "active" : "idle"}
              </span>
              <span class="ml-auto font-mono text-[10px] text-fg-faint">
                spawned {new Date(sa.spawnedAt).toLocaleTimeString()}
              </span>
            </div>
            <Show when={sa.wimseUri}>
              <div class="mt-1 break-all font-mono text-[10px] text-fg-muted">
                {sa.wimseUri}
              </div>
            </Show>
          </div>
        )}
      </For>
    </Section>
  </Show>
);

const Scopes: Component = () => (
  <Show when={authIdentity()?.scopes?.length}>
    <Section title="Granted scopes">
      <ul class="flex flex-wrap gap-1">
        <For each={authIdentity()!.scopes as readonly string[]}>
          {(s) => (
            <li>
              <span class="rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-[11px] text-fg-muted">
                {s}
              </span>
            </li>
          )}
        </For>
      </ul>
    </Section>
  </Show>
);

export default IdentityDrawer;
