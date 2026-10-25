/**
 * One evidence record (docs/loop-engineering-design.md §7): what a check ran,
 * on which tree, and what it found — the daemon's record, not a model's
 * account. `EvidenceView` is presentational; `EvidenceLink` fetches on demand.
 */

import { Component, Show, createEffect, createSignal, on } from "solid-js";

import type { EvidenceWire } from "../protocol/types";
import { fetchEvidence } from "../state/evidence";

const RESULT_CLASS: Record<EvidenceWire["result"], string> = {
  pass: "border-success/40 bg-success/10 text-success",
  fail: "border-danger/40 bg-danger/10 text-danger",
  inconclusive: "border-warn/40 bg-warn/10 text-warn",
  error: "border-warn/40 bg-warn/10 text-warn",
  cancelled: "border-border bg-bg/40 text-fg-muted",
};

/** Last `n` lines of an excerpt — the end of a test run is where its summary is. */
function tailLines(text: string, n: number): string {
  const lines = text.trimEnd().split("\n");
  return lines.length > n ? lines.slice(-n).join("\n") : lines.join("\n");
}

export const EvidenceView: Component<{ evidence: EvidenceWire }> = (props) => {
  const e = () => props.evidence;
  const seconds = () => ((Date.parse(e().endedAt) - Date.parse(e().startedAt)) / 1000).toFixed(1);
  const output = () => tailLines([e().stderrExcerpt, e().stdoutExcerpt].filter((s) => s.trim()).join("\n"), 30);
  return (
    <div class="mt-2 rounded border border-border bg-bg/40 px-2 py-2 text-[11px]" data-testid="evidence-view">
      <div class="flex flex-wrap items-center gap-2">
        <span class={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${RESULT_CLASS[e().result]}`}>
          {e().result}
        </span>
        <span class="text-fg">{e().reason}</span>
        <span class="text-fg-faint">· {seconds()}s</span>
      </div>
      <div class="mt-1 font-mono text-fg-muted">{e().command}</div>
      <div class="mt-1 text-fg-faint">
        {e().candidateDigest ? `tree ${e().candidateDigest!.slice(0, 12)}` : "no pinned tree"} · {e().isolation} ·{" "}
        <span class="font-mono">{e().id}</span>
      </div>
      <Show when={output()}>
        <pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-bg px-2 py-1 font-mono text-[11px] text-fg-muted">
          {output()}
        </pre>
      </Show>
    </div>
  );
};

/** "N checks" with the latest record shown on request. */
export const EvidenceLink: Component<{ ids: string[] }> = (props) => {
  const [record, setRecord] = createSignal<EvidenceWire | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const latest = () => props.ids[props.ids.length - 1]!;
  // A newer check replaces what is shown: drop the old record so the next
  // open fetches the latest.
  createEffect(on(latest, () => setRecord(null), { defer: true }));
  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setRecord(await fetchEvidence(latest()));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div class="mt-2">
      <button
        type="button"
        class="text-[11px] text-accent underline-offset-2 hover:underline disabled:opacity-50"
        disabled={loading()}
        onClick={() => (record() ? setRecord(null) : void load())}
      >
        {record() ? "Hide check output" : `Show check output (${props.ids.length} check${props.ids.length === 1 ? "" : "s"})`}
      </button>
      <Show when={error()}>
        <p class="mt-1 text-[11px] text-danger">{error()}</p>
      </Show>
      <Show when={record()}>{(r) => <EvidenceView evidence={r()} />}</Show>
    </div>
  );
};
