/**
 * Compression runner — execute a shell command, capture stdout/stderr/exit,
 * apply the rule registry, return a CompressionOutcome.
 *
 * Kept pure-ish: no side effects beyond the child process. The caller
 * decides what to do with the outcome (print to stdout, store to DB, etc.).
 *
 * Budget choices:
 *   - stdout capped at 10 MB raw — beyond that we truncate and mark. Common
 *     sense guard: a tool output over 10 MB is already a pathology worth
 *     surfacing, not silently suppressing.
 *   - No internal timeout — Claude Code's Bash tool imposes its own; stacking
 *     ours on top just creates confusing failure modes.
 */

import type {
  CompressionContext,
  CompressionOutcome,
} from "./types.js";
import type { CompressionRegistry } from "./registry.js";
import { formatHint } from "./hint.js";
import { writeSpill } from "./spill.js";

/** Hard cap on raw bytes buffered before truncation. 10 MiB. */
export const MAX_RAW_BYTES = 10 * 1024 * 1024;
const TRUNCATION_MARKER = "\n\n[… codeoid: output truncated — exceeded 10 MB buffer cap …]\n";

export interface RunOptions {
  command: string;
  workdir: string;
  env: Readonly<Record<string, string>>;
  registry: CompressionRegistry;
  /** Below this size we skip compression (rule might fire but win is nil). */
  minBytes: number;
  /**
   * Whether to allow rules on commands containing shell pipes / subshells.
   * Default false — piping is risky to rewrite without breaking semantics.
   */
  compressPipes: boolean;
  /**
   * Where to spill the raw output of a compressed command so memory can keep
   * it (spill.ts). Absent = no spill; the hint then says the raw is gone.
   */
  spillDir?: string;
}

/**
 * Execute `command` through `/bin/sh -c` in `workdir`, capture streams,
 * and optionally compress stdout using the registry.
 */
export async function runCompressed(opts: RunOptions): Promise<CompressionOutcome> {
  const child = Bun.spawn(["/bin/sh", "-c", opts.command], {
    cwd: opts.workdir,
    env: opts.env as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  const [rawStdout, rawStderr, exitCode] = await Promise.all([
    readStreamCapped(child.stdout),
    readStreamCapped(child.stderr),
    child.exited,
  ]);

  const stderr = rawStderr.truncated
    ? rawStderr.text + TRUNCATION_MARKER
    : rawStderr.text;

  const rawText = rawStdout.truncated
    ? rawStdout.text + TRUNCATION_MARKER
    : rawStdout.text;
  const rawBytes = rawStdout.rawBytes;

  // Skip compression if:
  //   (a) output is tiny (min-bytes threshold) — not worth the hint noise,
  //   (b) command contains pipes and we're not told to handle them,
  //   (c) command is user-excluded or no rule matches.
  const hasPipe = hasShellPipe(opts.command);
  const belowMin = rawBytes < opts.minBytes;
  const skipForPipe = hasPipe && !opts.compressPipes;

  if (belowMin || skipForPipe) {
    return {
      stdout: rawText,
      originalBytes: rawBytes,
      compressedBytes: Buffer.byteLength(rawText, "utf8"),
      ratio: 1,
      ruleName: null,
      exitCode,
      stderr,
    };
  }

  const ctx: CompressionContext = {
    workdir: opts.workdir,
    originalCommand: opts.command,
    exitCode,
    isLarge: rawBytes >= opts.minBytes,
    rawBytes,
    env: opts.env,
  };

  const result = opts.registry.apply(opts.command, rawText, ctx);
  if (!result) {
    return {
      stdout: rawText,
      originalBytes: rawBytes,
      compressedBytes: Buffer.byteLength(rawText, "utf8"),
      ratio: 1,
      ruleName: null,
      exitCode,
      stderr,
    };
  }

  const rawId = opts.spillDir ? writeSpill(rawText, opts.spillDir) : null;
  const hint = result.hint
    ? withRawRef(result.hint, rawId)
    : formatHint(result, opts.command, rawId);
  const finalText = hint ? `${result.compressed}\n\n${hint}` : result.compressed;
  const finalBytes = Buffer.byteLength(finalText, "utf8");

  return {
    stdout: finalText,
    originalBytes: result.originalBytes,
    compressedBytes: finalBytes,
    ratio: result.originalBytes > 0 ? finalBytes / result.originalBytes : 1,
    ruleName: result.ruleName,
    exitCode,
    stderr,
  };
}

// ── Internals ────────────────────────────────────────────────────────────

/** Add the spill reference to a rule's own hint line, inside its brackets, so
 *  the daemon can find the raw output (spill.ts matches the trailing hint). */
function withRawRef(hint: string, rawId: string | null): string {
  if (!rawId || !hint.endsWith("]")) return hint;
  return `${hint.slice(0, -1)}; full output in memory (raw=${rawId})]`;
}

interface CapturedStream {
  text: string;
  rawBytes: number;
  truncated: boolean;
}

/** Read a ReadableStream<Uint8Array> fully, capping at MAX_RAW_BYTES. */
async function readStreamCapped(
  stream: ReadableStream<Uint8Array>,
): Promise<CapturedStream> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = MAX_RAW_BYTES - total;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        total += remaining;
        truncated = true;
        // Continue reading so the child can exit cleanly; we just stop buffering.
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done: d2 } = await reader.read();
          if (d2) break;
        }
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  const buf = Buffer.concat(chunks);
  return { text: buf.toString("utf8"), rawBytes: total, truncated };
}

/**
 * Detect shell output-redirection operators that could conflict with our
 * capture. Only true pipes (`|`, not `||`) and file redirects (`>`, `<`) are
 * dangerous — command substitution (`$(...)`, `` `...` ``), command
 * chaining (`;`, `&&`, `||`), background (`&`), and variable expansion
 * (`$X`) all produce a single final stdout that we can compress cleanly.
 *
 * Conservative ≠ correct. Over-blocking here means NOTHING gets compressed
 * (the for-loop test case), which defeats the feature.
 */
export function hasShellPipe(command: string): boolean {
  // Strip string literals so `|`/`>` inside quoted args don't trigger.
  let s = command
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:[^'])*'/g, "''");
  // Neutralize doubled operators before the single-operator scan. `||` and
  // `&&` are chaining, not redirection. `>>` is an append redirect — we
  // still want to catch that, so don't strip it.
  s = s.replace(/\|\|/g, "  ").replace(/&&/g, "  ");
  if (s.includes("|")) return true;
  // `>` or `>>` anywhere: redirects stdout.
  if (/>/.test(s)) return true;
  // `<` for input redirect — doesn't affect stdout, but some shells use
  // `<<` for heredocs that do funny things. Cautious keep.
  if (/</.test(s)) return true;
  return false;
}
