/**
 * Settings → Workstreams (docs/workstreams-design.md): named lines of work —
 * which folders are whose, and what their sessions get. Edits go to the daemon
 * whole and are validated there (one rule, one message); the list it answers
 * with replaces this one.
 */

import { type Component, For, Show, createSignal, onMount } from "solid-js";

import { EMPTY_FORM, fromForm, toForm, type WorkstreamForm } from "../lib/workstream-form";
import type { WorkstreamResolution, WorkstreamSummary } from "../protocol/types";
import {
  deleteWorkstream,
  fetchWorkstreams,
  resolveWorkstream,
  saveWorkstream,
  saveWorkstreamSettings,
  workstreamsState,
} from "../state/workstreams";
import { chipColor } from "./WorkstreamChip";

const label = "text-[11px] font-medium uppercase tracking-wider text-fg-faint";
const input =
  "w-full rounded border border-border bg-bg px-3 py-1.5 font-mono text-sm text-fg focus:border-accent focus:outline-none";
const button =
  "rounded border border-border bg-bg px-2.5 py-1 text-[12px] text-fg-muted transition hover:border-accent/40 hover:text-fg disabled:opacity-50";

export const WorkstreamsPanel: Component = () => {
  onMount(() => void fetchWorkstreams(true));
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  /** The workstream being edited: its id, or "" for a new one; null = none. */
  const [editing, setEditing] = createSignal<string | null>(null);
  const [confirmRemove, setConfirmRemove] = createSignal<string | null>(null);

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

  const list = () => workstreamsState().workstreams;
  const homes = () => list().filter((w) => !w.abstract);

  return (
    <div class="space-y-4">
      <div>
        <h3 class="text-[15px] font-semibold text-fg">Workstreams</h3>
        <p class="mt-1 text-[12px] text-fg-muted">
          Named lines of work — a company, a client, a project, a personal setup. Each session belongs to one, by its folder or by
          choice, and keeps it. With isolation on, a session reaches only its workstream's MCP servers and credentials.
        </p>
      </div>

      <Show when={workstreamsState().error && !workstreamsState().loaded}>
        <div class="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{workstreamsState().error}</div>
      </Show>
      <Show when={error()}>
        <div class="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">
          {error()}
        </div>
      </Show>

      <div class="space-y-2 rounded border border-border p-3">
        <label class="flex items-start gap-2 text-[13px] text-fg">
          <input
            type="checkbox"
            class="mt-0.5"
            checked={workstreamsState().isolateGlobalServers}
            disabled={busy() !== null}
            onChange={(e) => void run("isolate", () => saveWorkstreamSettings({ isolateGlobalServers: e.currentTarget.checked }))}
          />
          <span>
            Isolate MCP servers
            <span class="block text-[12px] text-fg-muted">
              A session gets only its workstream's servers; with none, built-ins only. Off: every session keeps every server.
            </span>
          </span>
        </label>
        <div class="flex items-center gap-2">
          <span class={label}>Default</span>
          <select
            aria-label="Default workstream"
            class="rounded border border-border bg-bg px-2 py-1 text-[12px] text-fg"
            value={workstreamsState().default ?? ""}
            disabled={busy() !== null}
            onChange={(e) => void run("default", () => saveWorkstreamSettings({ default: e.currentTarget.value || null }))}
          >
            <option value="">none — a folder nothing matches has no workstream</option>
            <For each={homes()}>{(w) => <option value={w.id}>{w.name}</option>}</For>
          </select>
        </div>
      </div>

      <div class="divide-y divide-border rounded border border-border">
        <Show when={list().length === 0 && workstreamsState().loaded}>
          <div class="px-3 py-3 text-[12px] text-fg-muted">
            None yet. Add one below, or run <code class="font-mono">codeoid workstream import</code> for a proposal from your repositories.
          </div>
        </Show>
        <For each={list()}>
          {(w) => (
            <div class="px-3 py-2">
              <div class="flex flex-wrap items-center gap-2">
                <Show when={chipColor(w.color)}>
                  {(c) => <span class="inline-block h-2 w-2 rounded-full" style={{ "background-color": c() }} aria-hidden="true" />}
                </Show>
                <span class="text-[13px] font-medium text-fg">{w.name}</span>
                <span class="font-mono text-[11px] text-fg-faint">{w.id}</span>
                <Badge>{w.abstract ? "base" : w.claim}</Badge>
                <Badge>share: {w.share}</Badge>
                <Show when={workstreamsState().default === w.id}>
                  <Badge accent>default</Badge>
                </Show>
                <span class="ml-auto flex gap-1.5">
                  <button type="button" class={button} onClick={() => setEditing(w.id)} disabled={busy() !== null}>
                    Edit
                  </button>
                  <Show
                    when={confirmRemove() === w.id}
                    fallback={
                      <button type="button" class={button} onClick={() => setConfirmRemove(w.id)} disabled={busy() !== null}>
                        Remove
                      </button>
                    }
                  >
                    <button
                      type="button"
                      class={`${button} border-danger/50 text-danger`}
                      onClick={() => void run(`rm:${w.id}`, () => deleteWorkstream(w.id)).then(() => setConfirmRemove(null))}
                    >
                      Remove {w.id}? Its sessions keep it, shown orphaned
                    </button>
                  </Show>
                </span>
              </div>
              <div class="mt-1 text-[12px] text-fg-muted">
                {[...w.match.paths, ...w.match.remotes.map((r) => `remote ${r}`)].join(" · ") || (w.abstract ? "a base for others to extend" : "no rules — chosen only")}
                <Show when={w.servers.length > 0}> · servers: {w.servers.map((s) => s.server).join(", ")}</Show>
                <Show when={w.env.length > 0}> · env: {w.env.join(", ")}</Show>
              </div>
              <Show when={editing() === w.id}>
                <Editor existing={w} onDone={() => setEditing(null)} run={run} busy={busy()} />
              </Show>
            </div>
          )}
        </For>
      </div>

      <Show
        when={editing() === ""}
        fallback={
          <button type="button" class={button} onClick={() => setEditing("")} disabled={busy() !== null}>
            Add workstream
          </button>
        }
      >
        <div class="rounded border border-border p-3">
          <Editor onDone={() => setEditing(null)} run={run} busy={busy()} />
        </div>
      </Show>

      <FolderCheck />
    </div>
  );
};

