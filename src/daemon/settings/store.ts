/**
 * Settings store — reads the current effective configuration and applies
 * changes back to disk, driven entirely by the manifest.
 *
 * Read model (`getSnapshot`): effective values follow the daemon's own
 * precedence — env override > config.json > manifest default. Secret VALUES
 * are never read out; only presence + provenance.
 *
 * Write model (`applyPatches`): config-backed patches are merged onto the raw
 * config.json and the WHOLE object is validated against the authoritative zod
 * schema — one bad patch rejects the batch and nothing is written. Env-backed
 * patches (all secrets included) update `.env`. Every write is atomic
 * (temp + rename); `.env` is chmod 0600. `process.env` is updated live so a
 * `settings.get` immediately reflects the change and per-session env knobs
 * apply to new sessions without a restart.
 */

import { existsSync, readFileSync } from "node:fs";
import { atomicWrite, configFilePaths, validateConfigObject } from "../../config.js";
import { fieldByKey, manifestFields, SETTINGS_MANIFEST } from "./manifest.js";
import type {
  SecretStatus,
  SettingError,
  SettingField,
  SettingKind,
  SettingPatch,
  SettingsManifest,
  SettingsSnapshot,
  SettingState,
  SettingValue,
} from "../../protocol/types.js";

export function getManifest(): SettingsManifest {
  return SETTINGS_MANIFEST;
}

// ── Read ──────────────────────────────────────────────────────────────────────

export function getSnapshot(): SettingsSnapshot {
  const { configPath, envPath } = configFilePaths();
  let raw: Record<string, unknown> = {};
  try {
    raw = readRawConfig();
  } catch {
    // A malformed config.json shouldn't blank the whole page — fall back to
    // defaults for display. `applyPatches` surfaces the parse error loudly.
    raw = {};
  }
  const dotenvKeys = readDotEnvKeys(envPath);

  const values: Record<string, SettingState> = {};
  const secrets: Record<string, SecretStatus> = {};

  for (const f of manifestFields()) {
    if (f.secret) {
      secrets[f.key] = secretStatus(f, dotenvKeys);
      continue;
    }
    values[f.key] = f.backing === "config" ? configState(f, raw) : envState(f);
  }

  return { values, secrets, configPath, envPath };
}

function secretStatus(f: SettingField, dotenvKeys: Set<string>): SecretStatus {
  const key = f.envVar!;
  const set = isEnvSet(key);
  if (!set) return { set: false, source: "unset" };
  return { set: true, source: dotenvKeys.has(key) ? "env-file" : "external" };
}

/** Effective value + provenance for a config-backed field (env > file > default). */
function configState(f: SettingField, raw: Record<string, unknown>): SettingState {
  if (f.envVar) {
    const envVal = process.env[f.envVar];
    if (envVal !== undefined && envVal !== "") {
      return { value: parseTyped(envVal, f.kind), source: "env" };
    }
  }
  const rawVal = getByPath(raw, f.path!);
  if (rawVal !== undefined) return { value: normalizeConfigValue(rawVal, f.kind), source: "config" };
  return { value: defaultValue(f), source: "default" };
}

/** Effective value + provenance for an env-backed (non-secret) field. */
function envState(f: SettingField): SettingState {
  const envVal = process.env[f.envVar!];
  if (envVal !== undefined && envVal !== "") {
    return { value: parseTyped(envVal, f.kind), source: "env" };
  }
  return { value: defaultValue(f), source: f.default !== undefined ? "default" : "unset" };
}

// ── Write ───────────────────────────────────────────────────────────────────

export interface ApplyResult {
  ok: boolean;
  errors: SettingError[];
  restartRequired: boolean;
  snapshot: SettingsSnapshot;
}

