/**
 * Going back a turn (#355) from a text surface — `codeoid attach`, the TUI
 * and `codeoid undo` share this, so `/undo` means the same thing everywhere:
 *
 *   /undo               take back the last message (conversation only)
 *   /undo files         preview: what restoring the files would change
 *   /undo files yes     take it back AND restore the files (refused if that
 *                       would overwrite files edited by hand since)
 *   /undo files force   …and overwrite those hand edits
 *
 * Pure: parsing and formatting only, for tests.
 */

import type { SessionRewindResultMsg } from "../protocol/types.js";

export interface UndoRequest {
  restoreFiles: boolean;
  dryRun: boolean;
  force: boolean;
}

/** Parse `/undo` arguments, or an error to show. */
export function parseUndoArgs(args: readonly string[]): UndoRequest | { error: string } {
  const words = args.map((a) => a.trim().toLowerCase()).filter(Boolean);
  if (words.length === 0) return { restoreFiles: false, dryRun: false, force: false };
  if (words[0] !== "files" || words.length > 2) return { error: "Usage: /undo [files [yes|force]]" };
  if (words.length === 1) return { restoreFiles: true, dryRun: true, force: false };
  if (words[1] === "yes") return { restoreFiles: true, dryRun: false, force: false };
  if (words[1] === "force") return { restoreFiles: true, dryRun: false, force: true };
  return { error: "Usage: /undo [files [yes|force]]" };
}

/** A plain-text account of what going back did, or would do. */
export function formatRewind(r: SessionRewindResultMsg): string {
  const lines: string[] = [];
  const turns = r.removedTurns === 1 ? "1 turn" : `${r.removedTurns} turns`;
  if (r.refused) {
    lines.push(`Nothing changed: ${r.refused}.`);
  } else if (r.dryRun) {
    lines.push(`Going back would take back ${turns}.`);
  } else {
    lines.push(`Went back: ${turns} taken back. The agent no longer remembers ${r.removedTurns === 1 ? "it" : "them"}.`);
  }
  if (r.files) {
    const f = r.files;
    if (f.restore.length === 0 && f.remove.length === 0) {
      lines.push("Files: nothing changed since then.");
    } else {
      lines.push(`Files ${f.applied ? "restored" : "that would change"}:`);
      for (const p of f.restore.slice(0, 50)) lines.push(`  restore  ${p}${f.conflicts.includes(p) ? "  (edited by you since)" : ""}`);
      for (const p of f.remove.slice(0, 50)) lines.push(`  remove   ${p}${f.conflicts.includes(p) ? "  (edited by you since)" : ""}`);
      const more = Math.max(0, f.restore.length - 50) + Math.max(0, f.remove.length - 50);
      if (more > 0) lines.push(`  … ${more} more`);
    }
    if (f.late) lines.push("Note: that snapshot finished after the agent had started, so it may include its first edits.");
  } else if (r.filesUnavailable) {
    lines.push(`Files can't be restored: ${r.filesUnavailable}.`);
  }
  if (r.irreversible.length > 0) {
    lines.push("Not undone by going back:");
    for (const x of r.irreversible.slice(0, 20)) lines.push(`  ${x.tool}: ${x.detail}`);
  }
  if (r.dryRun) {
    const conflicts = r.files?.conflicts.length ?? 0;
    lines.push(
      conflicts > 0
        ? `${conflicts} file(s) were edited by you since the agent's last turn. Type /undo files force to go back and overwrite them, or /undo to take back the conversation only.`
        : "Type /undo files yes to go back and restore the files, or /undo to take back the conversation only.",
    );
  } else if (!r.refused && r.restoredPrompt) {
    lines.push("Your message is back in the prompt to edit and resend.");
  }
  return lines.join("\n");
}
