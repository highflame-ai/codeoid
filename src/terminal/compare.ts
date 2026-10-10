/**
 * Side-by-side comparisons (#357) for the CLI and the TUI: the shared
 * grammar and the plain-text rendering, so `codeoid compare …` and
 * `/compare …` read and print the same way.
 */

import type { CompareState, CompareTargetSpec } from "../protocol/types.js";

/**
 * "claude,codex:gpt-5.5,pi" → targets. A model follows the first ":" (model
 * ids may contain more). 2–4 targets, like the daemon accepts.
 */
export function parseTargets(spec: string): CompareTargetSpec[] | { error: string } {
  const targets: CompareTargetSpec[] = [];
  for (const raw of spec.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    const colon = part.indexOf(":");
    const providerId = (colon === -1 ? part : part.slice(0, colon)).trim();
    const model = colon === -1 ? "" : part.slice(colon + 1).trim();
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(providerId)) return { error: `not a backend id: ${JSON.stringify(providerId)}` };
    targets.push({ providerId, ...(model ? { model } : {}) });
  }
  if (targets.length < 2 || targets.length > 4) return { error: "compare takes 2 to 4 backends, e.g. claude,codex" };
  return targets;
}

/** What `/compare` was asked to do. */
export type CompareCommand =
  | { kind: "start"; targets: CompareTargetSpec[]; at?: number; prompt: string }
  | { kind: "show" }
  | { kind: "keep"; branch: number; discardOthers: boolean };

const USAGE = "Usage: /compare <backend,backend[:model],…> [--at N] <prompt>  ·  /compare  ·  /compare keep <branch> [--discard-others]";

/**
 * `/compare` arguments (whitespace-split): no args shows this session's latest
 * comparison; `keep <branch>` keeps one; otherwise targets, flags, then the
 * prompt (everything after the flags, joined back with spaces).
 */
export function parseCompareArgs(args: readonly string[]): CompareCommand | { error: string } {
  const a = args.map((x) => x.trim()).filter(Boolean);
  if (a.length === 0) return { kind: "show" };
  if (a[0] === "keep") {
    const branch = Number(a[1]);
    const rest = a.slice(2);
    if (!Number.isInteger(branch) || branch < 1 || rest.some((x) => x !== "--discard-others")) return { error: USAGE };
    return { kind: "keep", branch, discardOthers: rest.includes("--discard-others") };
  }
  const targets = parseTargets(a[0]!);
  if ("error" in targets) return { error: `${targets.error}. ${USAGE}` };
  let at: number | undefined;
  let i = 1;
  if (a[i] === "--at") {
    const n = Number(a[i + 1]);
    if (!Number.isInteger(n) || n < 1) return { error: USAGE };
    at = n;
    i += 2;
  }
  const prompt = a.slice(i).join(" ");
  if (!prompt) return { error: USAGE };
  return { kind: "start", targets, ...(at !== undefined ? { at } : {}), prompt };
}

/** True once every branch is done — or waiting on someone to approve something. */
export function compareSettled(c: CompareState): boolean {
  return c.targets.every((t) => t.done || t.status === "waiting_approval");
}

/** Branches waiting for an approval, numbered as shown. */
export function awaitingApproval(c: CompareState): Array<{ branch: number; sessionId: string; name: string }> {
  return c.targets.flatMap((t, i) =>
    !t.done && t.status === "waiting_approval" && t.sessionId
      ? [{ branch: i + 1, sessionId: t.sessionId, name: `${t.providerId}${t.model ? `:${t.model}` : ""}` }]
      : [],
  );
}

const statusText = (t: CompareState["targets"][number]): string =>
  t.status === "gone"
    ? "discarded"
    : t.status === "failed"
      ? "failed to start"
      : !t.done && t.status === "waiting_approval"
        ? "needs your approval"
        : !t.done
          ? "working…"
          : t.status;

const money = (usd: number | undefined) => (usd === undefined ? "" : `$${usd.toFixed(usd < 1 ? 4 : 2)}`);
const secs = (ms: number | undefined) => (ms === undefined ? "" : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`);

/** A plain-text account of a comparison, branches numbered for `keep`. */
export function formatCompare(c: CompareState, opts: { replyChars?: number } = {}): string {
  const replyChars = opts.replyChars ?? 600;
  const lines: string[] = [`Comparison ${c.compareId.slice(0, 8)} — "${oneLine(c.prompt, 80)}"`];
  c.targets.forEach((t, i) => {
    const name = `${t.providerId}${t.model ? `:${t.model}` : ""}`;
    const kept = t.sessionId && t.sessionId === c.keptSessionId ? "  ★ kept" : "";
    const stats = [secs(t.durationMs), money(t.costUsd)].filter(Boolean).join(", ");
    lines.push("");
    lines.push(`[${i + 1}] ${name} — ${statusText(t)}${stats ? ` (${stats})` : ""}${kept}`);
    if (t.error) lines.push(`    error: ${oneLine(t.error, 300)}`);
    if (t.files) {
      const f = t.files;
      lines.push(`    files: ${f.changed} changed, +${f.insertions} −${f.deletions}${f.paths.length ? ` — ${f.paths.slice(0, 6).join(", ")}${f.paths.length > 6 ? ", …" : ""}` : ""}`);
    }
    if (t.reply) lines.push(...indent(t.reply.length > replyChars ? `${t.reply.slice(0, replyChars - 1)}…` : t.reply));
    if (t.sessionId) lines.push(`    session: ${t.sessionId}`);
  });
  return lines.join("\n");
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function indent(text: string): string[] {
  return text.split("\n").map((l) => `    │ ${l}`);
}
