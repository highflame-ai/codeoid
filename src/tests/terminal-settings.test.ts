/** `codeoid settings` (terminal/settings.ts) over the real manifest. */
import { describe, expect, test } from "bun:test";
import { SETTINGS_MANIFEST } from "../daemon/settings/manifest.js";
import { appliesNote, findField, formatSettingValue, parseSettingValue, settingsLines } from "../terminal/settings.js";
import type { SettingField, SettingsSnapshot } from "../protocol/types.js";

const field = (key: string): SettingField => {
  const f = findField(SETTINGS_MANIFEST, key);
  if (typeof f === "string") throw new Error(f);
  return f;
};

describe("findField", () => {
  test("finds the Claude CLI override, and names near keys for a typo", () => {
    expect(field("providers.claude.command").label).toBe("Claude Code CLI");
    const miss = findField(SETTINGS_MANIFEST, "claude.command");
    expect(typeof miss).toBe("string");
    expect(miss as string).toContain("providers.claude.command");
  });
});

describe("parseSettingValue", () => {
  const f = (kind: SettingField["kind"], extra: Partial<SettingField> = {}): SettingField => ({ key: "k", label: "K", help: "", kind, backing: "config", applies: "restart", ...extra });
  test("booleans, numbers with bounds, enums, lists, strings", () => {
    expect(parseSettingValue(f("boolean"), "on")).toEqual({ value: true });
    expect(parseSettingValue(f("boolean"), "No")).toEqual({ value: false });
    expect(parseSettingValue(f("boolean"), "maybe")).toHaveProperty("error");
    expect(parseSettingValue(f("int", { min: 1, max: 10 }), "5")).toEqual({ value: 5 });
    expect(parseSettingValue(f("int"), "5.5")).toHaveProperty("error");
    expect(parseSettingValue(f("int", { min: 1 }), "0")).toHaveProperty("error");
    expect(parseSettingValue(f("int"), "")).toHaveProperty("error");
    expect(parseSettingValue(f("float"), "0.5")).toEqual({ value: 0.5 });
    expect(parseSettingValue(f("enum", { options: [{ value: "a", label: "A" }] }), "a")).toEqual({ value: "a" });
    expect(parseSettingValue(f("enum", { options: [{ value: "a", label: "A" }] }), "b")).toHaveProperty("error");
    expect(parseSettingValue(f("string[]"), "a, b,,c")).toEqual({ value: ["a", "b", "c"] });
    expect(parseSettingValue(f("string"), "/usr/local/bin/claude")).toEqual({ value: "/usr/local/bin/claude" });
  });
});

describe("settingsLines", () => {
  const snapshot: SettingsSnapshot = {
    values: { "providers.claude.command": { value: "claude", source: "config" } },
    secrets: { ANTHROPIC_API_KEY: { set: true, source: "env-file" } },
    configPath: "/c",
    envPath: "/e",
  };
  test("a secret shows only whether it is set; an advanced field shows when filtered for", () => {
    const lines = settingsLines(SETTINGS_MANIFEST, snapshot, { filter: "claude" });
    expect(lines.some((l) => l.startsWith("providers.claude.command") && l.includes("claude") && l.includes("[config]"))).toBe(true);
    const secrets = settingsLines(SETTINGS_MANIFEST, snapshot, { filter: "ANTHROPIC_API_KEY" });
    expect(secrets[0]).toContain("(set)");
    expect(secrets.join("\n")).not.toContain("sk-");
  });
  test("advanced fields are left out of an unfiltered list unless asked for", () => {
    expect(settingsLines(SETTINGS_MANIFEST, snapshot).some((l) => l.startsWith("providers.claude.command"))).toBe(false);
    expect(settingsLines(SETTINGS_MANIFEST, snapshot, { advanced: true }).some((l) => l.startsWith("providers.claude.command"))).toBe(true);
  });
});

test("formatSettingValue and appliesNote", () => {
  expect(formatSettingValue(null)).toBe("(unset)");
  expect(formatSettingValue([])).toBe("(none)");
  expect(formatSettingValue(["a", "b"])).toBe("a, b");
  expect(appliesNote(field("providers.claude.command"), false)).toContain("restarts");
});