export function applyPatches(patches: SettingPatch[]): ApplyResult {
  const errors: SettingError[] = [];
  const configPatches: { field: SettingField; value: SettingValue }[] = [];
  const envUpdates = new Map<string, string | null>(); // null = clear
  const written: SettingField[] = [];

  for (const p of patches) {
    const f = fieldByKey(p.key);
    if (!f) {
      errors.push({ key: p.key, message: "Unknown setting" });
      continue;
    }
    if (f.backing === "config") {
      configPatches.push({ field: f, value: p.value });
    } else {
      const formatted = formatForEnv(p.value, f.kind);
      // The .env format is single-line-per-key (matching loadDotEnv, which is
      // "intentionally minimal — no multiline"). A value carrying a newline
      // would split into a bogus second line and corrupt the file, so reject
      // it loudly rather than writing garbage.
      if (formatted !== null && /[\r\n]/.test(formatted)) {
        errors.push({ key: p.key, message: "Value must be a single line (no newlines)." });
        continue;
      }
      envUpdates.set(f.envVar!, formatted);
      written.push(f);
    }
  }

  // Reject the whole batch if any key was unrecognized — nothing written.
  if (errors.length > 0) {
    return { ok: false, errors, restartRequired: false, snapshot: getSnapshot() };
  }

  // Config patches: merge onto the raw object, validate the WHOLE thing, then
  // write atomically. A validation failure rejects the batch (no partial write).
  if (configPatches.length > 0) {
    let raw: Record<string, unknown>;
    try {
      raw = readRawConfig();
    } catch (err) {
      return {
        ok: false,
        errors: [{ key: "", message: `config.json is not valid JSON: ${errMsg(err)}` }],
        restartRequired: false,
        snapshot: getSnapshot(),
      };
    }
    for (const { field, value } of configPatches) {
      const coerced = coerceForConfig(value, field.kind);
      if (coerced === undefined) deleteByPath(raw, field.path!);
      else setByPath(raw, field.path!, coerced);
    }
    const validation = validateConfigObject(raw);
    if (!validation.ok) {
      for (const issue of validation.issues) {
        errors.push({ key: keyForIssuePath(issue.path, configPatches), message: issue.message });
      }
      return { ok: false, errors, restartRequired: false, snapshot: getSnapshot() };
    }
    writeConfigJson(raw);
    for (const c of configPatches) written.push(c.field);
  }

  // Env patches: update .env + process.env live.
  if (envUpdates.size > 0) {
    writeDotEnv(envUpdates);
    for (const [k, v] of envUpdates) {
      if (v === null) delete process.env[k];
      else process.env[k] = v;
    }
  }

  const restartRequired = written.some((f) => f.applies === "restart");
  return { ok: true, errors: [], restartRequired, snapshot: getSnapshot() };
}

/**
 * The config.json object and environment the NEXT boot would see if these
 * patches were applied — computed, never written. Lets the caller check a
 * write against rules that only run at startup (a default backend the next
 * boot would refuse) before committing it.
 *
 * Returns undefined when the batch can't be previewed (an unknown key, an
 * unreadable config.json): `applyPatches` rejects those with its own errors.
 */
export function previewPatches(
  patches: SettingPatch[],
): { raw: Record<string, unknown>; env: Record<string, string | undefined> } | undefined {
  let raw: Record<string, unknown>;
  try {
    raw = readRawConfig();
  } catch {
    return undefined;
  }
  const env: Record<string, string | undefined> = { ...process.env };
  for (const p of patches) {
    const f = fieldByKey(p.key);
    if (!f) return undefined;
    if (f.backing === "config") {
      const coerced = coerceForConfig(p.value, f.kind);
      if (coerced === undefined) deleteByPath(raw, f.path!);
      else setByPath(raw, f.path!, coerced);
    } else {
      const formatted = formatForEnv(p.value, f.kind);
      if (formatted === null) delete env[f.envVar!];
      else env[f.envVar!] = formatted;
    }
  }
  return { raw, env };
}

// ── config.json IO ──────────────────────────────────────────────────────────

function readRawConfig(): Record<string, unknown> {
  const { configPath } = configFilePaths();
  if (!existsSync(configPath)) return {};
  const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("config.json must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function writeConfigJson(obj: Record<string, unknown>): void {
  const { configPath } = configFilePaths();
  atomicWrite(configPath, `${JSON.stringify(obj, null, 2)}\n`, 0o600);
}

// ── .env IO ───────────────────────────────────────────────────────────────────

/** Keys explicitly defined in the .env file (regardless of whether they won at boot). */
function readDotEnvKeys(envPath: string): Set<string> {
  const keys = new Set<string>();
  if (!existsSync(envPath)) return keys;
  let text: string;
  try {
    text = readFileSync(envPath, "utf8");
  } catch {
    return keys;
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) keys.add(key);
  }
  return keys;
}

/**
 * Apply KEY=value updates to the .env file, preserving comments, blank lines,
 * and unrelated keys. A `null` value removes the key's line. Written atomically
 * with 0600 perms (it holds secrets).
 */
function writeDotEnv(updates: Map<string, string | null>): void {
  const { envPath } = configFilePaths();
  const remaining = new Map(updates);
  const out: string[] = [];

  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  for (const rawLine of existing.split("\n")) {
    const line = rawLine.trim();
    const eq = line.indexOf("=");
    const key = eq > 0 && !line.startsWith("#") ? line.slice(0, eq).trim() : null;
    if (key !== null && remaining.has(key)) {
      const value = remaining.get(key)!;
      remaining.delete(key);
      if (value !== null) out.push(`${key}=${quoteEnv(value)}`);
      // value === null → drop the line (cleared)
    } else {
      out.push(rawLine);
    }
  }
  // Append keys not already present.
  for (const [key, value] of remaining) {
    if (value !== null) out.push(`${key}=${quoteEnv(value)}`);
  }

  // Normalize to a single trailing newline, no leading blank noise.
  const text = `${out.join("\n").replace(/\n+$/, "")}\n`;
  atomicWrite(envPath, text, 0o600);
}

