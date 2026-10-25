/**
 * Usage-limit and rate-limit detection for failed turns (loop design §12.11).
 *
 * A loop controller must tell "the provider said wait" apart from "the work
 * failed": the first is an infrastructure error that consumes no attempt and
 * parks the run until a reset time, the second is evidence about the attempt.
 * This module is the one place that reads a backend's error text and decides.
 *
 * Two kinds, deliberately coarse:
 *
 *   - `usage_limit` — a plan or quota allowance is spent (Claude's 5-hour /
 *     weekly windows, Codex's plan limit, Gemini's daily quota, a billing
 *     quota). The remedy is to wait for the window to reset or to move to
 *     another account; the reset is typically hours away, sometimes unknown.
 *   - `rate_limit` — transient throttling or overload (HTTP 429 / 529,
 *     RESOURCE_EXHAUSTED with a short retry delay). The remedy is a short wait.
 *
 * CONSERVATIVE by design: a false positive would park a run whose work
 * actually failed, hiding a real failure behind a wait. Every rule below keys
 * on a shape a real backend emits — the source is cited beside it — and
 * ordinary errors (auth failures, context overflow, codeoid's own
 * "Concurrent session limit reached", a model mentioning "rate limiter")
 * classify as null. A generic phrase never matches on its own.
 *
 * `resetAt` is an epoch-milliseconds instant, present only when the error
 * itself says when the limit lifts (an epoch, a duration, or a wall-clock
 * time). It is sanity-bounded: a parsed time in the past or more than 35 days
 * out is dropped rather than trusted.
 */

export type UsageLimitKind = "usage_limit" | "rate_limit";

export interface UsageLimitClassification {
  kind: UsageLimitKind;
  /** Epoch ms at which the limit is expected to lift, when the error says. */
  resetAt?: number;
  /** Backend the shape identifies (or the caller's `opts.provider`). */
  provider?: string;
}

export interface ClassifyUsageLimitOptions {
  /** Reference "now" for relative and wall-clock reset times (tests). Default Date.now(). */
  now?: number;
  /** Backend id the error came from; wins over the one a shape implies. */
  provider?: string;
}

/**
 * The Claude Code CLI's "a usage limit was genuinely reached" messages — a
 * copy of the Agent SDK's `USAGE_LIMIT_ERROR_PREFIXES`
 * (node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts, SDK 0.3.281, "the
 * error-path outputs of getLimitReachedText (rateLimitMessages.ts)"). Copied
 * rather than imported because the export is `@alpha` and a usage-limit
 * check must not break on an SDK bump; usage-limit.test.ts fails if the two
 * drift. The CLI composes them as `You've hit your ${limit} · resets ${time}`
 * with limit ∈ {session limit, weekly limit, Opus limit, Sonnet limit, Fable
 * limit} (the CLI bundle's `_h` / `Ide` table). Codex uses the same opener:
 * "You've hit your usage limit. … Try again at 3:30 PM." (codex-rs 0.154.0
 * binary strings).
 */
export const CLAUDE_USAGE_LIMIT_PREFIXES: readonly string[] = [
  "You've hit your",
  "You've reached your",
  "You're out of usage credits",
  "Your org is out of usage · add funds to continue",
  "Your org is out of usage · contact your admin",
  "Your seat type doesn't include usage credits",
  "Your seat type doesn't include usage",
  "Your usage allocation has been disabled by your admin",
  "Your group's usage limit is set to $0",
  "Fable 5 requires usage credits",
  "You're out of extra usage",
  "Your seat type doesn't include extra usage",
];

/**
 * Openers too generic to trust alone ("You've hit your stride", "You've
 * reached your goal: the rate limit test passes"): the limit noun must follow
 * within four words, as in every completion the CLIs compose — "session
 * limit", "monthly spend limit", "team's shared budget", "usage limit".
 */
