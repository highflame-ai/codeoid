/**
 * Evidence: the durable, revision-bound record of one executed check
 * (docs/loop-engineering-design.md §7).
 *
 * A check's verdict is never a model's claim. It is what a command did, on a
 * named tree, under a pinned definition, captured by the daemon. Pipelines'
 * deterministic gates record evidence today; loops build their acceptance
 * decisions on it.
 */

/**
 * What a check established.
 * - `pass` — it ran to completion and succeeded.
 * - `fail` — it ran and the candidate did not satisfy it, including running
 *   past its time bound: a hung test is the candidate's problem to fix.
 * - `inconclusive` — it exited 0 but established nothing (zero tests selected,
 *   no test files). Never a pass.
 * - `error` — it could not be run or its result could not be read (missing
 *   binary, spawn failure, unreadable output). Infrastructure, not the candidate.
 * - `cancelled` — stopped on request before it finished.
 */
export type EvidenceResult = "pass" | "fail" | "inconclusive" | "error" | "cancelled";

/**
 * How strongly the check was separated from the code it judged.
 * `process` runs it as an ordinary child process in a directory; `sandbox`
 * runs it in an isolated namespace with the evaluator mounted read-only.
 */
export type EvidenceIsolation = "process" | "sandbox";

/** A check to run. The definition is data: its digest pins it in the record. */
export interface CheckSpec {
  /** Stable id of the criterion this check evaluates (e.g. `exit:test`). */
  id: string;
  /** Human label, e.g. `test`. */
  label?: string;
  /** Shell command, run as `sh -c <command>`. */
  command: string;
  /** Hard bound; past it the process group is killed and the result is `fail`. */
  timeoutMs: number;
  /** Extra environment for the check, merged over the daemon's. Values are not
   *  recorded — only their names, so a credential never lands in evidence. */
  env?: Record<string, string>;
  /**
   * The check is a test run: exiting 0 after selecting no tests is
   * `inconclusive`, not `pass`. Set for test probes; leave unset for builds
   * and linters, which legitimately print nothing.
   */
  expectTests?: boolean;
}

/** Who a piece of evidence belongs to. Reads are authorized through the owner. */
export type EvidenceOwnerKind = "pipeline" | "loop";

/** One captured output stream, stored in full as an artifact (up to a cap). */
export interface EvidenceArtifact {
  name: "stdout" | "stderr";
  path: string;
  sha256: string;
  bytes: number;
  /** The stream exceeded the artifact cap; the file holds its first bytes. */
  truncated: boolean;
}

/** The environment a check ran in — enough to tell two runs apart. */
export interface EvidenceEnvironment {
  platform: string;
  arch: string;
  runtime: string;
  /** Names (never values) of the variables the spec added. */
  envKeys: string[];
}

export interface EvidenceRecord {
  id: string;
  accountId: string;
  projectId: string;
  ownerKind: EvidenceOwnerKind;
  ownerId: string;
  criterionId: string;
  /** Git tree (or checkpoint) the check judged; null when the workspace had no
   *  snapshot — such evidence certifies no particular revision. */
  candidateDigest: string | null;
  /** sha256 of the check definition (command, timeout, env names, flags). */
  verifierDigest: string;
  environment: EvidenceEnvironment;
  isolation: EvidenceIsolation;
  command: string;
  result: EvidenceResult;
  /** One sentence a human or a worker can act on. */
  reason: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  startedAt: number;
  endedAt: number;
  /** Bounded excerpts for display and worker feedback; the full streams are
   *  in `artifacts`. */
  stdoutExcerpt: string;
  stderrExcerpt: string;
  artifacts: EvidenceArtifact[];
}

/** What a check run produces before it is attributed and stored. */
export type CheckOutcome = Omit<
  EvidenceRecord,
  "id" | "accountId" | "projectId" | "ownerKind" | "ownerId" | "candidateDigest" | "artifacts"
> & {
  /** Full output, kept by the runner until the caller places the artifacts. */
  artifacts: EvidenceArtifact[];
};
