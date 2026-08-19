/**
 * Repeat-tool guard — an advisory loop-breaker.
 *
 * Prior art: DeepSeek Harness `dsh-repeat-tool-reminder`
 * (docs/prior-art-deepseek-harness.md §3.7 / §4.3). Their framing is the right
 * one and is preserved here: this is NOT a model-facing tool. It never appears
 * in the tool list, never vetoes a call, never rewrites arguments, and never
 * delays anything. It adds exactly one behaviour — it watches each agent's
 * stream of tool calls, counts runs of consecutive calls to the same tool with
 * identical canonicalised arguments, and at configured run lengths injects an
 * escalating advisory telling the model to stop repeating itself, re-read the
 * last result, and either change approach or conclude.
 *
 * The decision (retry differently, gather more evidence, or finish) stays
 * entirely with the model. A legitimately repeated call is blocked by nothing.
 *
 * Why codeoid wants it: unattended work — `dispatch` workers and conductor-
 * spawned sessions — has no human watching the transcript. A model wedged on
 * `Read(same file)` or `Bash(same failing command)` burns the tool budget to
 * zero and reports failure with no diagnosis. The budget caps the damage; this
 * catches the cause while the turn can still recover.
 *
 * Two deliberate adaptations from dsh's version:
 *
 *  - **Chains are keyed per emitting agent**, because codeoid's `tool_start`
 *    carries `sdkAgentId` for subagent calls. Two subagents hammering the same
 *    tool in parallel are two independent chains, not one interleaved mess that
 *    resets constantly and never fires.
 *  - **Pattern matching is case-insensitive**, because codeoid is multi-backend
 *    and the same logical tool is `TodoWrite` on Claude and `todo_write`
 *    elsewhere. A single default exclude list has to cover both spellings.
 *
 * This module is pure: no I/O, no clock, no daemon imports. All state is the
 * per-chain counters held in the instance.
 */

/** Tuning for the repeat-tool guard. See `DEFAULT_REPEAT_TOOL_CONFIG`. */
export interface RepeatToolGuardConfig {
  /** Master switch. */
  enabled: boolean;
  /**
   * Consecutive-run lengths that trigger a reminder, e.g. `[3, 5, 8]`. The
   * FIRST threshold delivers a short generic nudge; every later threshold
   * delivers the detailed form naming the tool, the run length, and the
   * canonical arguments.
   */
  thresholds: readonly number[];
  /** Tool-name patterns to track (`*` wildcard). Empty ⇒ track everything. */
  include: readonly string[];
  /** Tool-name patterns transparent to the chain (`*` wildcard). */
  exclude: readonly string[];
  /**
   * Cap on the arguments quoted in the detailed reminder. Bounds only the
   * reminder text — the chain key always compares the FULL canonical string,
   * so a looping `Write`/`Edit` payload can neither defeat detection nor ride
   * into the next request unbounded.
   */
  argumentsPreviewChars: number;
}

export const DEFAULT_REPEAT_TOOL_CONFIG: RepeatToolGuardConfig = {
  enabled: true,
  thresholds: [3, 5, 8],
  include: [],
  // Todo bookkeeping is legitimately called repeatedly with near-identical
  // input and is never the tool a session is wedged on. Both spellings, since
  // backends disagree.
  exclude: ["TodoWrite", "todo_write"],
  argumentsPreviewChars: 500,
};

/** One advisory the guard wants injected before the model's next request. */
export interface RepeatToolReminder {
  /** Tool the chain is stuck on. */
  toolName: string;
  /** Consecutive identical calls observed, including the one that fired this. */
  runLength: number;
  /** Which configured threshold fired. */
  threshold: number;
  /** True for the first threshold — the short generic nudge. */
  brief: boolean;
  /** Model-facing advisory text, ready to inject. */
  text: string;
}

/** The primary agent's chain id, used when a `tool_start` carries no agent. */
export const PRIMARY_CHAIN = "primary";

