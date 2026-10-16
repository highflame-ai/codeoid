/**
 * Hook bus types — codeoid's daemon-native hook layer.
 *
 * pi's in-process extension hooks (tool_call block/mutate, lifecycle) only
 * help pi sessions. The HookBus gives EVERY backend the same user-pluggable
 * extensibility, keyed by the provider-neutral events the daemon already
 * sees: a "block writes to .env" or "git-checkpoint per turn" rule applies
 * uniformly whether the session runs on claude, pi, gemini, or openai.
 *
 * Hooks are config-declared (`hooks.entries` in config.json) — no plugin
 * loading machinery. Two kinds in v1, both mirroring Claude Code's hook
 * contract so users can reuse mental models:
 *
 *   - `command`: spawn a shell command with the event JSON on stdin.
 *     Exit 0 → stdout may carry a JSON outcome; exit 2 → block (stderr is
 *     the reason); anything else → non-blocking failure (logged, hook
 *     ignored). An in-process JS plugin kind is deliberately NOT offered —
 *     that's a much bigger security surface; a future kind can add it.
 *   - `webhook`: POST the event JSON; a 2xx response body may carry the
 *     same JSON outcome. Non-2xx / network errors are non-blocking.
 *
 * Fail-open by design for INFRA failures (a crashed hook script must not
 * brick every session); blocking is always an EXPLICIT hook decision
 * (exit 2 or `{"decision":"block"}`).
 */

/** Events a hook entry can subscribe to. */
export const HOOK_EVENTS = [
  /** Before a tool executes. Can block or mutate the input. */
  "tool_call",
  /** After a tool completes. Can patch the recorded output (see bus docs). */
  "tool_result",
  /** A fresh turn is about to start. Can append to the system prompt. */
  "before_turn",
  /** A turn finished — carries the normalized result. Observe-only. */
  "after_turn",
  /** Session constructed (`source`: "new" | "resume"). Observe-only. */
  "session_start",
  /** Session destroyed. Observe-only. */
  "session_end",
  /** Backend switched mid-session. Observe-only. */
  "provider_switched",
  /** Backing context rotated. Observe-only. */
  "rotated",
  /**
   * A routine run finished (docs/routines.md). Observe-only. Carries the
   * routine, the run's outcome, summary, and cost — route it to Slack or a
   * pager with a `webhook` hook. Fires for every run, whatever the notify
   * policy; `notify` says whether the policy would push.
   */
  "routine_end",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** One configured hook — the shape of a `hooks.entries[]` item in config. */
export interface HookEntryConfig {
  event: HookEvent;
  /**
   * Regex matched against the tool name (tool_call / tool_result only).
   * Absent = every tool. Ignored for non-tool events.
   */
  matcher?: string;
  type: "command" | "webhook";
  /** Shell command (`/bin/sh -c`) — required when type is "command". */
  command?: string;
  /** POST target — required when type is "webhook". */
  url?: string;
  /** Per-hook wall-clock budget in ms. Default 10 000, capped at 60 000. */
  timeoutMs?: number;
  /** Display name for logs + info messages. Default `<type>:<event>`. */
  name?: string;
}

/** Session identity stamped on every hook payload. */
export interface HookSessionContext {
  sessionId: string;
  sessionName: string;
  workdir: string;
  providerId: string;
}

/**
 * Parsed hook response — the JSON a command prints on stdout (exit 0) or a
 * webhook returns in a 2xx body. Every field is optional; each dispatch
 * point honors only the fields that make sense for its event (a
 * `tool_call` hook's `updatedOutput` is ignored, etc.).
 */
export interface HookOutcome {
  /** `"block"` stops the action (tool_call only). */
  decision?: "block";
  /** Human-readable reason shown to the user on a block. */
  reason?: string;
  /** Replacement tool input (tool_call only) — replaces the input object. */
  updatedInput?: Record<string, unknown>;
  /** Replacement tool output (tool_result only). */
  updatedOutput?: string;
  /** Extra system-prompt text for the starting turn (before_turn only). */
  systemPromptAppend?: string;
}

/** Aggregate result of dispatching `tool_call` across matching hooks. */
export interface ToolCallHookResult {
  /** Set when a hook blocked the tool — short-circuits remaining hooks. */
  blocked?: { reason: string; hookName: string };
  /** Final input after every hook's mutation (absent = untouched). */
  updatedInput?: Record<string, unknown>;
  /** Names of hooks that mutated the input (for the info message). */
  mutatedBy: string[];
}
