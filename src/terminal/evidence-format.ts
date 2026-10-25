/**
 * Render one evidence record for the terminal (`codeoid evidence <id>`).
 * Pure: returns lines, so it is tested without a daemon.
 */

import type { EvidenceWire } from "../protocol/types.js";

export function formatEvidence(e: EvidenceWire, opts: { full?: boolean } = {}): string[] {
  const secs = ((Date.parse(e.endedAt) - Date.parse(e.startedAt)) / 1000).toFixed(1);
  const exit = e.signal ? `signal ${e.signal}` : e.exitCode === null ? "no exit code" : `exit ${e.exitCode}`;
  const lines = [
    `${e.id}  ${e.result.toUpperCase()}  ${e.reason}`,
    `  check      ${e.criterionId}`,
    `  command    ${e.command}`,
    `  outcome    ${exit}${e.timedOut ? ", timed out" : ""}, ${secs}s`,
    `  candidate  ${e.candidateDigest ?? "(no pinned tree — certifies no particular revision)"}`,
    `  verifier   ${e.verifierDigest.slice(0, 16)}  isolation=${e.isolation}`,
    `  owner      ${e.ownerKind} ${e.ownerId}`,
    `  ran        ${e.startedAt} on ${e.environment.platform}/${e.environment.arch}, ${e.environment.runtime}`,
  ];
  for (const a of e.artifacts) {
    lines.push(`  ${a.name.padEnd(9)}  ${a.bytes} bytes${a.truncated ? " (truncated at cap)" : ""}  sha256 ${a.sha256.slice(0, 16)}`);
  }
  const block = (title: string, text: string): void => {
    const body = text.trimEnd();
    if (!body) return;
    const shown = opts.full ? body.split("\n") : body.split("\n").slice(-40);
    lines.push("", `── ${title}${!opts.full && body.split("\n").length > 40 ? " (last 40 lines; --full for the excerpt)" : ""}`);
    lines.push(...shown);
  };
  block("stderr", e.stderrExcerpt);
  block("stdout", e.stdoutExcerpt);
  return lines;
}