/**
 * Deep key-sort + `JSON.stringify`, so argument objects differing only in
 * property order count as identical. Arrays keep their order (order is
 * meaningful in a tool argument list); only object keys are sorted.
 *
 * Tool inputs originate as JSON so cycles are not expected, but a provider
 * handing us a live object graph must not crash the event consumer — an
 * unserialisable input yields `null`, which the caller treats as "not
 * trackable" rather than as a chain key that might collide.
 */
export function canonicalizeArguments(input: unknown): string | null {
  const sortDeep = (value: unknown, seen: Set<object>): unknown => {
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value as object)) return "[circular]";
    seen.add(value as object);
    try {
      if (Array.isArray(value)) return value.map((v) => sortDeep(v, seen));
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out[key] = sortDeep((value as Record<string, unknown>)[key], seen);
      }
      return out;
    } finally {
      seen.delete(value as object);
    }
  };
  try {
    const canonical = JSON.stringify(sortDeep(input, new Set()));
    // `undefined` input stringifies to undefined, not a string.
    return canonical ?? null;
  } catch {
    return null;
  }
}

/**
 * Case-insensitive glob match supporting `*` only. Patterns are predicates
 * over whatever tools exist at call time, NOT references to a registry — a
 * pattern matching no currently registered tool is not an error, so
 * `exclude: ["mcp__*"]` stays valid in a session that mounts no MCP servers.
 */
export function matchesToolPattern(toolName: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(toolName);
}

/**
 * Validate and normalise config. Fails loud rather than silently falling back
 * to defaults — a typo'd threshold list is a configuration bug, and silently
 * ignoring it means the guard never fires and nobody finds out until a worker
 * has burned its budget in a loop.
 *
 * @throws when thresholds are empty, non-integer, below 2, or duplicated, or
 *         when `argumentsPreviewChars` is not a positive integer.
 */
export function normalizeRepeatToolConfig(
  config: Partial<RepeatToolGuardConfig> = {},
): RepeatToolGuardConfig {
  const merged = { ...DEFAULT_REPEAT_TOOL_CONFIG, ...config };
  const thresholds = [...merged.thresholds];

  if (thresholds.length === 0) {
    throw new Error("guard.repeatTool.thresholds must not be empty");
  }
  for (const t of thresholds) {
    if (!Number.isInteger(t)) {
      throw new Error(`guard.repeatTool.thresholds must be integers (got ${t})`);
    }
    // A threshold of 1 would fire on every first call — that is not a repeat.
    if (t < 2) {
      throw new Error(`guard.repeatTool.thresholds must be >= 2 (got ${t})`);
    }
  }
  if (new Set(thresholds).size !== thresholds.length) {
    throw new Error(`guard.repeatTool.thresholds must not contain duplicates (got ${thresholds.join(", ")})`);
  }
  if (
    !Number.isInteger(merged.argumentsPreviewChars) ||
    merged.argumentsPreviewChars < 1
  ) {
    throw new Error(
      `guard.repeatTool.argumentsPreviewChars must be an integer >= 1 (got ${merged.argumentsPreviewChars})`,
    );
  }

  thresholds.sort((a, b) => a - b);
  return { ...merged, thresholds };
}

/** Per-chain state: what the last tracked call was, and how many in a row. */
interface Chain {
  key: string;
  toolName: string;
  canonicalArgs: string;
  count: number;
}

/**
 * Tracks consecutive-identical tool calls per agent and yields reminders.
 *
 * Lifecycle: one instance per Session. `observe()` on every `tool_start`,
 * `resetChain()` when real owner input arrives (a redirect invalidates the
 * run), and `forget()` when a subagent stops so its chain doesn't leak.
 */
export class RepeatToolGuard {
  readonly config: RepeatToolGuardConfig;
  readonly #chains = new Map<string, Chain>();

  constructor(config: Partial<RepeatToolGuardConfig> = {}) {
    this.config = normalizeRepeatToolConfig(config);
  }

