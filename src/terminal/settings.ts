/**
 * `codeoid settings`: the settings drawer from a terminal. The same manifest
 * and the same `settings.get` / `settings.set` messages the web UI uses, so
 * the daemon decides what may change, who may change it, and when it applies.
 */
import type { SettingField, SettingValue, SettingsManifest, SettingsSnapshot } from "../protocol/types.js";

/** Every field, with the tab it is on. */
export function settingFields(manifest: SettingsManifest): Array<{ tab: string; field: SettingField }> {
  return manifest.tabs.flatMap((t) => t.groups.flatMap((g) => g.fields.map((field) => ({ tab: t.title, field }))));
}

/** The field for `key`, or a message naming the closest keys. */
export function findField(manifest: SettingsManifest, key: string): SettingField | string {
  const all = settingFields(manifest).map((f) => f.field);
  const hit = all.find((f) => f.key === key);
  if (hit) return hit;
  const near = all.filter((f) => f.key.toLowerCase().includes(key.toLowerCase())).slice(0, 5);
  return `No setting "${key}".${near.length ? ` Did you mean: ${near.map((f) => f.key).join(", ")}?` : " List them with: codeoid settings ls"}`;
}

/** `raw` as the value `field` takes; a string is a problem with it. */
export function parseSettingValue(field: SettingField, raw: string): { value: SettingValue } | { error: string } {
  switch (field.kind) {
    case "boolean": {
      const v = raw.trim().toLowerCase();
      if (["true", "on", "yes", "1"].includes(v)) return { value: true };
      if (["false", "off", "no", "0"].includes(v)) return { value: false };
      return { error: `${field.key} is on or off: give true or false` };
    }
    case "int":
    case "float": {
      const n = Number(raw.trim());
      if (raw.trim() === "" || !Number.isFinite(n) || (field.kind === "int" && !Number.isInteger(n))) return { error: `${field.key} takes ${field.kind === "int" ? "a whole number" : "a number"}` };
      if (field.min !== undefined && n < field.min) return { error: `${field.key} is at least ${field.min}` };
      if (field.max !== undefined && n > field.max) return { error: `${field.key} is at most ${field.max}` };
      return { value: n };
    }
    case "enum": {
      const options = field.options ?? [];
      if (!options.some((o) => o.value === raw)) return { error: `${field.key} is one of: ${options.map((o) => o.value).join(", ")}` };
      return { value: raw };
    }
    case "string[]":
      return { value: raw.split(",").map((s) => s.trim()).filter(Boolean) };
    default:
      return { value: raw };
  }
}

/** A value as one line. */
export function formatSettingValue(value: SettingValue | undefined): string {
  if (value === null || value === undefined || value === "") return "(unset)";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "(none)";
  return String(value);
}

/** One line per field: key, value, where it comes from. `filter` matches a key, label or tab. */
export function settingsLines(manifest: SettingsManifest, snapshot: SettingsSnapshot, opts: { filter?: string; advanced?: boolean } = {}): string[] {
  const f = opts.filter?.toLowerCase();
  const rows = settingFields(manifest).filter(({ tab, field }) => {
    if (!opts.advanced && field.advanced && !f) return false;
    return !f || field.key.toLowerCase().includes(f) || field.label.toLowerCase().includes(f) || tab.toLowerCase().includes(f);
  });
  const width = Math.min(48, Math.max(0, ...rows.map((r) => r.field.key.length)));
  return rows.map(({ field }) => {
    if (field.secret || field.kind === "secret") {
      const s = snapshot.secrets[field.key];
      return `${field.key.padEnd(width)}  ${s?.set ? "(set)" : "(unset)"}${s?.set ? `  [${s.source}]` : ""}`;
    }
    const state = snapshot.values[field.key];
    return `${field.key.padEnd(width)}  ${formatSettingValue(state?.value)}  [${state?.source ?? "unset"}]`;
  });
}

/** What a written change needs before it applies. */
export function appliesNote(field: SettingField, restartRequired: boolean): string {
  if (restartRequired || field.applies === "restart") return "Applies once the daemon restarts.";
  if (field.applies === "next-session") return "Applies to new sessions.";
  return "Applied.";
}
