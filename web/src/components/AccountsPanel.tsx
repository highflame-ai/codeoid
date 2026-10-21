/**
 * Settings → Accounts: every backend's named credentials (protocol:
 * accounts.ts, docs/backend-accounts-design.md). Pick a backend, then list,
 * set its default, remove, add, or sign in.
 *
 * Nothing here knows a backend: what an account of each kind takes (a token,
 * a base URL with presets, headers, a set of key variables) and whether it
 * signs in comes from the daemon's `kinds`, and the forms are built from it.
 * An endpoint (`oai:<name>`) appears like any other backend — its accounts are
 * another key and/or headers for the same server.
 *
 * Secrets are typed into password fields, sent once, and cleared; the daemon
 * never sends one back.
 */

import { type Component, For, Index, Show, createSignal, createUniqueId, onMount } from "solid-js";

import {
  accountDetail,
  accountsState,
  backendAccounts,
  DEFAULT_ACCOUNT,
  fetchAccounts,
  kindTakesInput,
  newAccountNameProblem,
  removeAccount,
  saveAccount,
  setDefaultAccount,
} from "../state/accounts";
import { LOGIN_CAPABLE_BACKENDS } from "../protocol/types";
import type { AccountKind, AccountKindInfo, BackendAccountsInfo, LoginBackend } from "../protocol/types";
import { AccountSignIn } from "./AccountSignIn";
import { HeadersEditor } from "./HeadersEditor";
import { ReplaceAccountConfirm } from "./ReplaceAccountConfirm";

const label = "text-[11px] font-medium uppercase tracking-wider text-fg-faint";
const input =
  "w-full rounded border border-border bg-bg px-3 py-1.5 font-mono text-sm text-fg focus:border-accent focus:outline-none";
const button =
  "rounded border border-border bg-bg px-2.5 py-1 text-[12px] text-fg-muted transition hover:border-accent/40 hover:text-fg disabled:opacity-50";

/** The backend the panel shows; null = the first listed. Module-level so a picker can open Settings on it. */
const [selected, setSelected] = createSignal<string | null>(null);

/** Show `backend`'s accounts next time the panel renders (e.g. from a session's account picker). */
export function focusAccountsBackend(backend: string): void {
  setSelected(backend);
}

function asLoginBackend(backend: string): LoginBackend | null {
  return LOGIN_CAPABLE_BACKENDS.includes(backend as LoginBackend) ? (backend as LoginBackend) : null;
}

