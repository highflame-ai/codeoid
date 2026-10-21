/**
 * Settings → Claude accounts: the daemon's Claude credentials (protocol:
 * claude-accounts.ts). List, set the default, remove, add a gateway or a
 * token, and sign a Pro/Max subscription in as a named account.
 *
 * Tokens are typed into password fields, sent once, and cleared; the daemon
 * never sends one back.
 */

import { type Component, For, Index, Show, createSignal, onMount } from "solid-js";

import {
  addGatewayAccount,
  addTokenAccount,
  claudeAccountsState,
  DEFAULT_ACCOUNT,
  fetchClaudeAccounts,
  newAccountNameProblem,
  removeClaudeAccount,
  setDefaultClaudeAccount,
} from "../state/claude-accounts";
import { AccountSignIn } from "./AccountSignIn";

const label = "text-[11px] font-medium uppercase tracking-wider text-fg-faint";
const input =
  "w-full rounded border border-border bg-bg px-3 py-1.5 font-mono text-sm text-fg focus:border-accent focus:outline-none";
const button =
  "rounded border border-border bg-bg px-2.5 py-1 text-[12px] text-fg-muted transition hover:border-accent/40 hover:text-fg disabled:opacity-50";

type AddKind = "subscription" | "gateway" | "token" | "api-key";

