/**
 * Deterministic phase-completion probes (docs/pipeline-phase-detection.md).
 *
 * A probe is a `GatePlugin` whose verdict is a deterministic predicate over the
 * workspace — NOT a model self-report and NOT an LLM judge. It is the backend-
 * agnostic "did the deliverable get produced / does it build+test?" check the
 * engine uses as the acceptance truth for a pipeline phase, replacing the
 * fragile `⟦PHASE-COMPLETE⟧` text sentinel as the source of truth.
 *
 * Two classes, distinguished for the pack trust model (parity with the
 * `command` gate — see pack.ts):
 *   - READ-ONLY probes (`file-exists`, `glob-nonempty`, `git-diff-nonempty`)
 *     only inspect the workspace, so they run for any pack, trusted or not.
 *   - EXECUTION probes (`build`, `test`, `lint`, `verify`) run a command in the
 *     workspace. The command is AUTO-DERIVED from the detected ecosystem (never
 *     author-supplied — no injection surface), but it still executes code, so it
 *     runs only for a TRUSTED pack and otherwise fails closed.
 *
 * All probes read `ctx.pipeline.workdir` at evaluate time (like the command
 * gate), so a single registered gate works across runs in different repos.
 */

import { existsSync, readFileSync } from "node:fs";
import { ephemeralCheck } from "../evidence/service";
import type { CheckOutcome } from "../evidence/types";
import type { GateCtx, GatePlugin, GateVerdict } from "./interface";

/** A probe path/glob must stay WITHIN the run's workdir: it is relative and has
 *  no `..` segment. Read-only probes run even for an untrusted pack, so an
 *  unconfined `../../.ssh/id_rsa` would be a host-filesystem existence oracle.
 *  Rejected at load (pack.ts refine) and defended here at evaluate time. */
export function probePathEscapes(p: string): boolean {
  return p.startsWith("/") || p.split(/[/\\]/).includes("..");
}

/** Hard bound on a single execution-probe command (build/test/lint). A test
 *  suite or build that hangs must not wedge the phase forever — on timeout we
 *  kill it and fail the probe. Mirrors the command gate's timeout. */
export const GATE_PROBE_TIMEOUT_MS = 300_000;

/** The probe types a `kind:"probe"` gate can select. `verify` is the composite
 *  "everything the ecosystem supports" (build + test + lint, whichever detected). */
export type ProbeType =
  | "file-exists"
  | "glob-nonempty"
  | "git-diff-nonempty"
  | "build"
  | "test"
  | "lint"
  | "verify";

export const READ_ONLY_PROBES: readonly ProbeType[] = ["file-exists", "glob-nonempty", "git-diff-nonempty"];
export const EXECUTION_PROBES: readonly ProbeType[] = ["build", "test", "lint", "verify"];

/** A probe gate's parsed spec (from `gate.probe` in pack.yaml). */
export interface ProbeSpec {
  type: ProbeType;
  /** Path globs for `file-exists` / `glob-nonempty`. Ignored by other types. */
  paths?: string[];
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Run one probe command through the gate's check runner (recording evidence
 *  when the run has an evidence store), bounded by GATE_PROBE_TIMEOUT_MS. */
async function runProbe(
  ctx: GateCtx,
  id: string,
  label: string,
  cmd: string,
  cwd: string,
): Promise<{ outcome: CheckOutcome; evidenceId?: string }> {
  const run = ctx.runCheck ?? ephemeralCheck;
  const { outcome, record } = await run(
    { id: `${ctx.phase.id}:${id}:${label}`, label, command: cmd, timeoutMs: GATE_PROBE_TIMEOUT_MS, expectTests: label === "test" },
    cwd,
  );
  return { outcome, ...(record ? { evidenceId: record.id } : {}) };
}

/** The diagnostic tail a failed check contributes to its gate's reason — what
 *  the phase's next attempt is shown. stderr gets most of the room, because
 *  test runners report failures there and stdout is often console noise. Both
 *  excerpts are already redacted; the full output is evidence. */
export function diagnosticTail(outcome: CheckOutcome, max = 1_500): string {
  const tail = (s: string, n: number): string => (s.length > n ? `…${s.slice(s.length - n)}` : s);
  const err = outcome.stderrExcerpt.trim();
  const out = outcome.stdoutExcerpt.trim();
  if (!err) return tail(out, max);
  if (!out) return tail(err, max);
  const outRoom = Math.min(out.length, Math.floor(max / 3));
  return `${tail(err, max - outRoom)}\n${tail(out, outRoom)}`;
}

/** Detected build/test/lint commands for a workspace, keyed by the manifest we
 *  found. Empty when no ecosystem is recognized. Auto-derivation is a daemon
 *  capability (reviewed once, centrally) — NOT pack data — so a pack author who
 *  writes `type: test` never supplies a shell string. */
interface Ecosystem {
  build?: string;
  test?: string;
  lint?: string;
}

/** Map a workspace to its ecosystem commands by conventional manifest files.
 *  Deliberately conservative: only well-known, non-destructive commands. */