export const AccountsPanel: Component = () => {
  onMount(() => void fetchAccounts(true));

  const backends = () => accountsState().backends;
  const current = () => backendAccounts(selected() ?? undefined) ?? backends()[0];
  const tabbed = () => backends().length > 1;

  // ARIA tabs (manual activation): arrows / Home / End move focus along the
  // tabs, Enter or Space selects. Selecting rebuilds the section below, so
  // focus alone must not — it would drop a half-filled form or end a sign-in.
  const uid = createUniqueId();
  const tabId = (backend: string) => `${uid}-tab-${encodeURIComponent(backend)}`;
  const panelId = `${uid}-panel`;
  const onTabKey = (e: KeyboardEvent, i: number) => {
    const n = backends().length;
    const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: n - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = backends()[(to + n) % n];
    if (next) document.getElementById(tabId(next.backend))?.focus();
  };

  return (
    <div class="space-y-4">
      <div>
        <h3 class="text-[15px] font-semibold text-fg">Accounts</h3>
        <p class="mt-1 text-[12px] text-fg-muted">
          Several credentials per backend: subscriptions, sign-ins, API keys, gateways. Each session runs on one account of its
          backend (switch it from the session bar) and keeps its conversation; sessions that haven't chosen follow the backend's
          default. Choosing or changing accounts needs settings:write.
        </p>
      </div>

      <Show when={accountsState().error && !backends().length}>
        <div class="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{accountsState().error}</div>
      </Show>

      <Show when={tabbed()}>
        <div class="flex flex-wrap gap-1.5" role="tablist" aria-label="Backend">
          <For each={backends()}>
            {(b, i) => (
              <button
                type="button"
                role="tab"
                id={tabId(b.backend)}
                aria-selected={current()?.backend === b.backend}
                aria-controls={panelId}
                // Roving tabindex: Tab enters the list on the selected tab.
                tabindex={current()?.backend === b.backend ? 0 : -1}
                onClick={() => setSelected(b.backend)}
                onKeyDown={(e) => onTabKey(e, i())}
                class={`rounded border px-2.5 py-1 text-[12px] transition ${
                  current()?.backend === b.backend
                    ? "border-accent/60 bg-accent/10 text-accent"
                    : "border-border bg-bg text-fg-muted hover:border-accent/40 hover:text-fg"
                }`}
              >
                {b.displayName}
                <Show when={b.accounts.length > 0}>
                  <span class="ml-1.5 font-mono text-[10px] text-fg-faint">{b.accounts.length}</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>

      {/* Keyed: switching backend drops a half-filled form and a pending removal. */}
      <Show when={current()?.backend} keyed>
        {(backend) => (
          <div
            id={panelId}
            role={tabbed() ? "tabpanel" : undefined}
            aria-labelledby={tabbed() ? tabId(backend) : undefined}
          >
            <BackendSection backend={backend} />
          </div>
        )}
      </Show>
    </div>
  );
};

/** One backend: its accounts, and the ways to add one. */
const BackendSection: Component<{ backend: string }> = (props) => {
  // Fixed for the section's life: the panel keys it on the backend.
  // eslint-disable-next-line solid/reactivity
  const backend = props.backend;
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  // Which kind is being added, and whether by signing in or by typing it in.
  const [adding, setAdding] = createSignal<{ kind: AccountKind; via: "login" | "form" } | null>(null);
  const [confirmRemove, setConfirmRemove] = createSignal<string | null>(null);

  // Present while rendered: the section is keyed on a backend in the list.
  const info = () => backendAccounts(props.backend) as BackendAccountsInfo;
  const loginBackend = () => asLoginBackend(props.backend);
  const addingKind = () => {
    const a = adding();
    return a ? info().kinds.find((k) => k.kind === a.kind) : undefined;
  };

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const isDefault = (name: string) => info().defaultAccount === name;

  return (
    <div class="space-y-4">
      <div class="divide-y divide-border rounded border border-border">
        <AccountRow
          name={DEFAULT_ACCOUNT}
          detail={`built-in: the daemon's own ${info().displayName} login or environment`}
          isDefault={isDefault(DEFAULT_ACCOUNT)}
          busy={busy()}
          onSetDefault={() => run(`default:${DEFAULT_ACCOUNT}`, () => setDefaultAccount(backend, DEFAULT_ACCOUNT))}
        />
        <For each={info().accounts}>
          {(a) => (
            <AccountRow
              name={a.name}
              detail={accountDetail(a)}
              isDefault={isDefault(a.name)}
              busy={busy()}
              confirming={confirmRemove() === a.name}
              onSetDefault={() => run(`default:${a.name}`, () => setDefaultAccount(backend, a.name))}
              onRemove={() => {
                if (confirmRemove() !== a.name) {
                  setConfirmRemove(a.name);
                  return;
                }
                setConfirmRemove(null);
                void run(`remove:${a.name}`, () => removeAccount(backend, a.name));
              }}
              onCancelRemove={() => setConfirmRemove(null)}
            />
          )}
        </For>
      </div>

      <Show when={error()}>
        <div role="alert" class="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error()}
        </div>
      </Show>

      {/* Not keyed: a list refetch (a reconnect) replaces the descriptor
          object, and must not rebuild a half-filled form. */}
      <Show
        when={addingKind()}
        fallback={
          <div class="flex flex-wrap gap-2">
            <For each={info().kinds}>
              {(k) => (
                <>
                  {/* A sign-in is only offered where the daemon brokers one for this backend. */}
                  <Show when={k.login && loginBackend()}>
                    <button type="button" class={button} onClick={() => setAdding({ kind: k.kind, via: "login" })}>
                      + Sign in: {k.label}
                    </button>
                  </Show>
                  <Show when={kindTakesInput(k)}>
                    <button type="button" class={button} onClick={() => setAdding({ kind: k.kind, via: "form" })}>
                      + {k.label}
                      {k.login ? " (paste token)" : ""}
                    </button>
                  </Show>
                </>
              )}
            </For>
          </div>
        }
      >
        {(kind) => (
          <div class="rounded border border-border bg-bg/40 p-3">
            <Show
              when={adding()?.via === "login" && loginBackend()}
              fallback={<AccountForm backend={props.backend} kind={kind()} onDone={() => setAdding(null)} />}
            >
              {(lb) => <AccountSignIn backend={lb()} displayName={info().displayName} kind={kind()} onDone={() => setAdding(null)} />}
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
};

const AccountRow: Component<{
  name: string;
  detail: string;
  isDefault: boolean;
  busy: string | null;
  confirming?: boolean;
  onSetDefault: () => void;
  onRemove?: () => void;
  onCancelRemove?: () => void;
}> = (props) => (
  <div class="flex items-center gap-3 px-3 py-2">
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-2">
        <span class="font-mono text-sm text-fg">{props.name}</span>
        <Show when={props.isDefault}>
          <span class="rounded border border-accent/50 bg-accent/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-accent">
            default
          </span>
        </Show>
      </div>
      <div class="truncate text-[11px] text-fg-faint" title={props.detail}>
        {props.detail}
      </div>
    </div>
    <Show when={!props.isDefault}>
      <button type="button" class={button} disabled={props.busy !== null} onClick={() => props.onSetDefault()}>
        Make default
      </button>
    </Show>
    <Show when={props.onRemove}>
      <Show
        when={props.confirming && !props.isDefault}
        fallback={
          // The daemon refuses removing the default: the sessions following it
          // would have no account to fall back to.
          <button
            type="button"
            class={button}
            disabled={props.busy !== null || props.isDefault}
            title={props.isDefault ? "This is the default — set another default first" : undefined}
            onClick={() => props.onRemove?.()}
          >
            Remove
          </button>
        }
      >
        <span class="text-[11px] text-danger">Sessions on it stop until switched.</span>
        <button
          type="button"
          class="rounded border border-danger/60 bg-danger/10 px-2.5 py-1 text-[12px] text-danger"
          onClick={() => props.onRemove?.()}
        >
          Remove
        </button>
        <button type="button" class={button} onClick={() => props.onCancelRemove?.()}>
          Keep
        </button>
      </Show>
    </Show>
  </div>
);

/** The base-URL select's "type my own" entry. */
const CUSTOM_URL = "__custom__";

/** Add an account of one kind, with exactly the fields its descriptor names. */
const AccountForm: Component<{ backend: string; kind: AccountKindInfo; onDone: () => void }> = (props) => {
  // The descriptor is fixed for the life of the form (it is keyed on the kind).
  // eslint-disable-next-line solid/reactivity
  const k = props.kind;
  const presets = k.baseUrl?.presets ?? [];
  const [name, setName] = createSignal("");
  const [token, setToken] = createSignal("");
  const [preset, setPreset] = createSignal(presets[0]?.value ?? CUSTOM_URL);
  const [customUrl, setCustomUrl] = createSignal("");
  const [headers, setHeaders] = createSignal<Array<{ name: string; value: string }>>([]);
  const [keys, setKeys] = createSignal<Array<{ name: string; value: string }>>([]);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [replace, setReplace] = createSignal(false);

  const baseUrl = () => (preset() === CUSTOM_URL ? customUrl().trim() : preset());
  const namedHeaders = () => headers().filter((h) => h.name.trim());
  const namedKeys = () => keys().filter((v) => v.name);

  const problem = () => {
    const n = newAccountNameProblem(props.backend, name().trim(), replace());
    if (n) return n;
    if (k.token?.required && !token().trim()) return `${k.token.label} is required`;
    if (k.baseUrl?.required && !baseUrl()) return `${k.baseUrl.label} is required`;
    if (namedKeys().some((v) => !v.value.trim())) return `every ${k.env?.label ? "setting" : "key"} needs a value`;
    // The daemon refuses a header with no value rather than send it blank.
    if (namedHeaders().some((h) => !h.value.trim())) return "every header needs a value";
    // A value typed into a nameless row would be dropped without a word.
    if (headers().some((h) => !h.name.trim() && h.value.trim())) return "a header value needs a name";
    // HTTP header names are case-insensitive: two of them would be one header.
    const lower = namedHeaders().map((h) => h.name.trim().toLowerCase());
    if (new Set(lower).size !== lower.length) return "a header is listed twice";
    // A kind with no single required field (an endpoint's key-and/or-headers,
    // pi's key set) still has to carry something.
    if (!token().trim() && namedHeaders().length === 0 && namedKeys().length === 0) {
      return k.env ? "add at least one key" : "enter a key or a header";
    }
    return null;
  };

  const submit = async (ev: Event) => {
    ev.preventDefault();
    if (problem() || busy()) return;
    setBusy(true);
    setError(null);
    try {
      const hs: Record<string, string> = {};
      for (const h of namedHeaders()) hs[h.name.trim()] = h.value.trim();
      const env: Record<string, string> = {};
      for (const v of namedKeys()) env[v.name] = v.value.trim();
      await saveAccount({
        backend: props.backend,
        name: name().trim(),
        kind: k.kind,
        ...(k.token && token().trim() ? { token: token().trim() } : {}),
        ...(k.baseUrl && baseUrl() ? { baseUrl: baseUrl() } : {}),
        ...(k.headers ? { headers: hs } : {}),
        ...(k.env && Object.keys(env).length > 0 ? { env } : {}),
        replace: replace(),
      });
      setToken("");
      props.onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="space-y-3" onSubmit={submit}>
      <div class="text-[13px] font-medium text-fg">{k.label}</div>
      <Show when={k.hint}>
        <p class="text-[11px] text-fg-faint">{k.hint}</p>
      </Show>
      <label class="block space-y-1">
        <span class={label}>Name</span>
        <input
          class={input}
          value={name()}
          onInput={(e) => {
            setName(e.currentTarget.value);
            setReplace(false);
          }}
          placeholder="company-max"
          autocomplete="off"
        />
      </label>
      <ReplaceAccountConfirm backend={props.backend} name={name().trim()} checked={replace()} onChange={setReplace} />
      <Show when={k.baseUrl}>
        {(spec) => (
          <div class="space-y-1">
            <span class={label}>{spec().label}</span>
            <Show when={presets.length > 0}>
              <select class={input} value={preset()} onChange={(e) => setPreset(e.currentTarget.value)} aria-label={spec().label}>
                <For each={presets}>{(p) => <option value={p.value}>{p.label}</option>}</For>
                <option value={CUSTOM_URL}>Custom URL…</option>
              </select>
            </Show>
            <Show when={preset() === CUSTOM_URL}>
              <input
                class={input}
                value={customUrl()}
                onInput={(e) => setCustomUrl(e.currentTarget.value)}
                placeholder="https://gateway.example.com"
                aria-label={presets.length > 0 ? "Custom URL" : spec().label}
              />
            </Show>
          </div>
        )}
      </Show>
      <Show when={k.token}>
        {(spec) => (
          <label class="block space-y-1">
            <span class={label}>
              {spec().label}
              {spec().required ? "" : " (optional)"}
            </span>
            <input
              class={input}
              type="password"
              value={token()}
              onInput={(e) => setToken(e.currentTarget.value)}
              autocomplete="new-password"
            />
          </label>
        )}
      </Show>
      <Show when={k.headers}>
        <HeadersEditor rows={headers()} onChange={setHeaders} />
      </Show>
      <Show when={k.env}>
        {(spec) => (
          <KeysEditor
            names={spec().names}
            title={spec().label ?? "Keys"}
            optional={spec().required === false}
            secret={spec().secret}
            rows={keys()}
            onChange={setKeys}
          />
        )}
      </Show>
      <Show when={error()}>
        <div role="alert" class="text-[12px] text-danger">
          {error()}
        </div>
      </Show>
      <div class="flex items-center gap-2">
        <button type="submit" class={button} disabled={!!problem() || busy()} title={problem() ?? ""}>
          {busy() ? "Saving…" : "Add account"}
        </button>
        <button type="button" class={button} onClick={() => props.onDone()}>
          Cancel
        </button>
        <Show when={problem() && name()}>
          <span class="text-[11px] text-fg-faint">{problem()}</span>
        </Show>
      </div>
    </form>
  );
};

/**
 * Variables from the kind's allowlist (pi's provider keys, a Bedrock account's
 * settings): a name picked from the list — each at most once — and a value,
 * masked unless the kind says that name isn't a secret.
 */
const KeysEditor: Component<{
  names: string[];
  title: string;
  optional: boolean;
  /** Names whose values are secrets; absent = all of them. */
  secret: string[] | undefined;
  rows: Array<{ name: string; value: string }>;
  onChange: (rows: Array<{ name: string; value: string }>) => void;
}> = (props) => {
  const unused = () => props.names.filter((n) => !props.rows.some((r) => r.name === n));
  const isSecret = (name: string) => !props.secret || props.secret.includes(name);
  const noun = () => (props.title === "Keys" ? "key" : "setting");
  return (
    <div class="space-y-1">
      <span class={label}>
        {props.title}
        {props.optional ? " (optional)" : ""}
      </span>
      {/* <Index>, as in HeadersEditor: a keystroke must not rebuild the row and drop focus. */}
      <Index each={props.rows}>
        {(row, i) => (
          <div class="flex gap-2">
            <select
              class={input}
              aria-label={props.title === "Keys" ? "Key variable" : "Setting"}
              value={row().name}
              onChange={(e) => props.onChange(props.rows.map((r, j) => (j === i ? { ...r, name: e.currentTarget.value } : r)))}
            >
              {/* This row's own name, plus those no other row has taken. */}
              <For each={props.names.filter((n) => n === row().name || !props.rows.some((r) => r.name === n))}>
                {(n) => <option value={n}>{n}</option>}
              </For>
            </select>
            <input
              class={input}
              type={isSecret(row().name) ? "password" : "text"}
              placeholder="value"
              aria-label={`${row().name} value`}
              autocomplete={isSecret(row().name) ? "new-password" : "off"}
              spellcheck={false}
              value={row().value}
              onInput={(e) => props.onChange(props.rows.map((r, j) => (j === i ? { ...r, value: e.currentTarget.value } : r)))}
            />
            <button type="button" class={button} onClick={() => props.onChange(props.rows.filter((_, j) => j !== i))} aria-label={`Remove ${noun()}`}>
              ✕
            </button>
          </div>
        )}
      </Index>
      <button
        type="button"
        class={button}
        disabled={unused().length === 0}
        onClick={() => props.onChange([...props.rows, { name: unused()[0] ?? "", value: "" }])}
      >
        + {noun() === "key" ? "Key" : "Setting"}
      </button>
    </div>
  );
};
