import type { SessionInfo } from "../protocol/types.js";
import { sanitizeTerminalOutput } from "./ansi/codes.js";

/** Prompt-line copy for a pending provider dialog (#348). */
export function dialogHint(d: NonNullable<SessionInfo["pendingDialog"]>): string {
  const title = sanitizeTerminalOutput(d.title);
  switch (d.method) {
    case "confirm":
      return `? ${title} — press y/n (or type /skip)`;
    case "select": {
      const opts = (d.options ?? []).map((o, i) => `${i + 1}) ${sanitizeTerminalOutput(o)}`).join("  ");
      return `? ${title} — ${opts} — ${(d.options ?? []).length <= 9 ? "press a number" : "type a number, Enter"} (or type /skip)`;
    }
    default:
      return `? ${title} — type your answer, Enter to send (or /skip)`;
  }
}
