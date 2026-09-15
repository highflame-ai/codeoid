/**
 * The findings loop — review → fix → re-review, in the engine, with the
 * capability roles left exactly as they are.
 *
 * The problem it solves: a read-only review phase (reviewer / adversary /
 * verifier) produces findings but the pipeline has no backward edge, so the
 * only exits were "human approves anyway" or "human re-runs the reviewer, who
 * still cannot edit". Every workaround on offer — giving reviewers write
 * access, or hand-authoring `fix` phases in every pack — either destroys the
 * reason the review rounds exist (findings get reported, not silently patched)
 * or pushes engine work into pack prose.
 *
 * What the engine does instead, for a phase that declares `findings:`:
 *
 *   1. Runs the phase under its own (read-only) role with a FINDINGS CONTRACT
 *      appended: the report must end with a fenced ```findings block — a JSON
 *      array of {id, severity, title, …}. Empty array = clean. A missing or
 *      malformed block is a format failure: one bounded re-run with the exact
 *      gap as feedback, then the phase's onFail policy.
 *   2. If any finding is BLOCKING (severity in `blocking`, default critical +
 *      high) and fix rounds remain, runs a FIX LEG on the same bound session
 *      under `fixWith.role` (a pack role that MUST be write-capable — checked
 *      at load). The fixer gets the findings and a DISPOSITION CONTRACT: every
 *      blocking finding needs a disposition — fixed, not_a_finding, declined,
 *      deferred — and the last three need a reason. The engine validates this
 *      itself (no bare deferrals, no silently dropped ids); a gap is fed back
 *      for one bounded retry, then the phase halts with the ledger.
 *   3. Optionally evaluates `fixWith.gate` (e.g. `tests_pass`) on the fix leg —
 *      a fixer that broke the build halts the phase with that reason.
 *   4. RE-RUNS THE REVIEWER with the ledger: verify each fixed finding is really
 *      fixed and didn't regress, accept or re-raise the rejected ones, report
 *      anything new, and list what remains OPEN. The latest round's block IS
 *      the open set — the reviewer decides convergence, the engine enforces it.
 *   5. Loops until no blocking finding is open or `maxRounds` fix legs have
 *      run. Then the normal exit boundary: a `review`-kind gate now has a real
 *      verdict (no open blocking findings), and the human halt carries the
 *      ledger either way.
 *
 * Every leg is one engine step (one model turn), so the loop persists between
 * legs and survives a daemon restart mid-round. Everything here is pure: the
 * contracts, the parsers, the validators, the ledger renderer.
 */

import { z } from "zod";
import type { ResolvedFrom } from "./binding";

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const DISPOSITIONS = ["fixed", "not_a_finding", "declined", "deferred"] as const;
export type DispositionKind = (typeof DISPOSITIONS)[number];

/** Default blocking severities when a pack doesn't say. */
export const DEFAULT_BLOCKING: readonly Severity[] = ["critical", "high"];
/** Default fix rounds when a pack doesn't say. */
export const DEFAULT_MAX_ROUNDS = 2;
/** Bounded re-runs on a malformed / missing block before onFail applies. */
export const FORMAT_RETRIES = 1;

/** The built-in prompt skill the fix leg drives (registered by builtin.ts). */
export const FINDINGS_FIX_SKILL_ID = "findings-fix";

const idField = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "finding ids are short alphanumeric tokens (e.g. F1)");

export const findingSchema = z.object({
  id: idField,
  severity: z.enum(SEVERITIES),
  title: z.string().min(1).max(300),
  location: z.string().max(300).optional(),
  detail: z.string().max(4000).optional(),
  confidence: z.enum(["confirmed", "plausible"]).optional(),
});
export type Finding = z.infer<typeof findingSchema>;

export const dispositionSchema = z.object({
  id: idField,
  disposition: z.enum(DISPOSITIONS),
  reason: z.string().max(2000).optional(),
  evidence: z.string().max(2000).optional(),
});
export type Disposition = z.infer<typeof dispositionSchema>;

/** The loop's declaration on a phase (PhaseDef.findings) — compiled from the
 *  pack manifest by loadPack, with defaults applied. */