const GENERIC_PREFIXES = new Set(["You've hit your", "You've reached your"]);
const GENERIC_TAIL = /^\s+(?:[\w'-]+\s+){0,3}(?:limit|budget)\b/i;

/**
 * gemini-cli treats a quota error whose retry delay is at most this as
 * retryable, longer as terminal (`MAX_RETRYABLE_DELAY_SECONDS`, gemini-cli
 * 0.50.0 bundle, packages/core googleQuotaErrors). The same line splits
 * rate_limit from usage_limit here when only the delay tells them apart.
 */
const RETRYABLE_DELAY_MS = 300_000;

/** Plausible reset horizon: Claude's longest window is 7 days; a month of slack. */
const MAX_RESET_HORIZON_MS = 35 * 24 * 3600_000;

interface Rule {
  kind: UsageLimitKind;
  test: (text: string) => boolean;
  provider?: string;
}

const re = (pattern: RegExp, kind: UsageLimitKind, provider?: string): Rule => ({
  kind,
  test: (t) => pattern.test(t),
  ...(provider ? { provider } : {}),
});

/** Usage-limit shapes, checked before the rate-limit ones (a 429 carrying a usage text is a usage limit). */
const USAGE_RULES: readonly Rule[] = [
  // Claude Code before the "You've hit your" wording: `Claude AI usage limit
  // reached|<epoch seconds>` as the result text of a limited turn.
  re(/Claude AI usage limit reached/i, "usage_limit", "claude"),
  // Older and toast forms in the Claude CLI bundle: "5-hour limit reached ∙
  // resets 3pm", "Usage limit reached …". Only named windows — never
  // "Concurrent session limit reached" (codeoid) or "Context limit reached".
  re(/(?<![\w-])(?:5-hour|five-hour|weekly|daily|usage|opus|sonnet|fable) limit reached\b/i, "usage_limit"),
  // gemini-cli TerminalQuotaError: "You have exhausted your daily quota on
  // this model." (classifyGoogleError, gemini-cli 0.50.0).
  re(/exhausted your daily quota/i, "usage_limit", "gemini"),
  re(/\bTerminalQuotaError\b/, "usage_limit", "gemini"),
  // OpenAI billing quota (error code `insufficient_quota`); qwen-code checks
  // the same code with "free allocated quota exceeded" for DashScope
  // (@qwen-code/sdk 0.1.8 cli chunk, isQwenQuotaExceededError).
  re(/\binsufficient_quota\b/, "usage_limit"),
  re(/free allocated quota exceeded/i, "usage_limit", "qwen"),
  // DashScope's allocation-quota provider code (isAllocatedQuotaExceeded, same chunk).
  re(/\bThrottling\.AllocationQuota\b/, "usage_limit", "qwen"),
  // qwen-code's own OAuth quota message prefix (parseAndFormatApiError, same chunk).
  re(/Qwen OAuth quota exceeded/i, "usage_limit", "qwen"),
  // codex app-server's structured error info (`codexErrorInfo:
  // "usageLimitExceeded"`, `UsageLimitExceeded { resets_at }` in codex-rs).
  re(/\busageLimitExceeded\b|\bUsageLimitExceeded\b/, "usage_limit", "codex"),
];

/** Transient throttling / overload shapes. */
const RATE_RULES: readonly Rule[] = [
  // Anthropic API error types — `{"type":"error","error":{"type":"rate_limit_error"}}` (429)
  // and `overloaded_error` (529), as the SDK surfaces raw API errors.
  re(/\brate_limit_error\b/, "rate_limit", "claude"),
  re(/\boverloaded_error\b/, "rate_limit", "claude"),
  // Claude CLI after its own retries: "Repeated 529 Overloaded errors",
  // "API Error: Request rejected (429) · …", "Server is temporarily limiting
  // requests (not your usage limit)" (CLI bundle constants `QX`, `q$n`).
  re(/Repeated 529 Overloaded errors/i, "rate_limit", "claude"),
  re(/\b529\b[^\n]{0,24}\boverloaded\b/i, "rate_limit"),
  re(/Request rejected \(429\)/, "rate_limit", "claude"),
  re(/Server is temporarily limiting requests/i, "rate_limit", "claude"),
  // Google RPC status for quota/rate errors (@google/genai ApiError JSON body;
  // gemini-cli RetryableQuotaError; qwen-code's "(Status: RESOURCE_EXHAUSTED)").
  re(/\bRESOURCE_EXHAUSTED\b/, "rate_limit"),
  re(/\bRetryableQuotaError\b/, "rate_limit", "gemini"),
  re(/Quota exceeded for quota metric/i, "rate_limit"),
  // OpenAI-compatible APIs: "429 Rate limit reached for gpt-… Please try again
  // in 1.2s", "Too Many Requests", codex "exceeded retry limit, last status:
  // 429 Too Many Requests".
  re(/\brate[- ]limit(?:s|ed)?\s+(?:reached|exceeded|hit)\b/i, "rate_limit"),
  re(/\bToo Many Requests\b/i, "rate_limit"),
  re(/\b(?:status|code|HTTP)\s*[:=]?\s*429\b/i, "rate_limit"),
  re(/"code"\s*:\s*429\b/, "rate_limit"),
  re(/(?:^|[:\]\n]\s*)429\s+(?:\w+\s+){0,2}(?:rate|limit|quota|too many)/im, "rate_limit"),
  // codex's v2 `codexErrorInfo: "rateLimitExceeded"` (codex-rs 0.154.0).
  re(/\brateLimitExceeded\b/, "rate_limit", "codex"),
  // DashScope throttling codes other than the allocation quota (e.g. Throttling.RateQuota).
  re(/\bThrottling\.(?!AllocationQuota)\w+/, "rate_limit", "qwen"),
];

interface Signals {
  texts: string[];
  status?: number;
  retryDelayMs?: number;
  /** A reset instant the error carried as data (codex `resets_at`), epoch ms. */
  resetAtMs?: number;
}

function collect(input: unknown, out: Signals, depth: number): void {
  if (input == null || depth > 3) return;
  if (typeof input === "string") {
    if (input.length > 0) out.texts.push(input);
    return;
  }
  if (typeof input !== "object") return;
  const o = input as Record<string, unknown>;
  if (typeof o.message === "string" && o.message.length > 0) out.texts.push(o.message);
  // A class name carries meaning on its own (gemini-cli's TerminalQuotaError).
  if (typeof o.name === "string" && /QuotaError$/.test(o.name)) out.texts.push(o.name);
  for (const key of ["status", "statusCode", "code"] as const) {
    const v = o[key];
    if (out.status === undefined && (v === 429 || v === 529)) out.status = v;
  }
  // Machine codes: OpenAI's `code: "insufficient_quota"`, Anthropic's
  // `error.type: "rate_limit_error"`, Google's `status: "RESOURCE_EXHAUSTED"`.
  for (const key of ["code", "type", "status"] as const) {
    const v = o[key];
    if (typeof v === "string" && /^[A-Za-z][\w.]{2,63}$/.test(v)) out.texts.push(v);
  }
  if (out.retryDelayMs === undefined && typeof o.retryDelayMs === "number" && o.retryDelayMs > 0) {
    out.retryDelayMs = o.retryDelayMs;
  }
  // A structured reset: codex's `resets_at` / `resetsAt` (seconds or ms).
  if (out.resetAtMs === undefined) {
    const reset = [o.resetsAt, o.resets_at, o.resetAt].find((v): v is number => typeof v === "number" && v > 0);
    if (reset !== undefined) out.resetAtMs = toEpochMs(reset);
  }
  // codex: { codexErrorInfo: "usageLimitExceeded" } or { codexErrorInfo: { usageLimitExceeded: {...} } }.
  const info = o.codexErrorInfo;
  if (typeof info === "string") out.texts.push(info);
  else if (info && typeof info === "object") {
    for (const [variant, fields] of Object.entries(info as Record<string, unknown>)) {
      out.texts.push(variant);
      if (fields && typeof fields === "object") collect(fields, out, depth + 1);
    }
  }
  if (o.error !== undefined && o.error !== input) collect(o.error, out, depth + 1);
  if (o.cause !== undefined && o.cause !== input) collect(o.cause, out, depth + 1);
}

/** Normalize separators and apostrophes the CLIs render with typographic glyphs. */
function normalize(text: string): string {
  return text.replace(/[‘’ʼ]/g, "'").replace(/[∙•]/g, "·");
}

function prefixRule(text: string): boolean {
  for (const prefix of CLAUDE_USAGE_LIMIT_PREFIXES) {
    // At the start, or right after a wrapper's colon/bracket/newline
    // ("codex: You've hit…", "Error: You've hit…", "[API Error: You've…").
    const at = new RegExp(`(?:^|[:\\]\\n]\\s*)${escapeRegExp(prefix)}`).exec(text);
    if (!at) continue;
    if (!GENERIC_PREFIXES.has(prefix)) return true;
    if (GENERIC_TAIL.test(text.slice(at.index + at[0].length))) return true;
  }
  return false;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Classify a failed turn's error — an Error, a provider error object, or the
 * error text — as a usage limit, a rate limit, or neither (null).
 */
export function classifyUsageLimit(
  input: unknown,
  opts: ClassifyUsageLimitOptions = {},
): UsageLimitClassification | null {
  const signals: Signals = { texts: [] };
  collect(input, signals, 0);
  const text = normalize(signals.texts.join("\n"));
  const now = opts.now ?? Date.now();

  let kind: UsageLimitKind | undefined;
  let provider: string | undefined;
  const usage = USAGE_RULES.find((r) => r.test(text));
  if (usage) {
    kind = "usage_limit";
    provider = usage.provider;
  } else if (prefixRule(text)) {
    kind = "usage_limit";
    provider = /\bcodex\b/i.test(text) ? "codex" : undefined;
  } else if (/You exceeded your current quota/i.test(text)) {
    // OpenAI's billing quota and Gemini's free-tier per-minute quota share
    // this sentence; Gemini's says "Please retry in 41s". A short delay is a
    // throttle, anything else (or none) a spent allowance.
    const delay = signals.retryDelayMs ?? relativeDelayMs(text);
    kind = delay !== undefined && delay <= RETRYABLE_DELAY_MS && !/\bdaily\b|PerDay/i.test(text) ? "rate_limit" : "usage_limit";
  } else {
    const rate = RATE_RULES.find((r) => r.test(text));
    if (rate) {
      kind = "rate_limit";
      provider = rate.provider;
    } else if (signals.status !== undefined) {
      kind = "rate_limit";
    }
  }
  if (!kind) return null;

  // A "Quota exceeded for quota metric … per day" Google error is a daily allowance.
  if (kind === "rate_limit" && /Quota exceeded for quota metric/i.test(text) && /per ?day|PerDay|daily/i.test(text)) {
    kind = "usage_limit";
  }

  const resetAt = parseResetAt(text, now, signals);
  const resolvedProvider = opts.provider ?? provider;
  return {
    kind,
    ...(resetAt !== undefined ? { resetAt } : {}),
    ...(resolvedProvider ? { provider: resolvedProvider } : {}),
  };
}

/**
 * Classify text the CLI may have written AS the turn's reply — Claude's result
 * text on an errored turn, or the turn's last assistant message — with the
 * CLI-shaped rules only. That text can just as well be the model's own words
 * ("the API returned 429 Too Many Requests twice, so I added retries"), so the
 * generic rate-limit / 429 / quota rules never apply. A notice counts only
 * when the text — or its last block — OPENS with what the CLI composes:
 *
 *   - one of the SDK's USAGE_LIMIT_ERROR_PREFIXES (the generic openers still
 *     need a limit word on their first line), or the legacy
 *     "Claude AI usage limit reached";
 *   - "API Error:" — the CLI's prefix for an API failure it reports as the
 *     reply — after which the full classifier reads the rest.
 */
export function classifyCliNotice(
  text: string | null | undefined,
  opts: ClassifyUsageLimitOptions = {},
): UsageLimitClassification | null {
  if (!text) return null;
  const whole = cliNotice(normalize(text).trimStart(), opts);
  if (whole) return whole;
  // A turn that wrote something before the limit hit ends with the notice as
  // its own last block: "I'll start with the tests.\n\nYou've hit your…".
  const blocks = normalize(text).split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  return blocks.length > 1 ? cliNotice(blocks[blocks.length - 1]!, opts) : null;
}

function cliNotice(t: string, opts: ClassifyUsageLimitOptions): UsageLimitClassification | null {
  if (/^API Error:/.test(t)) return classifyUsageLimit(t, opts);
  if (/^Claude AI usage limit reached/i.test(t) || startsWithLimitPrefix(t)) {
    const now = opts.now ?? Date.now();
    const resetAt = parseResetAt(t, now, { texts: [t] });
    const provider = opts.provider ?? (t.startsWith("Claude AI") ? "claude" : undefined);
    return { kind: "usage_limit", ...(resetAt !== undefined ? { resetAt } : {}), ...(provider ? { provider } : {}) };
  }
  return null;
}

function startsWithLimitPrefix(t: string): boolean {
  for (const prefix of CLAUDE_USAGE_LIMIT_PREFIXES) {
    if (!t.startsWith(prefix)) continue;
    if (!GENERIC_PREFIXES.has(prefix)) return true;
    if (GENERIC_TAIL.test(t.slice(prefix.length))) return true;
  }
  return false;
}

// ── Reset time ────────────────────────────────────────────────────────────────

const UNIT_MS: Record<string, number> = {
  ms: 1, millisecond: 1, milliseconds: 1,
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3600_000, hr: 3600_000, hrs: 3600_000, hour: 3600_000, hours: 3600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
};
const DURATION_PART = /(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/gi;

/** A delay the text states relative to now: "try again in 1.5s", "resets in 2h 30m", "Retry-After: 30". */
function relativeDelayMs(text: string): number | undefined {
  const lead = /(?:resets?|try again|retry|available again)\s+(?:in|after)\s+((?:\d+(?:\.\d+)?\s*[a-z]+[\s,]*(?:and\s+)?){1,4})/i.exec(text);
  if (lead?.[1]) {
    let total = 0;
    let matched = false;
    for (const m of lead[1].matchAll(DURATION_PART)) {
      const unit = UNIT_MS[m[2]!.toLowerCase()];
      if (unit === undefined) continue;
      total += Number(m[1]) * unit;
      matched = true;
    }
    if (matched && total > 0) return Math.round(total);
  }
  const retryAfter = /\bRetry-After:\s*(\d+)\b/i.exec(text);
  if (retryAfter) return Number(retryAfter[1]) * 1000;
  // Google RetryInfo: "retryDelay": "41s".
  const retryInfo = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)(ms|s)"/.exec(text);
  if (retryInfo) return Number(retryInfo[1]) * (retryInfo[2] === "ms" ? 1 : 1000);
  return undefined;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * A wall-clock reset: the Claude CLI's "resets 3pm (America/Los_Angeles)" /
 * "resets Oct 28, 9am (UTC)" / "resets Oct 28, 2027, 9:30am" (its `Yc`
 * formatter: en-US time, lower-cased am/pm, the zone in parentheses) and
 * Codex's "Try again at 3:30 PM." / "try again at Oct 28th, 2026 3:30 PM."
 * (codex-rs `%-I:%M %p` / `%b %-d, %Y %-I:%M %p`, local time), and
 * gemini-cli's "Access resets at 3:30 PM PDT." (getResetTimeMessage, gemini-cli
 * 0.50.0 interactiveCli bundle: en-US `hour: numeric, minute: 2-digit,
 * timeZoneName: short` in the host zone). A short zone name ("PDT") is not a
 * zone id and is ignored: these CLIs run on the daemon's host, so host time is
 * the zone they printed in. Only a parenthesized IANA id (Claude's) is applied.
 */
const CLOCK =
  /(?:resets?(?:\s+at)?|try again at)\s+(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4}),?\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m\.?(?:\s*\(([^)]+)\))?/i;

function clockResetAt(text: string, now: number): number | undefined {
  const m = CLOCK.exec(text);
  if (!m) return undefined;
  const [, mon, day, year, hourText, minuteText, ampm, zone] = m;
  let hour = Number(hourText);
  if (hour < 1 || hour > 12) return undefined;
  if (ampm!.toLowerCase() === "p" && hour !== 12) hour += 12;
  if (ampm!.toLowerCase() === "a" && hour === 12) hour = 0;
  const minute = minuteText ? Number(minuteText) : 0;
  if (minute > 59) return undefined;
  const tz = zone && isTimeZone(zone.trim()) ? zone.trim() : undefined;
  const today = calendarDate(now, tz);

  if (mon) {
    const month = MONTHS[mon.toLowerCase()]!;
    const date = Number(day);
    let y = year ? Number(year) : today.year;
    let at = wallToEpoch(y, month, date, hour, minute, tz);
    // "Oct 28" with no year, seen in early January, is next October's.
    if (!year && at < now - 86_400_000) at = wallToEpoch(++y, month, date, hour, minute, tz);
    return at;
  }
  let at = wallToEpoch(today.year, today.month, today.day, hour, minute, tz);
  // A bare time already passed today means tomorrow (the CLI prints a date only beyond 24h).
  if (at <= now - 60_000) at = wallToEpoch(today.year, today.month, today.day + 1, hour, minute, tz);
  return at;
}

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Calendar parts of `instant` in `tz` (the host zone when undefined). */
function calendarDate(instant: number, tz: string | undefined): { year: number; month: number; day: number } {
  if (!tz) {
    const d = new Date(instant);
    return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate() };
  }
  const p = zonedParts(instant, tz);
  return { year: p.year, month: p.month, day: p.day };
}