  /** Is this tool tracked at all? `include` empty ⇒ everything but `exclude`. */
  #tracks(toolName: string): boolean {
    if (this.config.exclude.some((p) => matchesToolPattern(toolName, p))) return false;
    if (this.config.include.length === 0) return true;
    return this.config.include.some((p) => matchesToolPattern(toolName, p));
  }

  /**
   * Record one tool call and return a reminder when the run length just hit a
   * configured threshold, else `null`.
   *
   * An untracked tool is fully transparent: it neither advances nor resets a
   * chain, so `Read, Read, TodoWrite, Read` is a run of three Reads.
   *
   * @param chainId  emitting agent — `sdkAgentId`, or `PRIMARY_CHAIN`.
   * @param toolName the tool being called.
   * @param input    raw tool input; canonicalised internally.
   */
  observe(
    chainId: string,
    toolName: string,
    input: unknown,
  ): RepeatToolReminder | null {
    if (!this.config.enabled) return null;
    if (!this.#tracks(toolName)) return null;

    const canonicalArgs = canonicalizeArguments(input);
    // Unserialisable input can't be compared, so it can't prove a repeat.
    // Drop the chain rather than guess — a false reminder is worse than none.
    if (canonicalArgs === null) {
      this.#chains.delete(chainId);
      return null;
    }

    const key = `${toolName}\u0000${canonicalArgs}`;
    const prev = this.#chains.get(chainId);
    const count = prev && prev.key === key ? prev.count + 1 : 1;
    this.#chains.set(chainId, { key, toolName, canonicalArgs, count });

    if (!this.config.thresholds.includes(count)) return null;

    const brief = count === this.config.thresholds[0];
    return {
      toolName,
      runLength: count,
      threshold: count,
      brief,
      text: this.#render(toolName, canonicalArgs, count, brief),
    };
  }

  /**
   * Drop one chain. Called when the owner sends real input (the redirect makes
   * the prior run stale) and when a subagent stops.
   */
  resetChain(chainId: string): void {
    this.#chains.delete(chainId);
  }

  /** Drop every chain — session rotation, backend switch, fork. */
  resetAll(): void {
    this.#chains.clear();
  }

  /** Current run length for a chain. Testing and diagnostics. */
  runLength(chainId: string): number {
    return this.#chains.get(chainId)?.count ?? 0;
  }

  /**
   * The advisory itself. Wrapped in a tagged block and explicitly marked as
   * daemon-authored, matching the `<background_tasks>` convention in
   * `Session#maybeDeliverBackgroundReports` — the model must never mistake an
   * injected advisory for a message from the owner.
   */
  #render(
    toolName: string,
    canonicalArgs: string,
    count: number,
    brief: boolean,
  ): string {
    const head = [
      "<repeat_tool_notice>",
      "(daemon-injected advisory — NOT a message from the owner)",
    ];
    if (brief) {
      return [
        ...head,
        `You have called \`${toolName}\` ${count} times in a row with identical arguments.`,
        "Re-read the result you already have. If it answered the question, move on; if it did not, change your approach rather than repeating the call.",
        "</repeat_tool_notice>",
      ].join("\n");
    }
    const cap = this.config.argumentsPreviewChars;
    const preview =
      canonicalArgs.length > cap
        ? `${canonicalArgs.slice(0, cap)}… (${canonicalArgs.length - cap} more characters omitted)`
        : canonicalArgs;
    return [
      ...head,
      `You have now called \`${toolName}\` ${count} times consecutively with identical arguments:`,
      "",
      preview,
      "",
      "This is a loop. The result will not change. Do one of these instead:",
      "  1. Re-read the last result — the answer is very likely already in it.",
      "  2. Change the arguments, or use a different tool, to get new information.",
      "  3. Stop and report what you know, including that this step is blocked and why.",
      "</repeat_tool_notice>",
    ].join("\n");
  }
}