export interface FindingsSpec {
  /** The write-capable pack role the fix legs run under, plus its persisted
   *  model binding (resolved at create like a phase's own —
   *  docs/role-model-binding.md §3). */
  fixWith: { role: string; provider?: string; model?: string; resolvedFrom?: ResolvedFrom };
  /** Severities that must be resolved before the phase can pass. */
  blocking: Severity[];
  /** Maximum fix legs. 0 = report only, never fix (a pure audit phase). */
  maxRounds: number;
  /** Optional gate evaluated after each fix leg (e.g. `tests_pass`). */
  gate?: string;
}

export interface FindingsRound {
  /** What the reviewer reported this round — for round ≥ 2, the OPEN set. */
  findings: Finding[];
  /** The fix leg's answer to this round's findings (absent when none was needed). */
  dispositions?: Disposition[];
  fixSummary?: string;
}

/** Persisted per phase (PipelinePhase.findings) so each leg is one engine step
 *  and the loop resumes exactly where it stopped. */
export interface FindingsLoopState {
  rounds: FindingsRound[];
  /** What the next engine step runs for this phase. */
  next: "review" | "fix";
  /** Fix legs completed (the `maxRounds` budget). */
  fixLegs: number;
  /** Repair retries consumed by the leg currently pending (a malformed block,
   *  a failing fix gate), and the engine's note to feed back to it. */
  formatRetries: number;
  formatFeedback?: string;
  /** True between a committed fix leg and the review leg that verifies it —
   *  that review is the loop's own leg, not the phase acting again (so the
   *  phase's entry gate is not re-evaluated for it). */
  rereview?: boolean;
}

export function newLoopState(): FindingsLoopState {
  return { rounds: [], next: "review", fixLegs: 0, formatRetries: 0 };
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/** The LAST fenced block tagged `tag` in `text` (a model may quote an earlier
 *  draft; the final one is authoritative). */
export function extractLastBlock(text: string, tag: string): string | undefined {
  const re = new RegExp(`\`\`\`${tag}[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n[ \\t]*\`\`\``, "g");
  let last: string | undefined;
  for (const m of text.matchAll(re)) last = m[1];
  return last;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

function parseBlock<T>(text: string, tag: string, schema: z.ZodType<T>): Parsed<T> {
  const raw = extractLastBlock(text, tag);
  if (raw === undefined) return { ok: false, reason: `no \`\`\`${tag} block found at the end of the report` };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: `the \`\`\`${tag} block is not valid JSON (${e instanceof Error ? e.message : String(e)})` };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.length ? ` at ${first.path.join(".")}` : "";
    return { ok: false, reason: `the \`\`\`${tag} block does not match the schema${path}: ${first?.message ?? "schema error"}` };
  }
  return { ok: true, value: parsed.data };
}

export function parseFindings(text: string): Parsed<Finding[]> {
  const p = parseBlock(text, "findings", z.array(findingSchema).max(200));
  if (!p.ok) return p;
  const seen = new Set<string>();
  for (const f of p.value) {
    if (seen.has(f.id)) return { ok: false, reason: `duplicate finding id "${f.id}"` };
    seen.add(f.id);
  }
  return p;
}

export function parseDispositions(text: string): Parsed<Disposition[]> {
  return parseBlock(text, "dispositions", z.array(dispositionSchema).max(200));
}

// ── Validation ───────────────────────────────────────────────────────────────

export const isBlocking = (f: Finding, blocking: readonly Severity[]): boolean => blocking.includes(f.severity);

export const blockingOf = (findings: readonly Finding[], blocking: readonly Severity[]): Finding[] =>
  findings.filter((f) => isBlocking(f, blocking));

/** The open set: the latest review round's findings (empty before any round). */
export function openFindings(loop: FindingsLoopState | undefined): Finding[] {
  const last = loop?.rounds[loop.rounds.length - 1];
  return last ? last.findings : [];
}

export const openBlocking = (loop: FindingsLoopState | undefined, spec: FindingsSpec): Finding[] =>
  blockingOf(openFindings(loop), spec.blocking);

/**
 * The disposition contract, enforced by the engine rather than trusted from
 * prose: every blocking finding has exactly one disposition; a disposition
 * names a finding that exists; anything other than `fixed` carries a reason.
 * A `deferred` without a reason is the "bare deferral" every review loop
 * eventually rots into — refused here.
 */
