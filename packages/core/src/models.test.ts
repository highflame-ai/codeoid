import { describe, it, expect } from "bun:test";
import { resolveAgainstList, stripVariantSuffix } from "./models.js";

// Verbatim from `supportedModels()` on claude-agent-sdk 0.3.258. The backend
// reports context-window variants as a bracketed suffix on the VALUE, and its
// display names carry no version — "Fable" is Fable 5.1 here and was Fable 5
// a release ago. Both facts are load-bearing for the cases below.
const live = [
  { value: "default", displayName: "Default (recommended)" },
  { value: "opus[1m]", displayName: "Opus (1M context)" },
  { value: "claude-fable-5-1[1m]", displayName: "Fable" },
  { value: "sonnet", displayName: "Sonnet" },
  { value: "haiku", displayName: "Haiku" },
];

describe("stripVariantSuffix", () => {
  it("strips a bracketed context-window variant", () => {
    expect(stripVariantSuffix("opus[1m]")).toBe("opus");
    expect(stripVariantSuffix("claude-fable-5-1[1m]")).toBe("claude-fable-5-1");
  });
  it("leaves an unsuffixed value alone", () => {
    expect(stripVariantSuffix("sonnet")).toBe("sonnet");
    expect(stripVariantSuffix("")).toBe("");
  });
});

describe("resolveAgainstList", () => {
  it("matches an exact value", () => {
    expect(resolveAgainstList("opus[1m]", live)).toBe("opus[1m]");
    expect(resolveAgainstList("sonnet", live)).toBe("sonnet");
  });

  // The regression this module exists to prevent: the web client had its own
  // copy without this rule, so `/model opus` was rejected client-side as
  // unknown even though the daemon would have resolved it.
  it("matches a bare alias against a variant-suffixed value", () => {
    expect(resolveAgainstList("opus", live)).toBe("opus[1m]");
    expect(resolveAgainstList("OPUS", live)).toBe("opus[1m]");
  });

  it("matches a display name case-insensitively", () => {
    expect(resolveAgainstList("fable", live)).toBe("claude-fable-5-1[1m]");
    expect(resolveAgainstList("Default (recommended)", live)).toBe("default");
  });

  it("matches a bare full id against its variant-suffixed entry", () => {
    expect(resolveAgainstList("claude-fable-5-1", live)).toBe("claude-fable-5-1[1m]");
  });

  it("prefers an exact value over a suffix-stripped match", () => {
    const both = [
      { value: "opus[1m]", displayName: "Opus (1M context)" },
      { value: "opus", displayName: "Opus" },
    ];
    expect(resolveAgainstList("opus", both)).toBe("opus");
  });

  it("passes through a claude-* id the backend didn't advertise", () => {
    expect(resolveAgainstList("claude-opus-6", live)).toBe("claude-opus-6");
  });

  it("returns null for an unknown value", () => {
    expect(resolveAgainstList("o", live)).toBeNull();
    expect(resolveAgainstList("", live)).toBeNull();
    expect(resolveAgainstList("   ", live)).toBeNull();
  });
});
