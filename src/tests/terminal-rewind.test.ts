/** `/undo` on text surfaces (#355): one grammar and one wording for the CLI, TUI and `codeoid undo`. */

import { describe, expect, it } from "bun:test";
import { formatRewind, parseUndoArgs } from "../terminal/rewind.js";
import type { SessionRewindResultMsg } from "../protocol/types.js";

const base: SessionRewindResultMsg = {
  type: "session.rewind.result",
  requestId: "r",
  sessionId: "s",
  turnId: "t",
  dryRun: false,
  removedTurns: 1,
  planId: "p",
  restoredPrompt: "oops",
  irreversible: [],
};

describe("parseUndoArgs", () => {
  it("maps the grammar", () => {
    expect(parseUndoArgs([])).toEqual({ restoreFiles: false, dryRun: false, force: false });
    expect(parseUndoArgs(["files"])).toEqual({ restoreFiles: true, dryRun: true, force: false });
    expect(parseUndoArgs(["Files", "YES"])).toEqual({ restoreFiles: true, dryRun: false, force: false });
    expect(parseUndoArgs(["files", "force"])).toEqual({ restoreFiles: true, dryRun: false, force: true });
    for (const bad of [["now"], ["files", "maybe"], ["files", "yes", "extra"]]) expect("error" in parseUndoArgs(bad)).toBe(true);
  });
});

describe("formatRewind", () => {
  it("a done undo says the agent forgot it and the message is back", () => {
    const out = formatRewind(base);
    expect(out).toContain("1 turn taken back");
    expect(out).toContain("back in the prompt");
  });

  it("a preview lists the files and says how to go ahead, steering to force when hand edits would be lost", () => {
    const preview = formatRewind({
      ...base,
      dryRun: true,
      removedTurns: 2,
      files: { restore: ["a.txt"], remove: ["new.txt"], conflicts: ["a.txt"], applied: false, late: true },
      irreversible: [{ tool: "Bash", detail: "git push" }],
    });
    expect(preview).toContain("would take back 2 turns");
    expect(preview).toContain("restore  a.txt  (edited by you since)");
    expect(preview).toContain("remove   new.txt");
    expect(preview).toContain("may include its first edits");
    expect(preview).toContain("Bash: git push");
    expect(preview).toContain("/undo files force");
    expect(formatRewind({ ...base, dryRun: true, files: { restore: [], remove: [], conflicts: [], applied: false } })).toContain("/undo files yes");
  });

  it("a preview being confirmed in the same step doesn't tell you to confirm it", () => {
    const out = formatRewind({ ...base, dryRun: true }, { hint: false });
    expect(out).not.toContain("/undo files");
    expect(out).not.toContain("back in the prompt"); // nothing was taken back yet
  });

  it("a refusal says nothing changed", () => {
    expect(formatRewind({ ...base, dryRun: true, refused: "2 file(s) were changed by hand" })).toStartWith("Nothing changed");
  });
});
