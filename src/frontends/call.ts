/**
 * What a tool call would do, as an approval card shows it: the command a
 * shell runs, the file a write or edit touches with what it writes, a plan;
 * else its input whole. Plain text — each frontend escapes it for its own
 * markup and cuts it to fit, saying so when it does.
 */
export function callParts(input: unknown): { head: string; body: string } {
  const i = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const command = str(i.command) ?? str(i.cmd);
  const path = str(i.file_path) ?? str(i.path) ?? str(i.notebook_path);
  if (command !== undefined) return { head: "", body: command };
  if (str(i.plan) !== undefined) return { head: "", body: str(i.plan)! };
  if (path !== undefined && (str(i.content) !== undefined || str(i.new_string) !== undefined)) {
    return { head: path, body: str(i.content) ?? `${str(i.old_string) ?? ""}\n→\n${str(i.new_string) ?? ""}` };
  }
  return { head: "", body: JSON.stringify(input ?? {}, null, 2) };
}

/** The note a card adds when it shows only the first `shown` of `total` characters of a call. */
export function cutNote(shown: number, total: number): string {
  return `(cut short at ${shown} of ${total} characters: see the whole call in the web UI or with codeoid approve)`;
}