export const ClaudeAccountsPanel: Component = () => {
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [adding, setAdding] = createSignal<AddKind | null>(null);
  const [confirmRemove, setConfirmRemove] = createSignal<string | null>(null);

  onMount(() => void fetchClaudeAccounts(true));

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

  const isDefault = (name: string) => claudeAccountsState().defaultAccount === name;

  return (
    <div class="space-y-4">
      <div>
        <h3 class="text-[15px] font-semibold text-fg">Claude accounts</h3>
        <p class="mt-1 text-[12px] text-fg-muted">
          Several Claude credentials on this daemon: subscriptions, gateway tokens, API keys. Each session runs on one (switch it from
          the session bar); sessions that haven't chosen follow the default. Choosing or changing accounts needs settings:write.
        </p>
      </div>

      <Show when={claudeAccountsState().error && !claudeAccountsState().accounts.length}>
        <div class="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{claudeAccountsState().error}</div>
      </Show>

      <div class="divide-y divide-border rounded border border-border">
        <AccountRow
          name={DEFAULT_ACCOUNT}
          detail="the daemon's own login (claude login, or CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY)"
          isDefault={isDefault(DEFAULT_ACCOUNT)}
          busy={busy()}
          onSetDefault={() => run(`default:${DEFAULT_ACCOUNT}`, () => setDefaultClaudeAccount(DEFAULT_ACCOUNT))}
        />
        <For each={claudeAccountsState().accounts}>
          {(a) => (
            <AccountRow
              name={a.name}
              detail={
                a.kind === "gateway"
                  ? `gateway · ${a.baseUrl ?? ""}${a.headerNames?.length ? ` · headers: ${a.headerNames.join(", ")}` : ""}`
                  : a.kind === "api-key"
                    ? "Anthropic API key"
                    : "Pro/Max subscription"
              }
              isDefault={isDefault(a.name)}
              busy={busy()}
              confirming={confirmRemove() === a.name}
              onSetDefault={() => run(`default:${a.name}`, () => setDefaultClaudeAccount(a.name))}
              onRemove={() => {
                if (confirmRemove() !== a.name) {
                  setConfirmRemove(a.name);
                  return;
                }
                setConfirmRemove(null);
                void run(`remove:${a.name}`, () => removeClaudeAccount(a.name));
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

      <Show
        when={adding()}
        fallback={
          <div class="flex flex-wrap gap-2">
            <button type="button" class={button} onClick={() => setAdding("subscription")}>
              + Sign in a subscription
            </button>
            <button type="button" class={button} onClick={() => setAdding("gateway")}>
              + Gateway
            </button>
            <button type="button" class={button} onClick={() => setAdding("token")}>
              + Subscription token
            </button>
            <button type="button" class={button} onClick={() => setAdding("api-key")}>
              + API key
            </button>
          </div>
        }
      >
        {(kind) => (
          <div class="rounded border border-border bg-bg/40 p-3">
            <Show when={kind() === "subscription"} fallback={<AddAccountForm kind={kind() as Exclude<AddKind, "subscription">} onDone={() => setAdding(null)} />}>
              <AccountSignIn onDone={() => setAdding(null)} />
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
        when={props.confirming}
        fallback={
          <button type="button" class={button} disabled={props.busy !== null} onClick={() => props.onRemove?.()}>
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

/** Add a gateway, a subscription token, or an API key. */
const AddAccountForm: Component<{ kind: "gateway" | "token" | "api-key"; onDone: () => void }> = (props) => {
  const [name, setName] = createSignal("");
  const [token, setToken] = createSignal("");
  const [baseUrl, setBaseUrl] = createSignal("");
  const [headers, setHeaders] = createSignal<Array<{ name: string; value: string }>>([]);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const problem = () => {
    const n = newAccountNameProblem(name().trim());
    if (n) return n;
    if (!token().trim()) return "a token is required";
    if (props.kind === "gateway" && !baseUrl().trim()) return "a base URL is required";
    return null;
  };

  const submit = async (ev: Event) => {
    ev.preventDefault();
    if (problem() || busy()) return;
    setBusy(true);
    setError(null);
    try {
      if (props.kind === "gateway") {
        const hs: Record<string, string> = {};
        for (const h of headers()) if (h.name.trim()) hs[h.name.trim()] = h.value;
        await addGatewayAccount({ name: name().trim(), token: token().trim(), baseUrl: baseUrl().trim(), headers: hs });
      } else {
        await addTokenAccount({ name: name().trim(), token: token().trim(), kind: props.kind === "api-key" ? "api-key" : "subscription" });
      }
      setToken("");
      props.onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const title = () =>
    props.kind === "gateway" ? "Anthropic-compatible gateway" : props.kind === "api-key" ? "Anthropic API key" : "Subscription token";

  return (
    <form class="space-y-3" onSubmit={submit}>
      <div class="text-[13px] font-medium text-fg">{title()}</div>
      <label class="block space-y-1">
        <span class={label}>Name</span>
        <input class={input} value={name()} onInput={(e) => setName(e.currentTarget.value)} placeholder="company-max" autocomplete="off" />
      </label>
      <Show when={props.kind === "gateway"}>
        <label class="block space-y-1">
          <span class={label}>Base URL</span>
          <input class={input} value={baseUrl()} onInput={(e) => setBaseUrl(e.currentTarget.value)} placeholder="https://gateway.example.com" />
        </label>
      </Show>
      <label class="block space-y-1">
        <span class={label}>{props.kind === "token" ? "Token (sk-ant-oat01-…, from claude setup-token)" : props.kind === "api-key" ? "API key" : "Gateway token"}</span>
        <input class={input} type="password" value={token()} onInput={(e) => setToken(e.currentTarget.value)} autocomplete="off" />
      </label>
      <Show when={props.kind === "gateway"}>
        <HeadersEditor rows={headers()} onChange={setHeaders} />
      </Show>
      <Show when={error()}>
        <div role="alert" class="text-[12px] text-danger">{error()}</div>
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

/** Name/value rows for extra request headers; values are secret (password fields). */
export const HeadersEditor: Component<{
  rows: Array<{ name: string; value: string }>;
  onChange: (rows: Array<{ name: string; value: string }>) => void;
  hint?: string;
}> = (props) => (
  <div class="space-y-1">
    <span class={label}>Extra headers</span>
    {/* <Index>: each keystroke replaces the row object; <For> would rebuild the row and drop focus. */}
    <Index each={props.rows}>
      {(row, i) => (
        <div class="flex gap-2">
          <input
            class={input}
            placeholder="x-workspace"
            value={row().name}
            onInput={(e) => props.onChange(props.rows.map((r, j) => (j === i ? { ...r, name: e.currentTarget.value } : r)))}
          />
          <input
            class={input}
            type="password"
            placeholder="value"
            value={row().value}
            onInput={(e) => props.onChange(props.rows.map((r, j) => (j === i ? { ...r, value: e.currentTarget.value } : r)))}
          />
          <button type="button" class={button} onClick={() => props.onChange(props.rows.filter((_, j) => j !== i))} aria-label="Remove header">
            ✕
          </button>
        </div>
      )}
    </Index>
    <button type="button" class={button} onClick={() => props.onChange([...props.rows, { name: "", value: "" }])}>
      + Header
    </button>
    <Show when={props.hint}>
      <p class="text-[11px] text-fg-faint">{props.hint}</p>
    </Show>
  </div>
);