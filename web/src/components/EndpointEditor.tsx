/**
 * Add or edit one OpenAI-compatible endpoint. Secrets are write-only: when
 * editing, the stored key and headers are kept unless the user chooses to
 * replace or remove them (they are never shown, so a replacement is re-typed).
 */

import { type Component, For, Show, createSignal } from "solid-js";

import type { EndpointFlavor, EndpointInfo, EndpointModel, EndpointsTestResultMsg } from "../protocol/types";
import { endpointNameProblem, saveEndpoint, testEndpoint } from "../state/endpoints";
import { HeadersEditor } from "./ClaudeAccountsPanel";

const label = "text-[11px] font-medium uppercase tracking-wider text-fg-faint";
const input =
  "w-full rounded border border-border bg-bg px-3 py-1.5 font-mono text-sm text-fg focus:border-accent focus:outline-none";
const button =
  "rounded border border-border bg-bg px-2.5 py-1 text-[12px] text-fg-muted transition hover:border-accent/40 hover:text-fg disabled:opacity-50";

interface ModelRow {
  id: string;
  name: string;
  contextWindow: string;
  maxTokens: string;
}

/** `128k` / `131072` → tokens; "" → undefined; anything else → NaN (shown as a problem). */
export function tokensOf(s: string): number | undefined {
  const t = s.trim();
  if (!t) return undefined;
  const m = /^(\d+)(k?)$/i.exec(t);
  return m ? Number(m[1]) * (m[2] ? 1000 : 1) : Number.NaN;
}

function rowsOf(models: EndpointModel[]): ModelRow[] {
  return models.map((m) => ({
    id: m.id,
    name: m.name ?? "",
    contextWindow: m.contextWindow ? String(m.contextWindow) : "",
    maxTokens: m.maxTokens ? String(m.maxTokens) : "",
  }));
}

