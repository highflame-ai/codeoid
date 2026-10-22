/**
 * Settings → OpenAI endpoints: any number of OpenAI-compatible servers (local
 * llama.cpp / vLLM / Ollama / LM Studio, OpenRouter, gateways), each a backend
 * `oai:<name>` in every provider picker (protocol: endpoints.ts).
 *
 * Keys and header values are write-only: an edit keeps the stored ones unless
 * replaced. "Test" asks the daemon to list the server's models, with the
 * form's values as typed (stored secrets fill what the form leaves out).
 */

import { type Component, For, Show, createSignal, onMount } from "solid-js";

import type { EndpointInfo, EndpointsTestResultMsg } from "../protocol/types";
import { endpointsState, fetchEndpoints, removeEndpoint, testEndpoint } from "../state/endpoints";
import { EndpointEditor, TestOutcome } from "./EndpointEditor";

const button =
  "rounded border border-border bg-bg px-2.5 py-1 text-[12px] text-fg-muted transition hover:border-accent/40 hover:text-fg disabled:opacity-50";

export const EndpointsPanel: Component = () => {
  // null = list; "" = a new endpoint; a name = editing that one.
  const [editing, setEditing] = createSignal<string | null>(null);
  const [confirmRemove, setConfirmRemove] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [tests, setTests] = createSignal<Record<string, EndpointsTestResultMsg | "running">>({});

  onMount(() => void fetchEndpoints());

  const runTest = async (name: string) => {
    setTests((t) => ({ ...t, [name]: "running" }));
    const res = await testEndpoint({ name });
    setTests((t) => ({ ...t, [name]: res }));
  };

  const remove = async (name: string) => {
    if (confirmRemove() !== name) {
      setConfirmRemove(name);
      return;
    }
    setConfirmRemove(null);
    setError(null);
    try {
      await removeEndpoint(name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const current = () => endpointsState().endpoints.find((e) => e.name === editing());

  return (
    <div class="space-y-4">
      <div>
        <h3 class="text-[15px] font-semibold text-fg">OpenAI-compatible endpoints</h3>
        <p class="mt-1 text-[12px] text-fg-muted">
          Local models (llama.cpp, vLLM, Ollama, LM Studio) and hosted ones (OpenRouter, a company gateway). Each appears as its own
          backend — pick it when creating a session or switch a session to it. Changes apply without a restart; running sessions pick
          them up on their next turn.
        </p>
      </div>

      <Show when={endpointsState().error}>
        <div class="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{endpointsState().error}</div>
      </Show>

      <Show
        when={editing() === null}
        fallback={<EndpointEditor existing={current()} onDone={() => setEditing(null)} />}
      >
        <Show
          when={endpointsState().endpoints.length > 0}
          fallback={
            <Show when={endpointsState().loaded}>
              <div class="rounded border border-dashed border-border px-3 py-4 text-center text-[12px] text-fg-faint">
                No endpoints yet.
              </div>
            </Show>
          }
        >
          <div class="divide-y divide-border rounded border border-border">
            <For each={endpointsState().endpoints}>
              {(e) => (
                <EndpointRow
                  endpoint={e}
                  test={tests()[e.name]}
                  confirming={confirmRemove() === e.name}
                  onEdit={() => setEditing(e.name)}
                  onTest={() => void runTest(e.name)}
                  onRemove={() => void remove(e.name)}
                  onCancelRemove={() => setConfirmRemove(null)}
                />
              )}
            </For>
          </div>
        </Show>
        <Show when={error()}>
          <div role="alert" class="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error()}
          </div>
        </Show>
        <button type="button" class={button} onClick={() => setEditing("")}>
          + Add endpoint
        </button>
      </Show>
    </div>
  );
};

const EndpointRow: Component<{
  endpoint: EndpointInfo;
  test?: EndpointsTestResultMsg | "running";
  confirming: boolean;
  onEdit: () => void;
  onTest: () => void;
  onRemove: () => void;
  onCancelRemove: () => void;
}> = (props) => {
  const e = () => props.endpoint;
  const models = () =>
    e().models.length ? `${e().models.length} model${e().models.length === 1 ? "" : "s"}` : "models from the server";
  return (
    <div class="space-y-1 px-3 py-2">
      <div class="flex items-center gap-3">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="text-sm text-fg">{e().displayName}</span>
            <span class="font-mono text-[11px] text-fg-faint">{e().providerId}</span>
            <span class="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-fg-faint">
              {e().flavor}
            </span>
          </div>
          <div class="truncate font-mono text-[11px] text-fg-faint" title={e().baseUrl}>
            {e().baseUrl} · key {e().hasApiKey ? "set" : "none"} · {models()}
            {e().headerNames.length ? ` · headers: ${e().headerNames.join(", ")}` : ""}
          </div>
        </div>
        <button type="button" class={button} disabled={props.test === "running"} onClick={() => props.onTest()}>
          {props.test === "running" ? "Testing…" : "Test"}
        </button>
        <button type="button" class={button} onClick={() => props.onEdit()}>
          Edit
        </button>
        <Show
          when={props.confirming}
          fallback={
            <button type="button" class={button} onClick={() => props.onRemove()}>
              Remove
            </button>
          }
        >
          <button type="button" class="rounded border border-danger/60 bg-danger/10 px-2.5 py-1 text-[12px] text-danger" onClick={() => props.onRemove()}>
            Remove
          </button>
          <button type="button" class={button} onClick={() => props.onCancelRemove()}>
            Keep
          </button>
        </Show>
      </div>
      <TestOutcome test={props.test} />
    </div>
  );
};