function zonedParts(instant: number, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((x) => x.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month") - 1, day: get("day"), hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}

/** Epoch ms of a wall-clock time in `tz` (host zone when undefined). Day overflow normalizes. */
function wallToEpoch(year: number, month: number, day: number, hour: number, minute: number, tz: string | undefined): number {
  if (!tz) return new Date(year, month, day, hour, minute).getTime();
  const asUtc = Date.UTC(year, month, day, hour, minute);
  const offset = (instant: number) => {
    const p = zonedParts(instant, tz);
    return Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second) - Math.floor(instant / 1000) * 1000;
  };
  // Two passes settle the offset across a DST boundary.
  let at = asUtc - offset(asUtc);
  const second = asUtc - offset(at);
  if (second !== at) at = second;
  return at;
}

function parseResetAt(text: string, now: number, signals: Signals): number | undefined {
  const { retryDelayMs } = signals;
  // Data beats prose: an instant the error carried as a field is exact.
  const candidates: Array<number | undefined> = [signals.resetAtMs];
  // Claude's legacy `Claude AI usage limit reached|1730000000`.
  const legacy = /usage limit reached\|(\d{9,13})/i.exec(text);
  if (legacy) candidates.push(toEpochMs(Number(legacy[1])));
  // A structured reset in a JSON payload: codex `resets_at`, `resetsAt`.
  const field = /"?(?:resets?_?[aA]t)"?\s*[:=]\s*(\d{9,13})\b/.exec(text);
  if (field) candidates.push(toEpochMs(Number(field[1])));
  if (retryDelayMs !== undefined) candidates.push(now + retryDelayMs);
  const delay = relativeDelayMs(text);
  if (delay !== undefined) candidates.push(now + delay);
  candidates.push(clockResetAt(text, now));
  for (const at of candidates) {
    if (at !== undefined && Number.isFinite(at) && at > now - 60_000 && at <= now + MAX_RESET_HORIZON_MS) return at;
  }
  return undefined;
}

/** Seconds or milliseconds since the epoch → milliseconds. */
function toEpochMs(n: number): number {
  return n < 1e12 ? n * 1000 : n;
}