export const EndpointEditor: Component<{ existing?: EndpointInfo; onDone: () => void }> = (props) => {
  // A snapshot: the form edits a copy, and the panel mounts a fresh editor
  // per edit, so later changes to the stored endpoint must not reset it.
  // eslint-disable-next-line solid/reactivity
  const ex = props.existing;
  const [name, setName] = createSignal(ex?.name ?? "");
  const [displayName, setDisplayName] = createSignal(ex && ex.displayName !== ex.name ? ex.displayName : "");
  const [baseUrl, setBaseUrl] = createSignal(ex?.baseUrl ?? "");
  const [flavor, setFlavor] = createSignal<EndpointFlavor>(ex?.flavor ?? "openai");
  // Key: "keep" (edit, stored), "set" (type a new one), "clear" (remove), "none" (new, keyless).
  const [keyMode, setKeyMode] = createSignal<"keep" | "set" | "clear" | "none">(ex?.hasApiKey ? "keep" : "none");
  const [apiKey, setApiKey] = createSignal("");
  const [replaceHeaders, setReplaceHeaders] = createSignal(!ex);
  const [headers, setHeaders] = createSignal<Array<{ name: string; value: string }>>([]);
  const [models, setModels] = createSignal<ModelRow[]>(rowsOf(ex?.models ?? []));
  const [defaultModel, setDefaultModel] = createSignal(ex?.defaultModel ?? "");
  const [contextWindow, setContextWindow] = createSignal(ex?.contextWindow ? String(ex.contextWindow) : "");
  const [mcpMode, setMcpMode] = createSignal<"all" | "none" | "list">(
    !ex ? "all" : ex.mcpServers === "all" ? "all" : ex.mcpServers.length ? "list" : "none",
  );
  const [mcpList, setMcpList] = createSignal(ex && ex.mcpServers !== "all" ? ex.mcpServers.join(", ") : "");
  const [streamUsage, setStreamUsage] = createSignal(ex?.streamUsage ?? true);
  const [strict, setStrict] = createSignal<boolean | undefined>(ex?.strictToolSchemas);
  const [maxTokensField, setMaxTokensField] = createSignal(ex?.maxTokensField ?? "max_tokens");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [test, setTest] = createSignal<EndpointsTestResultMsg | "running" | undefined>();

  const problem = (): string | null => {
    const n = endpointNameProblem(name().trim());
    if (n) return n;
    if (!baseUrl().trim()) return "a base URL is required";
    if (keyMode() === "set" && !apiKey().trim()) return "enter the key, or choose to keep / remove it";
    if (Number.isNaN(tokensOf(contextWindow()) ?? 0)) return "context window: a number of tokens, like 32768 or 32k";
    for (const m of models()) {
      if (!m.id.trim()) return "every model row needs an id";
      if (Number.isNaN(tokensOf(m.contextWindow) ?? 0) || Number.isNaN(tokensOf(m.maxTokens) ?? 0)) {
        return `model ${m.id}: token counts must be numbers, like 128k`;
      }
    }
    return null;
  };

  const headerMap = () => {
    const out: Record<string, string> = {};
    for (const h of headers()) if (h.name.trim()) out[h.name.trim()] = h.value;
    return out;
  };

  /** What the key / headers fields mean for a request: absent = keep stored. */
  const secretFields = () => ({
    ...(keyMode() === "set" ? { apiKey: apiKey().trim() } : keyMode() === "clear" ? { apiKey: null } : {}),
    ...(replaceHeaders() ? { headers: headerMap() } : {}),
  });

  const runTest = async () => {
    setTest("running");
    setTest(
      await testEndpoint({
        ...(ex ? { name: ex.name } : {}),
        baseUrl: baseUrl().trim(),
        flavor: flavor(),
        ...secretFields(),
      }),
    );
  };

  const fillModelsFromTest = () => {
    const t = test();
    if (!t || t === "running" || !t.ok || !t.models) return;
    const have = new Set(models().map((m) => m.id));
    setModels([...models(), ...t.models.filter((id) => !have.has(id)).map((id) => ({ id, name: "", contextWindow: "", maxTokens: "" }))]);
  };

  const save = async (ev: Event) => {
    ev.preventDefault();
    if (problem() || busy()) return;
    setBusy(true);
    setError(null);
    try {
      const ctx = tokensOf(contextWindow());
      await saveEndpoint({
        name: name().trim(),
        displayName: displayName().trim(),
        baseUrl: baseUrl().trim(),
        flavor: flavor(),
        ...secretFields(),
        models: models().map((m) => {
          const c = tokensOf(m.contextWindow);
          const x = tokensOf(m.maxTokens);
          return {
            id: m.id.trim(),
            ...(m.name.trim() ? { name: m.name.trim() } : {}),
            ...(c ? { contextWindow: c } : {}),
            ...(x ? { maxTokens: x } : {}),
          };
        }),
        ...(defaultModel().trim() ? { defaultModel: defaultModel().trim() } : {}),
        ...(ctx ? { contextWindow: ctx } : {}),
        mcpServers:
          mcpMode() === "all"
            ? "all"
            : mcpMode() === "none"
              ? []
              : mcpList()
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
        streamUsage: streamUsage(),
        ...(strict() !== undefined ? { strictToolSchemas: strict() } : {}),
        maxTokensField: maxTokensField(),
      });
      setApiKey("");
      props.onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="space-y-4 rounded border border-border bg-bg/40 p-4" onSubmit={save}>
      <div class="text-[13px] font-medium text-fg">{ex ? `Edit ${ex.displayName}` : "New endpoint"}</div>

      <div class="grid grid-cols-2 gap-3">
        <label class="block space-y-1">
          <span class={label}>Name (backend oai:{name() || "…"})</span>
          <input class={input} value={name()} disabled={!!ex} onInput={(e) => setName(e.currentTarget.value)} placeholder="gpu-box" />
        </label>
        <label class="block space-y-1">
          <span class={label}>Display name</span>
          <input class={input} value={displayName()} onInput={(e) => setDisplayName(e.currentTarget.value)} placeholder="GPU box (vLLM)" />
        </label>
      </div>

      <label class="block space-y-1">
        <span class={label}>Base URL</span>
        <input class={input} value={baseUrl()} onInput={(e) => setBaseUrl(e.currentTarget.value)} placeholder="http://localhost:11434/v1" />
        <span class="text-[11px] text-fg-faint">Usually ends in /v1. https for public hosts; http is allowed for localhost and private networks.</span>
      </label>

      <label class="block space-y-1">
        <span class={label}>Server type</span>
        <select class={input} value={flavor()} onChange={(e) => setFlavor(e.currentTarget.value as EndpointFlavor)}>
          <option value="openai">OpenAI-compatible (vLLM, Ollama, LM Studio, OpenRouter, gateways…)</option>
          <option value="llamacpp">llama.cpp llama-server (live context window, strict tool schemas)</option>
        </select>
      </label>

      <div class="space-y-1">
        <span class={label}>API key</span>
        <div class="flex flex-wrap items-center gap-3 text-[12px] text-fg-muted">
          <Show when={ex?.hasApiKey}>
            <label class="flex items-center gap-1">
              <input type="radio" checked={keyMode() === "keep"} onChange={() => setKeyMode("keep")} /> keep stored key
            </label>
            <label class="flex items-center gap-1">
              <input type="radio" checked={keyMode() === "clear"} onChange={() => setKeyMode("clear")} /> remove it
            </label>
          </Show>
          <Show when={!ex?.hasApiKey}>
            <label class="flex items-center gap-1">
              <input type="radio" checked={keyMode() === "none"} onChange={() => setKeyMode("none")} /> no key
            </label>
          </Show>
          <label class="flex items-center gap-1">
            <input type="radio" checked={keyMode() === "set"} onChange={() => setKeyMode("set")} /> {ex?.hasApiKey ? "replace" : "set a key"}
          </label>
        </div>
        <Show when={keyMode() === "set"}>
          <input class={input} type="password" value={apiKey()} onInput={(e) => setApiKey(e.currentTarget.value)} autocomplete="off" placeholder="sk-…" />
        </Show>
      </div>

      <Show
        when={replaceHeaders()}
        fallback={
          <div class="flex items-center gap-2 text-[12px] text-fg-muted">
            <span>Headers: {ex?.headerNames.length ? ex.headerNames.join(", ") : "none"}</span>
            <button type="button" class={button} onClick={() => setReplaceHeaders(true)}>
              {ex?.headerNames.length ? "Replace headers" : "Add headers"}
            </button>
          </div>
        }
      >
        <HeadersEditor
          rows={headers()}
          onChange={setHeaders}
          hint={ex?.headerNames.length ? "Replaces all stored headers — re-enter any you want to keep." : undefined}
        />
      </Show>

      <div class="space-y-1">
        <div class="flex items-center justify-between">
          <span class={label}>Models (none = whatever the server lists)</span>
          <div class="flex gap-2">
            <Show when={test() && test() !== "running" && (test() as EndpointsTestResultMsg).ok}>
              <button type="button" class={button} onClick={fillModelsFromTest}>
                Add the server's models
              </button>
            </Show>
            <button type="button" class={button} onClick={() => setModels([...models(), { id: "", name: "", contextWindow: "", maxTokens: "" }])}>
              + Model
            </button>
          </div>
        </div>
        <For each={models()}>
          {(m, i) => {
            const patch = (p: Partial<ModelRow>) => setModels(models().map((r, j) => (j === i() ? { ...r, ...p } : r)));
            return (
              <div class="grid grid-cols-[2fr_1.5fr_1fr_1fr_auto] gap-2">
                <input class={input} placeholder="model id" value={m.id} onInput={(e) => patch({ id: e.currentTarget.value })} />
                <input class={input} placeholder="label" value={m.name} onInput={(e) => patch({ name: e.currentTarget.value })} />
                <input class={input} placeholder="context (128k)" value={m.contextWindow} onInput={(e) => patch({ contextWindow: e.currentTarget.value })} />
                <input class={input} placeholder="max output" value={m.maxTokens} onInput={(e) => patch({ maxTokens: e.currentTarget.value })} />
                <button type="button" class={button} aria-label="Remove model" onClick={() => setModels(models().filter((_, j) => j !== i()))}>
                  ✕
                </button>
              </div>
            );
          }}
        </For>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <label class="block space-y-1">
          <span class={label}>Default model</span>
          <input class={input} value={defaultModel()} onInput={(e) => setDefaultModel(e.currentTarget.value)} placeholder="first model" list="endpoint-model-ids" />
          <datalist id="endpoint-model-ids">
            <For each={models()}>{(m) => <option value={m.id} />}</For>
          </datalist>
        </label>
        <label class="block space-y-1">
          <span class={label}>Context window (default)</span>
          <input class={input} value={contextWindow()} onInput={(e) => setContextWindow(e.currentTarget.value)} placeholder="e.g. 32k" />
        </label>
      </div>

      <div class="space-y-1">
        <span class={label}>External MCP servers offered</span>
        <div class="flex flex-wrap items-center gap-3 text-[12px] text-fg-muted">
          <label class="flex items-center gap-1">
            <input type="radio" checked={mcpMode() === "all"} onChange={() => setMcpMode("all")} /> all
          </label>
          <label class="flex items-center gap-1">
            <input type="radio" checked={mcpMode() === "none"} onChange={() => setMcpMode("none")} /> none
          </label>
          <label class="flex items-center gap-1">
            <input type="radio" checked={mcpMode() === "list"} onChange={() => setMcpMode("list")} /> only
          </label>
          <Show when={mcpMode() === "list"}>
            <input class={`${input} max-w-xs`} value={mcpList()} onInput={(e) => setMcpList(e.currentTarget.value)} placeholder="github, slack" />
          </Show>
        </div>
        <span class="text-[11px] text-fg-faint">Tool definitions ride in every prompt; a small local context is better off with few or none.</span>
      </div>

      <details class="text-[12px] text-fg-muted">
        <summary class="cursor-pointer select-none">Compatibility</summary>
        <div class="mt-2 space-y-2">
          <label class="flex items-center gap-2">
            <input type="checkbox" checked={streamUsage()} onChange={(e) => setStreamUsage(e.currentTarget.checked)} />
            Ask for token usage while streaming (turn off if the server rejects stream_options)
          </label>
          <label class="flex items-center gap-2">
            <input
              type="checkbox"
              checked={strict() ?? flavor() === "llamacpp"}
              onChange={(e) => setStrict(e.currentTarget.checked)}
            />
            Strict tool schemas (for servers that compile tools into a grammar)
          </label>
          <label class="flex items-center gap-2">
            Output-token field
            <select class={`${input} max-w-[16rem]`} value={maxTokensField()} onChange={(e) => setMaxTokensField(e.currentTarget.value as "max_tokens" | "max_completion_tokens")}>
              <option value="max_tokens">max_tokens</option>
              <option value="max_completion_tokens">max_completion_tokens</option>
            </select>
          </label>
        </div>
      </details>

      <TestOutcome test={test()} />
      <Show when={error()}>
        <div role="alert" class="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error()}
        </div>
      </Show>

      <div class="flex items-center gap-2">
        <button type="submit" class={button} disabled={!!problem() || busy()} title={problem() ?? ""}>
          {busy() ? "Saving…" : ex ? "Save" : "Add endpoint"}
        </button>
        <button type="button" class={button} disabled={!baseUrl().trim() || test() === "running"} onClick={() => void runTest()}>
          {test() === "running" ? "Testing…" : "Test connection"}
        </button>
        <button type="button" class={button} onClick={() => props.onDone()}>
          Cancel
        </button>
        <Show when={problem() && (name() || baseUrl())}>
          <span class="text-[11px] text-fg-faint">{problem()}</span>
        </Show>
      </div>
    </form>
  );
};

/** One line on how a test went. */
export const TestOutcome: Component<{ test?: EndpointsTestResultMsg | "running" }> = (props) => (
  <Show when={props.test && props.test !== "running" ? (props.test as EndpointsTestResultMsg) : undefined}>
    {(t) => (
      <div class={`text-[11px] ${t().ok ? "text-success" : "text-danger"}`} role={t().ok ? undefined : "alert"}>
        {t().ok
          ? `✓ answered in ${t().latencyMs ?? "?"} ms — ${t().models?.length ?? 0} models${t().contextWindow ? `, context ${t().contextWindow} tokens` : ""}${
              t().models?.length ? `: ${t().models!.slice(0, 6).join(", ")}${t().models!.length > 6 ? ", …" : ""}` : ""
            }`
          : `✗ ${t().error ?? "no answer"}`}
      </div>
    )}
  </Show>
);