export function validateDispositions(
  findings: readonly Finding[],
  blocking: readonly Severity[],
  dispositions: readonly Disposition[],
): { ok: true } | { ok: false; reason: string } {
  const ids = new Set(findings.map((f) => f.id));
  const seen = new Map<string, Disposition>();
  const problems: string[] = [];
  for (const d of dispositions) {
    if (!ids.has(d.id)) problems.push(`"${d.id}" is not a reported finding`);
    if (seen.has(d.id)) problems.push(`"${d.id}" has more than one disposition`);
    seen.set(d.id, d);
    if (d.disposition !== "fixed" && !(d.reason ?? "").trim()) {
      problems.push(`"${d.id}" is ${d.disposition} without a reason`);
    }
  }
  for (const f of blockingOf(findings, blocking)) {
    if (!seen.has(f.id)) problems.push(`blocking finding "${f.id}" (${f.severity}) has no disposition`);
  }
  return problems.length === 0 ? { ok: true } : { ok: false, reason: problems.join("; ") };
}

// ── Rendering ────────────────────────────────────────────────────────────────

const dispositionLabel: Record<DispositionKind, string> = {
  fixed: "FIXED",
  not_a_finding: "NOT A FINDING",
  declined: "DECLINED",
  deferred: "DEFERRED",
};

/** A markdown ledger of every round: findings, dispositions, what is open. */
export function renderLedger(loop: FindingsLoopState, spec: FindingsSpec): string {
  const out: string[] = [];
  loop.rounds.forEach((round, i) => {
    out.push(`### Review round ${i + 1}${i === loop.rounds.length - 1 ? " (open set)" : ""}`);
    if (round.findings.length === 0) {
      out.push("_no findings_");
    } else {
      out.push("| id | severity | finding | location | disposition |", "|---|---|---|---|---|");
      for (const f of round.findings) {
        const d = round.dispositions?.find((x) => x.id === f.id);
        const disp = d
          ? `${dispositionLabel[d.disposition]}${d.reason ? ` — ${d.reason}` : ""}${d.evidence ? ` (${d.evidence})` : ""}`
          : isBlocking(f, spec.blocking)
            ? "open"
            : "open (non-blocking)";
        out.push(`| ${f.id} | ${f.severity} | ${cell(f.title)} | ${cell(f.location ?? "")} | ${cell(disp)} |`);
      }
    }
    out.push("");
  });
  return out.join("\n").trimEnd();
}

const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

/** One line for halt reasons and status rails. "fixed" counts distinct finding
 *  ids a fix leg marked fixed that are NOT still open — a finding fixed, re-
 *  raised, and fixed again is one resolved finding, not two. */
export function summarizeLoop(loop: FindingsLoopState, spec: FindingsSpec): string {
  const open = openFindings(loop);
  const blocking = blockingOf(open, spec.blocking);
  const openIds = new Set(open.map((f) => f.id));
  const fixedIds = new Set<string>();
  for (const r of loop.rounds) {
    for (const d of r.dispositions ?? []) if (d.disposition === "fixed" && !openIds.has(d.id)) fixedIds.add(d.id);
  }
  const rounds = `${loop.rounds.length} review round${loop.rounds.length === 1 ? "" : "s"}, ${loop.fixLegs} fix leg${loop.fixLegs === 1 ? "" : "s"}`;
  return `${open.length} finding${open.length === 1 ? "" : "s"} open (${blocking.length} blocking), ${fixedIds.size} fixed — ${rounds}`;
}

// ── Prompt contracts ─────────────────────────────────────────────────────────

const FINDINGS_BLOCK_SPEC = [
  "```findings",
  "[",
  '  { "id": "F1", "severity": "critical|high|medium|low", "title": "one-line claim",',
  '    "location": "path/file.ext:line (optional)", "detail": "trigger → wrong outcome (optional)",',
  '    "confidence": "confirmed|plausible (optional)" }',
  "]",
  "```",
].join("\n");

