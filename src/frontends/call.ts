/** Keys callParts shows itself, or that change nothing about what runs. */
const SHOWN_OR_IDLE = new Set([
  "command",
  "cmd",
  "script",
  "plan",
  "file_path",
  "path",
  "notebook_path",
  "content",
  "old_string",
  "new_string",
  "description",
  "timeout",
]);

/** Most characters of the head (a path) and of the other inputs a card shows. */
export const HEAD_SHOWN = 300;
export const REST_SHOWN = 600;

/**
 * What a tool call would do, as an approval card shows it: the command a
 * shell runs, the file a write or edit touches with what it writes, a plan;
 * else its input whole. `rest` is the call's other inputs (a network host, a
 * cwd, a repository, `replace_all`), which change what is approved. Plain
 * text: each frontend escapes it for its own markup and cuts the body to
 * fit, saying so when it does.
 */
export function callParts(input: unknown): { head: string; body: string; rest: string } {
  const i = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
  if (!i) return { head: "", body: json(input ?? {}), rest: "" };
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const argv = (v: unknown) => (Array.isArray(v) && v.every((a) => typeof a === "string") ? v.join(" ") : undefined);
  const command = str(i.command) ?? argv(i.command) ?? str(i.cmd) ?? argv(i.cmd) ?? str(i.script);
  const path = str(i.file_path) ?? str(i.path) ?? str(i.notebook_path);
  let head = "";
  let body: string;
  if (command !== undefined) body = command;
  else if (str(i.plan) !== undefined) body = str(i.plan)!;
  else if (path !== undefined && (str(i.content) !== undefined || str(i.new_string) !== undefined)) {
    head = cut(path, HEAD_SHOWN);
    body = str(i.content) ?? `${str(i.old_string) ?? ""}\n→\n${str(i.new_string) ?? ""}`;
  } else return { head: "", body: json(i), rest: "" };
  const others = Object.fromEntries(Object.entries(i).filter(([k]) => !SHOWN_OR_IDLE.has(k)));
  const rest = Object.keys(others).length > 0 ? cut(json(others, 0), REST_SHOWN) : "";
  return { head, body, rest };
}

/** The first `n` UTF-16 units of `s`, never ending on half a character, with "…" when cut. */
export function cut(s: string, n: number): string {
  return s.length > n ? `${safeSlice(s, n)}…` : s;
}

/** The first `n` UTF-16 units of `s`, one fewer when the last would be half of a pair. */
export function safeSlice(s: string, n: number): string {
  if (s.length <= n) return s;
  const last = s.charCodeAt(n - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? n - 1 : n);
}

/** The note a card adds when it shows only the first `shown` of `total` characters of a call. */
export function cutNote(shown: number, total: number): string {
  return `(cut short at ${shown} of ${total} characters: see the whole call in the web UI or with codeoid approve)`;
}

function json(v: unknown, indent = 2): string {
  try {
    return JSON.stringify(v, null, indent) ?? String(v);
  } catch {
    return String(v);
  }
}
