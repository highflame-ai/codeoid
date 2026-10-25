/**
 * Redact credentials from a check's captured output before it is stored as an
 * excerpt or shown to a model. Test output echoes tokens more often than one
 * would like: `set -x`, a failing HTTP fixture, a connection string in an error.
 *
 * Uses the daemon's redaction rules (mcp/redact.ts), which scan a bounded
 * window per call, so long text is redacted a group of lines at a time. A token
 * never spans a line break in practice, so splitting on lines loses nothing.
 */

import { redactSecretText } from "../mcp/redact.js";

/** Kept under redactSecretText's scan window so every byte is scanned. */
const CHUNK_CHARS = 1_800;

export function redactOutput(text: string): string {
  if (!text) return text;
  const out: string[] = [];
  let chunk = "";
  const flush = (): void => {
    if (chunk) out.push(redactSecretText(chunk));
    chunk = "";
  };
  for (const line of text.split("\n")) {
    // A single line longer than the window is redacted in slices.
    if (line.length > CHUNK_CHARS) {
      flush();
      const slices: string[] = [];
      for (let i = 0; i < line.length; i += CHUNK_CHARS) slices.push(redactSecretText(line.slice(i, i + CHUNK_CHARS)));
      out.push(slices.join(""));
      continue;
    }
    if (chunk.length + line.length + 1 > CHUNK_CHARS) flush();
    chunk = chunk ? `${chunk}\n${line}` : line;
  }
  flush();
  return out.join("\n");
}
