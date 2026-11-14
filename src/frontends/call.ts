import { quote, shellCallOf } from "../daemon/shell/tool-call.js";

/** Keys that change nothing about what runs; every other key the card shows. */
const IDLE = new Set(["description", "timeout"]);

/** Most characters of the head (a path) and of the other inputs a card shows. */
export const HEAD_SHOWN = 300;
export const REST_SHOWN = 600;

/**
 * What a tool call would do, as an approval card shows it: the command a
 * shell runs, the file a write or edit touches with what it writes, a plan;
 * else its input whole. `rest` is every input the body and head don't show
 * (a network host, a cwd, a repository, `replace_all`, a second command key),
 * since each can change what is approved. Plain text: each frontend escapes
 * it for its own markup and cuts the body to fit, saying so when it does.
 */
export function callParts(input: unknown, toolName = ""): { head: string; body: string; rest: string } {
  const i = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
  if (!i) return { head: "", body: json(input ?? {}), rest: "" };
  const str = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : undefined);
  const first = (...keys: string[]) => keys.find((k) => str(k) !== undefined);
  const used: string[] = [];
  let head = "";
  let body: string | undefined;
  const pathKey = first("file_path", "path", "notebook_path");
  const contentKey = first("content", "file_text");
  const newKey = first("new_string", "new_str");
  // A write or an edit, also when a `command` names the edit (the text editor tool's create / str_replace).
  if (pathKey && (contentKey || newKey)) {
    head = cut(str(pathKey)!, HEAD_SHOWN);
    if (contentKey) {
      body = str(contentKey)!;
      used.push(pathKey, contentKey);
    } else {
      const oldKey = first("old_string", "old_str");
      body = `${oldKey ? str(oldKey) : ""}\n→\n${str(newKey!)}`;
      used.push(pathKey, newKey!, ...(oldKey ? [oldKey] : []));
    }
  } else {
    const shell = shellCallOf(toolName, i);
    const commandKey = ["command", "cmd", "script"].find(
      (k) => typeof i[k] === "string" || (Array.isArray(i[k]) && (i[k] as unknown[]).every((x) => typeof x === "string")),
    );
    if (shell) body = shell.command;
    else if (commandKey) body = typeof i[commandKey] === "string" ? (i[commandKey] as string) : (i[commandKey] as string[]).map(quote).join(" ");
    if (body !== undefined && commandKey) used.push(commandKey);
    else if (str("plan") !== undefined) {
      body = str("plan")!;
      used.push("plan");
    }
  }
  if (body === undefined) return { head: "", body: json(i), rest: "" };
  const others = Object.fromEntries(Object.entries(i).filter(([k]) => !used.includes(k) && !IDLE.has(k)));
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
