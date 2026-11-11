/**
 * Settings → Credentials (docs/workstreams-design.md G2): named credentials
 * workstreams use — declared by id and kind; values set here (into the
 * daemon's env-file store) or managed outside codeoid (a `dir` store, an
 * OAuth sign-in). A value is typed into a password field, sent once and
 * cleared; the daemon only ever says whether one is set.
 */

import { type Component, For, Show, createSignal, onMount } from "solid-js";

import type { CredentialInfo } from "../protocol/types";
import { credentialsState, deleteCredential, fetchCredentials, saveCredential, setCredentialValue } from "../state/workstreams";

const label = "text-[11px] font-medium uppercase tracking-wider text-fg-faint";
const input =
  "w-full rounded border border-border bg-bg px-3 py-1.5 font-mono text-sm text-fg focus:border-accent focus:outline-none";
const button =
  "rounded border border-border bg-bg px-2.5 py-1 text-[12px] text-fg-muted transition hover:border-accent/40 hover:text-fg disabled:opacity-50";

const KINDS: Array<{ kind: CredentialInfo["kind"]; what: string }> = [
  { kind: "env", what: "an env var a workstream sets (GH_TOKEN…)" },
  { kind: "bearer", what: "sent to an MCP server as Authorization: Bearer" },
  { kind: "header", what: "sent to an MCP server in a named header" },
  { kind: "oauth", what: "a second OAuth sign-in to one server" },
];

export const CredentialsPanel: Component = () => {
  onMount(() => void fetchCredentials());
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [adding, setAdding] = createSignal(false);
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(null);
    }
  };
  const store = () => credentialsState().store;

  return (
    <div class="space-y-4">
      <div>
        <h3 class="text-[15px] font-semibold text-fg">Credentials</h3>
        <p class="mt-1 text-[12px] text-fg-muted">
          Secrets workstreams use, by name. A value never leaves the daemon for an agent: it's read when a server is called or a
          session starts. Values live in the <span class="font-mono">{store().kind}</span> store
          {store().writable ? "." : ", managed outside codeoid."}
        </p>
      </div>
      <Show when={error() ?? credentialsState().error}>
        <div class="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">
          {error() ?? credentialsState().error}
        </div>
      </Show>
      <div class="divide-y divide-border rounded border border-border">
        <Show when={credentialsState().loaded && credentialsState().credentials.length === 0}>
          <div class="px-3 py-3 text-[12px] text-fg-muted">None declared yet.</div>
        </Show>
        <For each={credentialsState().credentials}>
          {(c) => <CredentialRow c={c} writable={store().writable} run={run} busy={busy()} />}
        </For>
      </div>
      <Show
        when={adding()}
        fallback={
          <button type="button" class={button} onClick={() => setAdding(true)}>
            Add credential
          </button>
        }
      >
        <AddCredential onDone={() => setAdding(false)} run={run} busy={busy()} />
      </Show>
    </div>
  );
};

const CredentialRow: Component<{
  c: CredentialInfo;
  writable: boolean;
  run: (key: string, fn: () => Promise<void>) => Promise<boolean>;
  busy: string | null;
}> = (props) => {
  const [value, setValue] = createSignal("");
  const [confirm, setConfirm] = createSignal(false);
  const c = () => props.c;
  return (
    <div class="space-y-2 px-3 py-2" data-testid={`credential-${props.c.id}`}>
      <div class="flex flex-wrap items-center gap-2">
        <span class="font-mono text-[13px] text-fg">{c().id}</span>
        <span class="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-fg-faint">{c().kind}</span>
        <Show when={c().header}>
          <span class="font-mono text-[11px] text-fg-faint">{c().header}</span>
        </Show>
        <Show when={c().server}>
          <span class="font-mono text-[11px] text-fg-faint">for {c().server}</span>
        </Show>
        <span class={`text-[11px] ${c().status.set ? "text-success" : "text-warn"}`}>{c().status.set ? `set (${c().status.source})` : "not set"}</span>
        <Show when={c().usedBy.length > 0}>
          <span class="text-[11px] text-fg-muted">used by {c().usedBy.join(", ")}</span>
        </Show>
        <span class="ml-auto">
          <Show
            when={confirm()}
            fallback={
              <button type="button" class={button} onClick={() => setConfirm(true)} disabled={props.busy !== null}>
                Remove
              </button>
            }
          >
            <button type="button" class={`${button} border-danger/50 text-danger`} onClick={() => void props.run(`rm:${c().id}`, () => deleteCredential(c().id))}>
              Remove {c().id} and its value?
            </button>
          </Show>
        </span>
      </div>
      <Show
        when={c().kind !== "oauth"}
        fallback={
          <div class="text-[12px] text-fg-muted">
            Sign in with <code class="font-mono">codeoid mcp signin {c().server} --credential {c().id}</code>
          </div>
        }
      >
        <Show when={props.writable}>
          <form
            class="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void props.run(`set:${c().id}`, () => setCredentialValue(c().id, value())).then((ok) => ok && setValue(""));
            }}
          >
            <input
              type="password"
              class={input}
              autocomplete="off"
              aria-label={`Value of ${c().id}`}
              placeholder={c().status.set ? "replace the value" : "the value"}
              value={value()}
              onInput={(e) => setValue(e.currentTarget.value)}
            />
            <button type="submit" class={button} disabled={value().length === 0 || props.busy !== null}>
              Set
            </button>
            <Show when={c().status.set}>
              <button type="button" class={button} onClick={() => void props.run(`clr:${c().id}`, () => setCredentialValue(c().id, null))}>
                Clear
              </button>
            </Show>
          </form>
        </Show>
      </Show>
    </div>
  );
};

const AddCredential: Component<{ onDone: () => void; run: (key: string, fn: () => Promise<void>) => Promise<boolean>; busy: string | null }> = (props) => {
  const [id, setId] = createSignal("");
  const [kind, setKind] = createSignal<CredentialInfo["kind"]>("env");
  const [extra, setExtra] = createSignal("");
  const save = async () => {
    const item: Record<string, unknown> = { id: id().trim(), kind: kind() };
    if (kind() === "header") item.header = extra().trim();
    if (kind() === "oauth") item.server = extra().trim();
    if (await props.run("add", () => saveCredential(item))) props.onDone();
  };
  return (
    <form
      class="grid gap-3 rounded border border-border p-3 sm:grid-cols-3"
      aria-label="New credential"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label class="grid gap-1">
        <span class={label}>Id</span>
        <input class={input} value={id()} onInput={(e) => setId(e.currentTarget.value)} placeholder="gh-acme" required />
      </label>
      <label class="grid gap-1">
        <span class={label}>Kind</span>
        <select class={input} value={kind()} onChange={(e) => setKind(e.currentTarget.value as CredentialInfo["kind"])}>
          <For each={KINDS}>{(k) => <option value={k.kind}>{`${k.kind} — ${k.what}`}</option>}</For>
        </select>
      </label>
      <Show when={kind() === "header" || kind() === "oauth"}>
        <label class="grid gap-1">
          <span class={label}>{kind() === "header" ? "Header" : "Server"}</span>
          <input class={input} value={extra()} onInput={(e) => setExtra(e.currentTarget.value)} placeholder={kind() === "header" ? "X-Api-Key" : "slack"} required />
        </label>
      </Show>
      <div class="flex gap-2 sm:col-span-3">
        <button type="submit" class={`${button} border-accent/60 text-accent`} disabled={props.busy !== null}>
          Add
        </button>
        <button type="button" class={button} onClick={() => props.onDone()}>
          Cancel
        </button>
      </div>
    </form>
  );
};
