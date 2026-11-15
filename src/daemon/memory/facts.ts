/**
 * A shell call's exit code (docs/secrets-and-memory-design.md §3), for
 * backends that don't report it as a field: Claude's Bash result carries
 * `Exit code N` on a failure, pi's ends with `Command exited with code N`,
 * the tool loops codeoid runs say it in similar words.
 */

const EXIT_LINE = /(?:^|\n)[ \t]*(?:Error:[ \t]*)?(?:command[ \t]+)?(?:exit(?:ed)?(?:[ \t]+with)?[ \t]+(?:code|status)|process exited with code)[: \t]*(-?\d{1,3})\b/i;

/** A failed call whose code nobody said: failed, the code unknown. */
export const FAILED_UNKNOWN_CODE = -1;

/**
 * A shell call's exit code. The backend's field first; else 0 when the
 * backend says it succeeded (whatever its output prints: a log can say "exit
 * status 1" of something else); else the code its result names near its
 * start or end, never 0 for a call that failed; else -1, failed with no code.
 * Undefined only when the backend says nothing either way.
 */
export function exitCodeOf(output: string, success: boolean | undefined, reported?: number): number | undefined {
  if (reported !== undefined) return reported;
  if (success === true) return 0;
  const head = output.slice(0, 400);
  const tail = output.length > 400 ? output.slice(-400) : "";
  const m = EXIT_LINE.exec(tail) ?? EXIT_LINE.exec(head);
  const named = m ? Number(m[1]) : undefined;
  if (success === false) return named !== undefined && named !== 0 ? named : FAILED_UNKNOWN_CODE;
  return named;
}
