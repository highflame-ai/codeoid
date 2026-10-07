/**
 * Answering a provider dialog (#348) from a text surface — the CLI's attach
 * loop and the TUI share this so a typed answer means the same thing in both.
 */

/** A provider dialog a text surface is waiting to answer. */
export interface PendingDialog {
  requestId: string;
  method: "select" | "confirm" | "input" | "editor";
  options?: string[];
}

/**
 * Turn a typed line into the answer for `dialog` (a `session.ui_response`
 * body), or an error to show and re-prompt on. `/skip` dismisses any dialog.
 * Pure, for tests.
 */
export function parseDialogAnswer(
  line: string,
  dialog: PendingDialog,
): { value?: string; confirmed?: boolean; cancelled?: boolean } | { error: string } {
  const text = line.trim();
  if (text === "/skip") return { cancelled: true };
  switch (dialog.method) {
    case "confirm": {
      const t = text.toLowerCase();
      if (t === "y" || t === "yes") return { confirmed: true };
      if (t === "n" || t === "no") return { confirmed: false };
      return { error: "Answer yes or no (or /skip)." };
    }
    case "select": {
      const options = dialog.options ?? [];
      const n = Number(text);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return { value: options[n - 1] };
      const exact = options.find((o) => o === text);
      if (exact !== undefined) return { value: exact };
      return { error: `Pick 1–${options.length} (or /skip).` };
    }
    case "input":
    case "editor":
      if (!text) return { error: "Type an answer (or /skip)." };
      return { value: text };
  }
}