/**
 * Wrap an env value in double quotes when the raw form would be re-trimmed or
 * misread (surrounding whitespace, a `#`, an embedded quote, or empty).
 *
 * Deliberately does NOT escape anything: `loadDotEnv` strips exactly one
 * surrounding quote pair and never unescapes, so escaping would break the
 * round-trip (`a"b` → `"a\"b"` → loader yields `a\"b`). Because only the
 * OUTER pair is stripped, an embedded quote still round-trips as-is
 * (`a"b` → `"a"b"` → `a"b`). Callers guarantee the value is single-line.
 */
function quoteEnv(value: string): string {
  if (value === "") return '""';
  if (/[\s#"']/.test(value)) return `"${value}"`;
  return value;
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function isEnvSet(key: string): boolean {
  const v = process.env[key];
  return v !== undefined && v !== "";
}

function defaultValue(f: SettingField): SettingValue {
  return f.default !== undefined ? (f.default as SettingValue) : null;
}

/** Parse a raw env-var string into the field's typed value. */
function parseTyped(raw: string, kind: SettingKind): SettingValue {
  switch (kind) {
    case "boolean":
      return raw === "1" || raw.toLowerCase() === "true";
    case "int": {
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) ? n : null;
    }
    case "float": {
      const n = Number.parseFloat(raw);
      return Number.isFinite(n) ? n : null;
    }
    case "string[]":
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    default:
      return raw;
  }
}

/** Normalize a value read from config.json JSON to the field's kind. */
function normalizeConfigValue(raw: unknown, kind: SettingKind): SettingValue {
  if (kind === "string[]") {
    if (Array.isArray(raw)) return raw.map((x) => String(x));
    return [];
  }
  if (kind === "boolean") return Boolean(raw);
  if (kind === "int" || kind === "float") {
    return typeof raw === "number" ? raw : Number(raw);
  }
  if (raw === null || raw === undefined) return null;
  return typeof raw === "string" ? raw : String(raw);
}

/**
 * Coerce a client-supplied value to the shape config.json expects.
 * Returns `undefined` to signal "clear this key" (null or empty string).
 */
function coerceForConfig(value: SettingValue, kind: SettingKind): unknown {
  if (value === null) return undefined;
  switch (kind) {
    case "boolean":
      return typeof value === "boolean" ? value : value === "true" || value === "1";
    case "int":
    case "float":
      return typeof value === "number" ? value : Number(value);
    case "string[]":
      if (Array.isArray(value)) return value;
      return String(value)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    default: {
      const s = String(value);
      return s === "" ? undefined : s;
    }
  }
}

/**
 * Format a client-supplied value for a .env line. Returns `null` to clear the
 * key (null value, or an empty string / empty array).
 */
function formatForEnv(value: SettingValue, kind: SettingKind): string | null {
  if (value === null) return null;
  if (kind === "string[]") {
    const arr = Array.isArray(value) ? value : String(value).split(",");
    const joined = arr.map((s) => String(s).trim()).filter((s) => s.length > 0).join(",");
    return joined.length > 0 ? joined : null;
  }
  if (kind === "boolean") {
    const b = typeof value === "boolean" ? value : value === "true" || value === "1";
    return b ? "true" : "false";
  }
  const s = String(value);
  return s === "" ? null : s;
}

/** Map a zod issue path back to the manifest key of the patch that touched it. */
function keyForIssuePath(
  issuePath: string,
  configPatches: { field: SettingField }[],
): string {
  const match = configPatches.find(
    (c) => c.field.path === issuePath || issuePath.startsWith(`${c.field.path}.`),
  );
  return match?.field.key ?? issuePath;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── dotted-path get/set/delete (config.json is a plain nested object) ──────────

function getByPath(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    const next = cur[k];
    if (next === null || next === undefined || typeof next !== "object" || Array.isArray(next)) {
      const created: Record<string, unknown> = {};
      cur[k] = created;
      cur = created;
    } else {
      cur = next as Record<string, unknown>;
    }
  }
  cur[parts[parts.length - 1]!] = value;
}

function deleteByPath(obj: Record<string, unknown>, path: string): void {
  const parts = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]!];
    if (next === null || typeof next !== "object") return;
    cur = next as Record<string, unknown>;
  }
  delete cur[parts[parts.length - 1]!];
}