export function detectEcosystem(workdir: string): Ecosystem {
  const has = (f: string): boolean => existsSync(`${workdir}/${f}`);
  if (has("go.mod")) {
    return { build: "go build ./...", test: "go test ./...", lint: "gofmt -l . && go vet ./..." };
  }
  if (has("Cargo.toml")) {
    return { build: "cargo build", test: "cargo test", lint: "cargo clippy -- -D warnings" };
  }
  if (has("package.json")) {
    // Honor the project's OWN scripts via the detected package manager — but only
    // derive a command when the matching script actually exists, else e.g.
    // `pnpm run lint` on a repo with no lint script fails the gate falsely (npm
    // scripts are optional, unlike go/cargo toolchain verbs). `bun test` is the
    // one built-in that needs no script.
    const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") ? "bun" : "npm";
    const run = `${pm} run`;
    let scripts: Record<string, unknown> = {};
    try {
      const pkg = JSON.parse(readFileSync(`${workdir}/package.json`, "utf8")) as { scripts?: Record<string, unknown> };
      scripts = pkg.scripts ?? {};
    } catch {
      // Unreadable/invalid package.json → no derivable scripts (fail closed at the probe).
    }
    const eco: Ecosystem = {};
    if (typeof scripts.build === "string") eco.build = `${run} build`;
    if (typeof scripts.test === "string") eco.test = `${run} test`;
    else if (pm === "bun") eco.test = "bun test";
    if (typeof scripts.lint === "string") eco.lint = `${run} lint`;
    return eco;
  }
  if (has("pyproject.toml") || has("setup.py") || has("requirements.txt")) {
    return { test: "pytest -q", lint: "ruff check ." };
  }
  return {};
}

/** The ecosystem commands a given execution-probe type runs (in order). `verify`
 *  fans out to every command the ecosystem defines. Returns the list of
 *  (label, command) pairs — empty when the ecosystem doesn't support the type. */
function commandsFor(type: ProbeType, eco: Ecosystem): { label: string; cmd: string }[] {
  const one = (label: keyof Ecosystem): { label: string; cmd: string }[] =>
    eco[label] ? [{ label, cmd: eco[label]! }] : [];
  switch (type) {
    case "build":
      return one("build");
    case "test":
      return one("test");
    case "lint":
      return one("lint");
    case "verify":
      return [...one("build"), ...one("test"), ...one("lint")];
    default:
      return [];
  }
}

/** True when at least one file matches any of the globs, relative to `workdir`. */
function anyGlobMatches(workdir: string, globs: string[]): boolean {
  for (const g of globs) {
    // A bare path (no glob magic) is matched by existence; a pattern is scanned.
    if (!/[*?[\]{}]/.test(g)) {
      if (existsSync(`${workdir}/${g}`)) return true;
      continue;
    }
    const glob = new Bun.Glob(g);
    // scanSync yields the first match lazily — we only need existence.
    for (const _ of glob.scanSync({ cwd: workdir, onlyFiles: false, dot: false })) return true;
  }
  return false;
}

/**
 * Build a probe `GatePlugin`. `trusted` gates whether EXECUTION probes may run
 * (read-only probes ignore it). An execution probe on an untrusted pack — or one
 * whose ecosystem doesn't define the command — fails closed with a clear reason,
 * exactly like the command gate, so nothing silently "passes" a check it never
 * actually ran.
 */
export function buildProbeGate(
  id: string,
  spec: ProbeSpec,
  at: "entry" | "exit",
  trusted: boolean,
): GatePlugin {
  return {
    id,
    at,
    async evaluate(ctx: GateCtx): Promise<GateVerdict> {
      const workdir = ctx.pipeline.workdir;
      if (!workdir) {
        return { pass: false, reason: `probe "${id}" (${spec.type}) needs a workdir — none set on the run` };
      }

      // ── Read-only probes ──────────────────────────────────────────────────
      if (spec.type === "file-exists" || spec.type === "glob-nonempty") {
        const globs = spec.paths ?? [];
        if (globs.length === 0) {
          return { pass: false, reason: `probe "${id}" (${spec.type}) declares no paths` };
        }
        const escaping = globs.find(probePathEscapes);
        if (escaping) {
          return { pass: false, reason: `probe "${id}": path "${escaping}" must be relative to the workdir and not escape it` };
        }
        try {
          const hit = anyGlobMatches(workdir, globs);
          return hit
            ? { pass: true }
            : { pass: false, reason: `probe "${id}": no file matches ${globs.join(", ")}` };
        } catch (err) {
          return { pass: false, reason: `probe "${id}" (${spec.type}) failed: ${errText(err)}` };
        }
      }
      if (spec.type === "git-diff-nonempty") {
        const { outcome, evidenceId } = await runProbe(ctx, id, "git-diff", "test -n \"$(git status --porcelain)\"", workdir);
        const evidenceIds = evidenceId ? [evidenceId] : [];
        return outcome.result === "pass"
          ? { pass: true, evidenceIds }
          : { pass: false, reason: `probe "${id}": the working tree has no changes`, evidenceIds };
      }

      // ── Execution probes (trust-gated) ────────────────────────────────────
      if (!trusted) {
        return {
          pass: false,
          reason: `probe "${id}" (${spec.type}) executes commands and requires a trusted pack (host opt-in) — not run`,
        };
      }
      const eco = detectEcosystem(workdir);
      const cmds = commandsFor(spec.type, eco);
      if (cmds.length === 0) {
        return {
          pass: false,
          reason: `probe "${id}" (${spec.type}): no ${spec.type} command auto-derived for this workspace (unrecognized ecosystem)`,
        };
      }
      const evidenceIds: string[] = [];
      for (const { label, cmd } of cmds) {
        const { outcome, evidenceId } = await runProbe(ctx, id, label, cmd, workdir);
        if (evidenceId) evidenceIds.push(evidenceId);
        if (outcome.result !== "pass") {
          const tail = diagnosticTail(outcome);
          return {
            pass: false,
            reason: `probe "${id}": ${label} ${outcome.result} — ${outcome.reason}: ${cmd}${tail ? `\n${tail}` : ""}`,
            evidenceIds,
          };
        }
      }
      return { pass: true, evidenceIds };
    },
  };
}
