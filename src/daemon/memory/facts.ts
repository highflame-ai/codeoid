/**
 * Facts read from a shell call's result (docs/secrets-and-memory-design.md §3):
 * its exit code, where the backend reports it in the result rather than as a
 * field. Claude's Bash result carries `Exit code N` on a failure; Codex's,
 * opencode's and the tool loops codeoid runs say it in similar words.
 */

const EXIT_LINE = /(?:^|\n)[ \t]*(?:Error:[ \t]*)?(?:exit(?:ed)?(?:[ \t]+with)?[ \t]+(?:code|status)|process exited with code)[: \t]*(-?\d{1,3})\b/i;

/**
 * A shell call's exit code: the one its result names (near its start or its
 * end), else 0 when the backend says it succeeded; undefined when neither says.
 */
export function exitCodeOf(output: string, success: boolean | undefined): number | undefined {
  const head = output.slice(0, 400);
  const tail = output.length > 400 ? output.slice(-400) : "";
  const m = EXIT_LINE.exec(head) ?? (tail ? EXIT_LINE.exec(tail) : null);
  if (m) return Number(m[1]);
  return success === true ? 0 : undefined;
}