const Badge: Component<{ children: unknown; accent?: boolean }> = (props) => (
  <span
    class={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${
      props.accent ? "border-accent/60 bg-accent/10 text-accent" : "border-border bg-bg text-fg-faint"
    }`}
  >
    {props.children as string}
  </span>
);

/** Edit one workstream (or add one): the fields people set; the rest of the item is kept as configured. */
const Editor: Component<{
  existing?: WorkstreamSummary;
  onDone: () => void;
  run: (key: string, fn: () => Promise<void>) => Promise<boolean>;
  busy: string | null;
}> = (props) => {
  // eslint-disable-next-line solid/reactivity -- seeded once; the editor is remounted per workstream
  const [form, setForm] = createSignal<WorkstreamForm>(props.existing ? toForm(props.existing.config) : EMPTY_FORM);
  const field = <K extends keyof WorkstreamForm>(k: K) => ({
    value: form()[k] as string,
    onInput: (e: InputEvent & { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => setForm({ ...form(), [k]: e.currentTarget.value }),
  });
  const save = async () => {
    const ok = await props.run("save", () => saveWorkstream(fromForm(form(), props.existing?.config)));
    if (ok) props.onDone();
  };
  const row = "grid gap-1";
  return (
    <form
      class="mt-3 grid gap-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      aria-label={props.existing ? `Edit ${props.existing.id}` : "New workstream"}
    >
      <label class={row}>
        <span class={label}>Id</span>
        <input class={input} {...field("id")} readOnly={!!props.existing} required placeholder="acme" />
      </label>
      <label class={row}>
        <span class={label}>Name</span>
        <input class={input} {...field("name")} placeholder="Acme Corp" />
      </label>
      <label class={row}>
        <span class={label}>Folders (one glob per line)</span>
        <textarea class={input} rows={3} {...field("paths")} placeholder="~/Workspace/acme-*" disabled={form().abstract} />
      </label>
      <label class={row}>
        <span class={label}>Repositories (one per line)</span>
        <textarea class={input} rows={3} {...field("remotes")} placeholder="github.com/acme/*" disabled={form().abstract} />
      </label>
      <fieldset class={row}>
        <legend class={label}>Folders it matches</legend>
        <label class="flex items-center gap-2 text-[12px] text-fg">
          <input type="radio" name="claim" checked={form().claim === "suggest"} onChange={() => setForm({ ...form(), claim: "suggest" })} />
          suggest — the folder pre-selects it
        </label>
        <label class="flex items-center gap-2 text-[12px] text-fg">
          <input type="radio" name="claim" checked={form().claim === "exclusive"} onChange={() => setForm({ ...form(), claim: "exclusive" })} />
          exclusive — another workstream there needs a confirmed override
        </label>
        <label class="flex items-center gap-2 text-[12px] text-fg">
          <input type="checkbox" checked={form().allowOverride} onChange={(e) => setForm({ ...form(), allowOverride: e.currentTarget.checked })} />
          allow overrides
        </label>
      </fieldset>
      <label class={row}>
        <span class={label}>Other workstreams may read it</span>
        <select class={input} value={form().share} onChange={(e) => setForm({ ...form(), share: e.currentTarget.value as WorkstreamForm["share"] })}>
          <option value="open">open — freely</option>
          <option value="ask">ask — with your approval</option>
          <option value="closed">closed — never</option>
        </select>
      </label>
      <label class={row}>
        <span class={label}>MCP servers (server, or server = credential)</span>
        <textarea class={input} rows={3} {...field("servers")} placeholder={"github = gh-acme\nweb-search"} />
      </label>
      <label class={row}>
        <span class={label}>Env (NAME = credential)</span>
        <textarea class={input} rows={3} {...field("env")} placeholder="GH_TOKEN = gh-acme" />
      </label>
      <label class={row}>
        <span class={label}>Git name</span>
        <input class={input} {...field("gitName")} placeholder="Acme Bot" />
      </label>
      <label class={row}>
        <span class={label}>Git email</span>
        <input class={input} {...field("gitEmail")} placeholder="bot@acme.example" />
      </label>
      <label class={row}>
        <span class={label}>Extends (comma-separated)</span>
        <input class={input} {...field("extends")} placeholder="base-personal" />
      </label>
      <label class={row}>
        <span class={label}>Color</span>
        <input class={input} {...field("color")} placeholder="orange or #f97316" />
      </label>
      <label class="flex items-center gap-2 text-[12px] text-fg sm:col-span-2">
        <input type="checkbox" checked={form().abstract} onChange={(e) => setForm({ ...form(), abstract: e.currentTarget.checked })} />
        a base — no folders or sessions of its own, only for others to extend
      </label>
      <div class="flex gap-2 sm:col-span-2">
        <button type="submit" class={`${button} border-accent/60 text-accent`} disabled={props.busy !== null}>
          {props.busy === "save" ? "Saving…" : "Save"}
        </button>
        <button type="button" class={button} onClick={() => props.onDone()}>
          Cancel
        </button>
      </div>
    </form>
  );
};

/** Which workstream a folder belongs to, and why: what a new session there would get. */
const FolderCheck: Component = () => {
  const [dir, setDir] = createSignal("");
  const [result, setResult] = createSignal<WorkstreamResolution | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const check = async () => {
    setError(null);
    setResult(null);
    try {
      setResult(await resolveWorkstream(dir().trim()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div class="space-y-2 rounded border border-border p-3">
      <span class={label}>Check a folder</span>
      <form
        class="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void check();
        }}
      >
        <input class={input} aria-label="Folder to check" value={dir()} onInput={(e) => setDir(e.currentTarget.value)} placeholder="~/Workspace/acme-api" />
        <button type="submit" class={button} disabled={dir().trim().length === 0}>
          Check
        </button>
      </form>
      <Show when={error()}>
        <div class="text-[12px] text-danger">{error()}</div>
      </Show>
      <Show when={result()}>
        {(r) => (
          <div class="text-[12px] text-fg" data-testid="folder-check-result">
            {r().home
              ? `${r().home} — ${r().source === "matched" ? `matched by ${r().matchedBy}` : r().source === "default" ? "the default" : r().source}`
              : r().ambiguous
                ? `no workstream — ${r().ambiguous?.join(" and ")} both match`
                : "no workstream — no rule matches and no default is set"}
          </div>
        )}
      </Show>
    </div>
  );
};
