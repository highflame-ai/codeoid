import { describe, expect, it } from "bun:test";
import { callParts, cut, REST_SHOWN, safeSlice } from "../frontends/call.js";

describe("callParts — what an approval card shows of a call", () => {
  it("shows a shell's command, joined when it is argv, and a script", () => {
    expect(callParts({ command: "ls -la" }).body).toBe("ls -la");
    expect(callParts({ command: ["git", "push", "--force"] }).body).toBe("git push --force");
    expect(callParts({ cmd: "make" }).body).toBe("make");
    expect(callParts({ script: "rm -rf build" }).body).toBe("rm -rf build");
  });

  it("shows a write's path and content, an edit's old and new text, and a plan", () => {
    expect(callParts({ file_path: "/w/a.ts", content: "x" })).toEqual({ head: "/w/a.ts", body: "x", rest: "" });
    expect(callParts({ file_path: "/w/a.ts", old_string: "a", new_string: "b" }).body).toBe("a\n→\nb");
    expect(callParts({ plan: "1. do it" }).body).toBe("1. do it");
  });

  it("says the call's other inputs, which change what is approved, and leaves out the description and timeout", () => {
    expect(callParts({ command: "curl x", network: { host: "evil.example" }, description: "d", timeout: 5 }).rest).toBe(
      JSON.stringify({ network: { host: "evil.example" } }),
    );
    expect(callParts({ file_path: "/w/a", old_string: "a", new_string: "b", replace_all: true }).rest).toContain('"replace_all":true');
    expect(callParts({ owner: "o", repo: "r", branch: "main", path: "a.yml", content: "c" }).rest).toContain('"repo":"r"');
    expect(callParts({ command: "x", junk: "y".repeat(5000) }).rest.length).toBeLessThanOrEqual(REST_SHOWN + 1);
  });

  it("shows any other input whole, and never throws on one JSON can't write", () => {
    expect(callParts({ query: "q" }).body).toBe(JSON.stringify({ query: "q" }, null, 2));
    expect(callParts(undefined).body).toBe("{}");
    expect(callParts("hello").body).toBe('"hello"');
    expect(callParts(["a"]).body).toBe(JSON.stringify(["a"], null, 2));
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => callParts(cyclic)).not.toThrow();
    expect(() => callParts({ n: 1n })).not.toThrow();
  });
});

describe("safeSlice and cut", () => {
  it("never ends on half of a character", () => {
    const s = `${"a".repeat(9)}😀b`;
    expect(safeSlice(s, 10)).toBe("a".repeat(9));
    expect(safeSlice(s, 11)).toBe(`${"a".repeat(9)}😀`);
    expect(safeSlice("abc", 10)).toBe("abc");
    expect(cut("abcdef", 3)).toBe("abc…");
    expect(cut("abc", 3)).toBe("abc");
  });
});