/** Appended to the FIRST review leg of a findings phase. */
export function findingsContract(spec: FindingsSpec): string {
  return [
    "",
    "---",
    "## Reporting findings (engine contract)",
    "This phase's findings drive an automated fix-and-re-review loop, so they must be",
    "machine-readable. End your report with exactly one fenced block tagged `findings`",
    "containing a JSON array — an EMPTY array `[]` when the work is clean:",
    "",
    FINDINGS_BLOCK_SPEC,
    "",
    `Severities ${spec.blocking.join(" and ")} BLOCK the phase: a writer will be asked to resolve each`,
    "one and you will review the result. Report only what you verified or can point at;",
    "keep ids short and stable (F1, F2, …). Put the block last, before the completion marker.",
  ].join("\n");
}

/** Appended to every review leg after a fix leg — the reviewer sees the ledger
 *  and decides what remains open. */
export function rereviewContract(loop: FindingsLoopState, spec: FindingsSpec): string {
  // Say what actually happened: a fix leg answered the last round, or none ran
  // (audit-only, budget spent, a leg that never committed) and the findings stand.
  const last = loop.rounds[loop.rounds.length - 1];
  const intro = last?.dispositions
    ? "A writer responded to your previous findings. The ledger so far:"
    : "No fix leg ran since your previous findings — they stand as reported. The ledger so far:";
  return [
    "",
    "---",
    `## Review round ${loop.rounds.length + 1} (engine contract)`,
    intro,
    "",
    renderLedger(loop, spec),
    "",
    "Now re-review the current state of the work:",
    "- For each finding marked FIXED: verify the fix is real and did not regress anything",
    "  you previously validated. Re-raise it (same id) if it is not actually fixed.",
    "- For each NOT A FINDING / DECLINED: accept the reason, or re-raise it with the same id",
    "  and say why the reason does not hold.",
    "- DEFERRED findings stay open unless the work now resolves them.",
    "- Report anything NEW with a new id.",
    "",
    "End with the `findings` block listing ONLY what remains open now (carry unresolved ids",
    "forward; omit what is resolved). An empty array `[]` means the work is clean:",
    "",
    FINDINGS_BLOCK_SPEC,
  ].join("\n");
}

/** The fix leg's whole brief (appended to the built-in `findings-fix` skill).
 *  `humanNotes` are the phase's revise notes — a "fix F3 this way" is for the
 *  writer, so the fixer sees them too. */
export function fixContract(
  round: FindingsRound,
  spec: FindingsSpec,
  formatFeedback?: string,
  humanNotes?: readonly string[],
): string {
  const blocking = blockingOf(round.findings, spec.blocking);
  const rows = round.findings.map(
    (f) =>
      `- **${f.id}** [${f.severity}${isBlocking(f, spec.blocking) ? ", blocking" : ""}] ${f.title}${f.location ? ` — ${f.location}` : ""}${f.detail ? `\n  ${f.detail}` : ""}`,
  );
  return [
    "",
    "---",
    "## Findings to resolve (engine contract)",
    `The reviewer reported ${round.findings.length} finding${round.findings.length === 1 ? "" : "s"}, ${blocking.length} blocking:`,
    "",
    ...rows,
    "",
    "For EVERY blocking finding (and any other you choose to act on), decide and act:",
    "- `fixed` — you changed the code; say what changed and what you ran to prove it.",
    "- `not_a_finding` — the claim is wrong; give the reason (the reviewer will check it).",
    "- `declined` — real but deliberately not done; give the reason.",
    "- `deferred` — real and tracked elsewhere; give where and why. Never a bare deferral.",
    "",
    "Run the project's tests before finishing. Do not silently drop a finding, and do not",
    "widen the change beyond what the findings need. End your report with exactly one",
    "fenced block tagged `dispositions`, listing every blocking finding id:",
    "",
    "```dispositions",
    "[",
    '  { "id": "F1", "disposition": "fixed|not_a_finding|declined|deferred",',
    '    "reason": "required unless fixed", "evidence": "what changed / what ran (optional)" }',
    "]",
    "```",
    ...(humanNotes && humanNotes.length > 0
      ? ["", "## Notes from the human (revise)", ...humanNotes.map((n, i) => `${i + 1}. ${n}`)]
      : []),
    ...(formatFeedback
      ? [
          "",
          `Engine note on your previous attempt: ${formatFeedback}`,
          "Address it and report again; the block must be last, before the completion marker.",
        ]
      : []),
  ].join("\n");
}
