/**
 * CodexProvider — OpenAI Codex CLI as a codeoid backend.
 *
 * Drives `codex app-server` (JSON-RPC over stdio, see rpc.ts) so codex's
 * own harness does the work — tools, sandbox, ChatGPT-subscription auth in
 * ~/.codex — while codeoid owns approvals, scrollback, and history.
 * First slice (see docs/provider-codex-design.md):
 *
 *   - warm process; one codex THREAD per backing session (thread id is the
 *     backingSessionId; resetToNewSession starts a fresh thread)
 *   - the codeoid session MODE drives codex's native `approvalPolicy` on every
 *     thread/turn start (see codexPolicies()), so switching modes actually
 *     reconfigures the backend rather than only changing what codeoid's gate
 *     does with codex's approval requests:
 *       · guarded / interactive → `untrusted`: codex asks before privileged
 *         actions and each request routes through codeoid's canUseTool
 *         (approve/deny natively, no injected bridge unlike pi) so codeoid
 *         prompts the user;
 *       · autonomous → `never`: codex runs unattended with NO per-action
 *         approval round-trip. codeoid records each action retrospectively at
 *         item/completed (see below) so scrollback + history stay honest.
 *   - the sandbox mode `danger-full-access` is pinned (as codex's
 *     internally-tagged `{type:"dangerFullAccess"}` wire value, via
 *     sandboxPolicyWire()) so codex EXECUTES actions with full access
 *     (including network) instead of re-sandboxing them. codeoid's mode is the
 *     trust authority; codex's own bundled-bubblewrap sandbox is redundant with
 *     it AND non-portable — it needs unprivileged user namespaces that
 *     containers and hardened hosts (`apparmor_restrict_unprivileged_userns=1`)
 *     forbid, and when bwrap can't initialize even an APPROVED command dies
 *     inside codex with "command execution rejected / cannot escalate".
 *     Operators on a bwrap-capable host who want defense-in-depth can override
 *     both the mode-derived approval policy and the sandbox via
 *     CODEX_APPROVAL_POLICY / CODEX_SANDBOX_POLICY (see codexPolicies()).
 *   - `item/tool/requestUserInput` → requestUserInput (session.ui_request)
 *   - text/reasoning deltas stream; command/fileChange/mcp items surface
 *     as tool records; usage from turn/completed
 *   - seedFromHistory prepends renderHistorySeed to the first prompt (the
 *     warm-backend ceiling; codex threads only resume codex's own state)
 *
 * Non-gated items (codex ran something its policy considers trusted, e.g.
 * read-only commands) are recorded retrospectively at item/completed as a
 * paired tool_start/tool_complete — visible in scrollback + canonical
 * history without pretending codeoid gated them.
 */

import { randomUUID } from "node:crypto";
import { AsyncQueue } from "../../async-queue.js";
import type { Store } from "../../store.js";
import type {
  ModelInfo,
  NormalizedTurnResult,
  ProviderEvent,
  SessionProvider,
  ToolApprovalFn,
  TurnOpts,
  TurnRun,
  UiRequestFn,
} from "../interface.js";
import { renderHistorySeed, type CanonicalTurn, type HistorySeedResult } from "../canonical.js";
import { buildCodexEnv } from "../env.js";
import { CodexRpcProcess } from "./rpc.js";
import type { SessionMode } from "../../../protocol/types.js";
import { MEMORY_MCP_SERVER_NAME, MEMORY_MCP_TOKEN_ENV, type MemoryMcpMount } from "../../memory/mcp-http.js";
import {
  BLACKBOARD_MCP_SERVER_NAME,
  BLACKBOARD_MCP_TOKEN_ENV,
} from "../../blackboard/mcp-http.js";
import type { McpRegistry } from "../../mcp/registry.js";
import { resolveEnvMap } from "../../mcp/types.js";

/** codex `tokenUsage.last` / `.total` shape (thread/tokenUsage/updated). */
interface CodexTokenUsage {
  totalTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}

export interface CodexProviderInit {
  sessionId: string;
  /** codex thread id from a previous run, or the codeoid session id on first run. */
  initialBackingId: string;
  /** Resolved binary (see resolve.ts). */
  command: string;
  argsPrefix?: string[];
  store: Store;
  /** Tenant-scoped memory workspace id — the scope a mounted memory token binds to. */
  workspaceId?: string;
  /**
   * Shared in-daemon memory MCP endpoint + URL. When present (memory enabled),
   * the provider mounts it on the app-server via `-c mcp_servers.*` overrides so
   * codex can page the verbatim store on demand — the precondition for VWS.
   */
  memoryMcp?: MemoryMcpMount;
  /**
   * Role-scoped goal-blackboard mount, resolved LAZILY.
   *
   * A getter rather than a value because the orchestrator's own mount is
   * scoped to a goal id that IS its session id — so it cannot exist until
   * after the Session is constructed. Providers read it when they build their
   * server list (per turn for claude), by which time it is set.
   */
  blackboardMcp?: () => { url: string; token: string } | undefined;

  /** Cross-backend MCP registry — external servers mount natively via `-c
   *  mcp_servers.*` (codex owns its client); approval flows through canUseTool. */
  mcpRegistry?: McpRegistry;
  onModels?: (
    models: ReadonlyArray<{ value: string; displayName: string; description?: string }>,
  ) => void;
}

/** Item types that surface as tool records (vs text/reasoning streams). */
const TOOL_ITEM_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "webSearch",
  "tool",
]);

/**
 * codex `approvalPolicy` (AskForApproval) — the string variants of the
 * app-server v2 enum. `on-failure` is NOT one of them (verified against
 * @openai/codex@0.144.1 `generate-ts`: it's `"untrusted" | "on-request" |
 * {granular} | "never"`); the object `granular` form is not exposed via env.
 */
const APPROVAL_POLICIES = new Set(["untrusted", "on-request", "never"]);

/**
 * Operator-facing sandbox modes (config.toml / CLI spelling). Mapped to
 * codex's internally-tagged `SandboxPolicy` wire enum by sandboxPolicyWire().
 */
type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
const SANDBOX_MODES = new Set<SandboxMode>(["read-only", "workspace-write", "danger-full-access"]);

/**
 * Map the codeoid session {@link SessionMode} to codex's native approval policy.
 * This is what makes a mode switch reconfigure the backend:
 *   - `autonomous` → `never`: codex runs unattended, no per-action approval
 *     round-trip (codeoid records each action retrospectively at item/completed).
 *   - `guarded` / `interactive` → `untrusted`: codex asks before privileged
 *     actions and each request routes through codeoid's canUseTool so codeoid
 *     prompts the user. (codex has no "ask for read-only ops too" policy, so
 *     interactive degrades to untrusted at the codex layer; codeoid's gate
 *     still prompts for everything codex does ask about.)
 *   - absent → `untrusted` (treated as guarded).
 */
function approvalPolicyForMode(mode: SessionMode | undefined): string {
  return mode === "autonomous" ? "never" : "untrusted";
}

/**
 * The approval policy + sandbox MODE codeoid pins on codex thread/turn starts.
 *
 * The session mode drives the defaults (see {@link approvalPolicyForMode} and
 * the file header). The sandbox is `danger-full-access` in every mode so codex
 * EXECUTES actions with full access instead of re-sandboxing them — codeoid's
 * mode + canUseTool gate is the trust authority, not codex's bubblewrap.
 *
 * Both are overridable via env, which WINS over the mode-derived value: an
 * operator on a bubblewrap-capable host who wants codex's sandbox as
 * defense-in-depth (or a pinned approval policy) sets CODEX_SANDBOX_POLICY /
 * CODEX_APPROVAL_POLICY and it holds regardless of mode. An unknown value falls
 * back to the mode-derived default rather than letting codex reject the start.
 */
function codexPolicies(mode?: SessionMode): { approvalPolicy: string; sandboxMode: SandboxMode } {
  const approval = process.env.CODEX_APPROVAL_POLICY?.trim();
  const sandbox = process.env.CODEX_SANDBOX_POLICY?.trim() as SandboxMode | undefined;
  return {
    approvalPolicy: approval && APPROVAL_POLICIES.has(approval) ? approval : approvalPolicyForMode(mode),
    sandboxMode: sandbox && SANDBOX_MODES.has(sandbox) ? sandbox : "danger-full-access",
  };
}

/**
 * Map an operator-facing {@link SandboxMode} to codex's `SandboxPolicy` wire
 * value — an INTERNALLY-TAGGED enum (`{type: "..."}`, camelCase variants), NOT
 * the bare kebab string. Sending the string trips codex with
 * `invalid type: string "...", expected internally tagged enum
 * SandboxPolicyDeserialize` at turn/start. Shapes verified live against
 * @openai/codex@0.144.1 `generate-ts` + a real turn.
 */
function sandboxPolicyWire(mode: SandboxMode, workdir: string): Record<string, unknown> {
  switch (mode) {
    case "read-only":
      return { type: "readOnly", networkAccess: false };
    case "workspace-write":
      return {
        type: "workspaceWrite",
        writableRoots: [workdir],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    default: // "danger-full-access" — codeoid is the trust authority.
      return { type: "dangerFullAccess" };
  }
}

export class CodexProvider implements SessionProvider {
  readonly id = "codex";
  readonly displayName = "Codex (OpenAI)";

  onRecoveryNeeded: ((content: string) => void) | undefined;

  #sessionId: string;
  #backingSessionId: string;
  #command: string;
  #argsPrefix: string[];
  #onModels?: CodexProviderInit["onModels"];
  #workspaceId: string;
  #memoryMcp: MemoryMcpMount | null;
  /** Role-scoped blackboard mount; token minted+revoked by the SessionManager. */
  readonly #blackboardMcp: (() => { url: string; token: string } | undefined) | null;
  #mcpRegistry: McpRegistry | null;
  /** Live scoped token for the mounted memory endpoint; revoked on teardown. */
  #memoryToken: string | null = null;

  #proc: CodexRpcProcess | null = null;
  #threadId: string | null = null;
  #hasQueried = false;
  #modelsReported = false;
  #pendingHistorySeed: string | null = null;

  // Per-turn wiring.
  #turnQueue: AsyncQueue<ProviderEvent> | null = null;
  #canUseTool: ToolApprovalFn | null = null;
  #requestUserInput: UiRequestFn | undefined;
  #turnStartedAt = 0;
  #turnModel = "codex";
  #currentTurnId: string | null = null;
  /**
   * Latest per-turn token usage from `thread/tokenUsage/updated`. codex's
   * `turn/completed` carries NO usage (verified live) — it arrives on the
   * separate token-usage notification, `tokenUsage.last` being this turn's
   * counts. Captured here and folded into turn_done.
   */
  #lastTokenUsage: CodexTokenUsage | null = null;
  /** item id → {name, input} for items already announced via tool_start. */
  #announcedItems = new Map<string, { name: string; input: Record<string, unknown> }>();
  /**
   * serverName → the most-recent mcpToolCall item awaiting its approval
   * elicitation. codex gates an MCP tool call with `mcpServer/elicitation/request`,
   * which names the SERVER but not the tool; the `item/started` (mcpToolCall)
   * that fires just before it carries both, so we correlate here to build the
   * canonical `mcp__<server>__<tool>` name the approval gate + isSafeTool key off.
   */
  #pendingMcpCalls = new Map<string, { itemId: string; tool: string; input: Record<string, unknown> }>();

  constructor(init: CodexProviderInit) {
    this.#sessionId = init.sessionId;
    this.#backingSessionId = init.initialBackingId;
    this.#command = init.command;
    this.#argsPrefix = init.argsPrefix ?? [];
    this.#onModels = init.onModels;
    this.#workspaceId = init.workspaceId ?? init.sessionId;
    this.#memoryMcp = init.memoryMcp ?? null;
    this.#blackboardMcp = init.blackboardMcp ?? null;
    this.#mcpRegistry = init.mcpRegistry ?? null;
  }

  /**
   * True when the shared memory endpoint is mounted for this session, so codex
   * can page the verbatim store on demand. The Verbatim Working Set strategy
   * seeds a compact session map only when this holds; otherwise the session
   * falls back to the transcript seed.
   */
  get supportsMemoryTools(): boolean {
    return this.#memoryMcp != null;
  }

  get backingSessionId(): string {
    return this.#backingSessionId;
  }
  get hasQueried(): boolean {
    return this.#hasQueried;
  }
  get queuedMessages(): number {
    return 0;
  }

  resetToNewSession(newBackingId: string): void {
    this.#backingSessionId = newBackingId;
    this.#threadId = null;
    this.#hasQueried = false;
  }

  setHasQueried(value: boolean): void {
    this.#hasQueried = value;
  }

  seedFromHistory(history: readonly CanonicalTurn[], opts?: { maxChars?: number }): HistorySeedResult {
    const seed = renderHistorySeed(history, { maxChars: opts?.maxChars });
    this.#pendingHistorySeed = seed.text.length > 0 ? seed.text : null;
    return seed;
  }

  /**
   * VWS transport: prepend a strategy-built block (the compact session map) to
   * the next prompt — the same channel seedFromHistory uses. The session decides
   * transcript vs session map; the provider just stashes the block.
   */
  seedText(block: string): void {
    this.#pendingHistorySeed = block.length > 0 ? block : null;
  }

  /**
   * `-c` config overrides + token env that mount the shared memory endpoint on
   * the codex app-server (`--url` streamable-HTTP MCP server, bearer token read
   * from an env var so it never lands in argv). Minted fresh per app-server
   * spawn — the token is this session's tenant scope; revoked on teardown.
   */
  #memoryMcpSpawn(): { args: string[]; env: Record<string, string> } {
    const mount = this.#memoryMcp;
    if (!mount) return { args: [], env: {} };
    if (this.#memoryToken) mount.endpoint.revoke(this.#memoryToken);
    this.#memoryToken = mount.endpoint.mint({
      workspaceId: this.#workspaceId,
      sessionId: this.#sessionId,
    });
    const key = `mcp_servers.${MEMORY_MCP_SERVER_NAME}`;
    return {
      // The `-c` value parses as TOML — JSON.stringify yields a valid TOML
      // string literal (quoted). Verified live against codex app-server.
      args: [
        "-c", `${key}.url=${JSON.stringify(mount.url)}`,
        "-c", `${key}.bearer_token_env_var=${JSON.stringify(MEMORY_MCP_TOKEN_ENV)}`,
      ],
      env: { [MEMORY_MCP_TOKEN_ENV]: this.#memoryToken },
    };
  }

  /**
   * `-c mcp_servers.codeoid_blackboard.*` — the role-scoped goal blackboard for
   * a collaboration child, same TOML shape as the memory mount above.
   *
   * No mint/revoke here: the SessionManager owns this token, because the scope
   * it carries belongs to the collaboration rather than to a codex backing
   * session that may be recreated mid-goal.
   */
  #blackboardMcpSpawn(): { args: string[]; env: Record<string, string> } {
    const mount = this.#blackboardMcp?.();
    if (!mount) return { args: [], env: {} };
    const key = `mcp_servers.${BLACKBOARD_MCP_SERVER_NAME}`;
    return {
      args: [
        "-c", `${key}.url=${JSON.stringify(mount.url)}`,
        "-c", `${key}.bearer_token_env_var=${JSON.stringify(BLACKBOARD_MCP_TOKEN_ENV)}`,
      ],
      env: { [BLACKBOARD_MCP_TOKEN_ENV]: mount.token },
    };
  }

  /**
   * `-c mcp_servers.*` overrides mounting the registry's external servers on the
   * codex app-server — a native mount, since codex owns its own MCP client.
   * stdio → command/args/env (env as a TOML inline table); http → url +
   * bearer_token_env_var, with the resolved token handed to codex via its env.
   * Built-in memory is mounted separately (#memoryMcpSpawn). Tool calls surface
   * as `mcp__<server>__<tool>` and gate through the elicitation handler.
   */
  #registryMcpArgs(): { args: string[]; env: Record<string, string> } {
    const reg = this.#mcpRegistry;
    if (!reg) return { args: [], env: {} };
    const args: string[] = [];
    const env: Record<string, string> = {};
    for (const spec of reg.forBackend(this.id)) {
      if (spec.builtin) continue;
      const key = `mcp_servers.${spec.name}`;
      const t = spec.transport;
      if (t.kind === "stdio") {
        args.push("-c", `${key}.command=${JSON.stringify(t.command)}`);
        if (t.args && t.args.length > 0) args.push("-c", `${key}.args=${JSON.stringify(t.args)}`);
        const resolved = resolveEnvMap(t.env ?? {}, process.env);
        if (Object.keys(resolved).length > 0) args.push("-c", `${key}.env=${tomlInlineTable(resolved)}`);
      } else if (t.kind === "http") {
        args.push("-c", `${key}.url=${JSON.stringify(t.url)}`);
        if (t.bearerTokenEnv) {
          args.push("-c", `${key}.bearer_token_env_var=${JSON.stringify(t.bearerTokenEnv)}`);
          const tok = process.env[t.bearerTokenEnv];
          if (tok) env[t.bearerTokenEnv] = tok;
        }
      }
    }
    return { args, env };
  }

  runTurn(opts: TurnOpts): TurnRun {
    const queue = new AsyncQueue<ProviderEvent>();
    this.#turnQueue = queue;
    this.#canUseTool = opts.canUseTool;
    this.#requestUserInput = opts.requestUserInput;
    this.#turnStartedAt = Date.now();
    this.#turnModel = opts.model ?? "codex";
    this.#announcedItems.clear();
    this.#lastTokenUsage = null;
    this.#hasQueried = true;

    void this.#startTurn(opts).catch((err: unknown) => {
      this.#push({ type: "error", message: `codex: ${err instanceof Error ? err.message : String(err)}` });
      queue.close();
    });

    return {
      events: queue,
      interrupt: async () => {
        if (this.#proc?.alive && this.#threadId) {
          try {
            await this.#proc.request("turn/interrupt", {
              threadId: this.#threadId,
              ...(this.#currentTurnId ? { turnId: this.#currentTurnId } : {}),
            });
            return;
          } catch {
            /* fall through to hard close */
          }
        }
        queue.close();
      },
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.#proc?.alive) return [];
    try {
      const result = (await this.#proc.request("model/list", {})) as {
        data?: Array<{ id?: string; model?: string; displayName?: string; description?: string }>;
      };
      return (result.data ?? [])
        .filter((m) => typeof (m.model ?? m.id) === "string")
        .map((m) => ({
          id: (m.model ?? m.id) as string,
          displayName: m.displayName ?? ((m.model ?? m.id) as string),
          description: m.description,
        }));
    } catch {
      return [];
    }
  }

  async dispose(): Promise<void> {
    await this.teardown();
  }

  async teardown(): Promise<void> {
    this.#turnQueue?.close();
    this.#turnQueue = null;
    this.#proc?.kill();
    this.#proc = null;
    this.#threadId = null;
    if (this.#memoryToken) {
      this.#memoryMcp?.endpoint.revoke(this.#memoryToken);
      this.#memoryToken = null;
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────

  async #startTurn(opts: TurnOpts): Promise<void> {
    await this.#ensureThread(opts);
    const seed = this.#pendingHistorySeed;
    this.#pendingHistorySeed = null;
    const text = seed ? `${seed}\n\n${opts.userMessage}` : opts.userMessage;

    const { approvalPolicy, sandboxMode } = codexPolicies(opts.mode);
    const result = (await this.#proc!.request("turn/start", {
      threadId: this.#threadId,
      input: [{ type: "text", text, text_elements: [] }],
      cwd: opts.workdir,
      // The session mode drives the approval policy (autonomous → codex runs
      // unattended; guarded/interactive → codex asks and codeoid's gate
      // prompts) and codex EXECUTES approved actions with full sandbox access
      // instead of re-sandboxing them (which fails wherever bubblewrap can't
      // init). See codexPolicies().
      approvalPolicy,
      sandboxPolicy: sandboxPolicyWire(sandboxMode, opts.workdir),
      ...(opts.model ? { model: opts.model } : {}),
    })) as { turn?: { id?: string } };
    this.#currentTurnId = result.turn?.id ?? null;
  }

  async #ensureThread(opts: TurnOpts): Promise<void> {
    if (this.#proc?.alive && this.#threadId) return;

    if (!this.#proc?.alive) {
      // Mount the shared memory endpoint (if enabled) via `-c mcp_servers.*`
      // overrides + a token env var, so codex pages the verbatim store on
      // demand. No CODEX_HOME/auth.json juggling — the default ~/.codex keeps
      // the user's auth + config; these just add the one server.
      const mcp = this.#memoryMcpSpawn();
      const bb = this.#blackboardMcpSpawn();
      const reg = this.#registryMcpArgs();
      this.#proc = new CodexRpcProcess({
        command: this.#command,
        argsPrefix: this.#argsPrefix,
        args: [...mcp.args, ...bb.args, ...reg.args],
        cwd: opts.workdir,
        env: { ...buildCodexEnv(), ...mcp.env, ...bb.env, ...reg.env },
        onNotification: (method, params) => this.#onNotification(method, params),
        onServerRequest: (method, params) => this.#onServerRequest(method, params),
        onExit: ({ code, signal, stderrTail }) => {
          const queue = this.#turnQueue;
          if (queue && !queue.closed) {
            this.#push({
              type: "error",
              message: `codex exited unexpectedly (code=${code} signal=${signal})${stderrTail ? `: ${stderrTail.slice(-500)}` : ""}`,
            });
            queue.close();
          }
        },
      });
      await this.#proc.request("initialize", {
        clientInfo: { name: "codeoid", title: "codeoid", version: "1.0" },
      });
      this.#proc.notify("initialized");
    }

    // Resume the prior thread when the backing id looks like one codex
    // minted; otherwise (first run: backing id is the codeoid session id)
    // start fresh. Resume failure degrades to a fresh thread — never wedge.
    if (this.#backingSessionId !== this.#sessionId) {
      try {
        const resumed = (await this.#proc.request("thread/resume", {
          threadId: this.#backingSessionId,
        })) as { thread?: { id?: string } };
        if (resumed.thread?.id) {
          this.#threadId = resumed.thread.id;
          return;
        }
      } catch {
        /* fall through to thread/start */
      }
    }
    const { approvalPolicy, sandboxMode } = codexPolicies(opts.mode);
    const started = (await this.#proc.request("thread/start", {
      cwd: opts.workdir,
      approvalPolicy,
      sandboxPolicy: sandboxPolicyWire(sandboxMode, opts.workdir),
      ...(opts.systemPromptAppend ? { developerInstructions: opts.systemPromptAppend } : {}),
    })) as { thread?: { id?: string } };
    if (!started.thread?.id) throw new Error("codex thread/start returned no thread id");
    this.#threadId = started.thread.id;
    this.#backingSessionId = started.thread.id;

    if (!this.#modelsReported && this.#onModels) {
      const models = await this.listModels();
      if (models.length > 0) {
        this.#modelsReported = true;
        this.#onModels(models.map((m) => ({ value: m.id, displayName: m.displayName, description: m.description })));
      }
    }
  }

  #push(event: ProviderEvent): void {
    const queue = this.#turnQueue;
    if (!queue || queue.closed) return;
    try {
      queue.push(event);
    } catch {
      /* closed between check and push */
    }
  }

  #onNotification(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case "item/agentMessage/delta": {
        const delta = (params.delta ?? params.text) as string | undefined;
        if (delta) this.#push({ type: "text_delta", content: delta });
        break;
      }
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        const delta = (params.delta ?? params.text) as string | undefined;
        if (delta) this.#push({ type: "thinking_delta", content: delta });
        break;
      }
      case "item/started": {
        // codex names the SERVER (not the tool) in the approval elicitation
        // that follows an mcpToolCall — stash the tool + args here so the
        // elicitation handler can build the canonical `mcp__server__tool` name.
        const item = params.item as Record<string, unknown> | undefined;
        if (item && (item.type as string) === "mcpToolCall") {
          this.#pendingMcpCalls.set(String(item.server ?? ""), {
            itemId: String(item.id ?? ""),
            tool: String(item.tool ?? "tool"),
            input: (item.arguments as Record<string, unknown>) ?? {},
          });
        }
        break;
      }
      case "item/completed": {
        const item = params.item as Record<string, unknown> | undefined;
        if (!item) break;
        const itemType = item.type as string;
        const itemId = String(item.id ?? "");
        if (itemType === "mcpToolCall") this.#pendingMcpCalls.delete(String(item.server ?? ""));
        if (itemType === "agentMessage") {
          const text = (item.text ?? item.content ?? "") as string;
          this.#push({ type: "text_done", content: typeof text === "string" ? text : "" });
          this.#push({ type: "thinking_done" });
        } else if (TOOL_ITEM_TYPES.has(itemType)) {
          // Items codeoid gated were announced at approval time; items
          // codex ran under its own trusted policy are recorded here
          // retrospectively so scrollback + canonical history stay honest.
          if (!this.#announcedItems.has(itemId)) {
            const { name, input } = codexItemToTool(itemType, item);
            this.#push({
              type: "tool_start",
              toolId: itemId,
              sdkToolUseId: itemId,
              name,
              input,
              approvalId: `codex-auto-${itemId}`,
            });
          }
          this.#push({
            type: "tool_complete",
            sdkToolUseId: itemId,
            output: extractItemOutput(item),
            success: (item.status ?? "completed") !== "failed",
          });
          this.#announcedItems.delete(itemId);
        }
        break;
      }
      case "turn/completed": {
        const turn = params.turn as Record<string, unknown> | undefined;
        const u = this.#lastTokenUsage;
        // Match the claude convention: inputTokens = NEW tokens (cache reads
        // excluded); codex's inputTokens INCLUDES its cachedInputTokens.
        const cacheRead = u?.cachedInputTokens ?? 0;
        const result: NormalizedTurnResult = {
          providerId: this.id,
          model: this.#turnModel,
          inputTokens: Math.max(0, (u?.inputTokens ?? 0) - cacheRead),
          outputTokens: u?.outputTokens ?? 0,
          cacheReadTokens: cacheRead,
          cacheCreationTokens: 0,
          totalCostUsd: 0,
          durationMs: Date.now() - this.#turnStartedAt,
          stopReason: (turn?.status as string | undefined) ?? undefined,
        };
        this.#push({ type: "turn_done", result });
        this.#turnQueue?.close();
        break;
      }
      case "thread/tokenUsage/updated": {
        const usage = (params.tokenUsage as { last?: CodexTokenUsage } | undefined)?.last;
        if (usage) this.#lastTokenUsage = usage;
        break;
      }
      case "error": {
        const message = (params.message ?? params.error ?? "codex error") as string;
        this.#push({ type: "error", message: String(message) });
        break;
      }
      default:
        break; // plan/diff/status notifications — future slices
    }
  }

  async #onServerRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "item/permissions/requestApproval": {
        const canUseTool = this.#canUseTool;
        // Fail closed: an approval with no gate wired is denied, never run.
        if (!canUseTool) return { decision: "denied" };
        const itemId = String(params.itemId ?? params.approvalId ?? randomUUID());
        const { name, input } = approvalToTool(method, params);
        this.#announcedItems.set(itemId, { name, input });
        this.#push({
          type: "tool_start",
          toolId: itemId,
          sdkToolUseId: itemId,
          name,
          input,
          approvalId: `codex-${itemId}`,
        });
        const verdict = await canUseTool(itemId, `codex-${itemId}`, name, input);
        return { decision: verdict.behavior === "allow" ? "approved" : "denied" };
      }
      case "mcpServer/elicitation/request": {
        // codex gates EVERY MCP tool call behind an MCP elicitation when the
        // approval policy is `untrusted` (guarded / interactive mode). Unlike
        // the item/* approvals it names the SERVER, not the tool, and expects
        // the MCP `{action}` reply shape — NOT the `{decision}` the item/*
        // approvals use. Without this case the request hits `default` below,
        // throws, and codex reads the error as a declined elicitation, so
        // every MCP tool call (incl. read-only memory recall) is auto-denied
        // in guarded/interactive mode. Route it through the SAME canUseTool
        // gate as every other backend, keyed by the canonical
        // `mcp__<server>__<tool>` name so isSafeTool auto-approves read-only
        // memory tools and everything else prompts.
        const canUseTool = this.#canUseTool;
        // Fail closed: an approval with no gate wired is declined, never run.
        if (!canUseTool) return { action: "decline" };
        const serverName = String(params.serverName ?? "");
        const pending = this.#pendingMcpCalls.get(serverName);
        this.#pendingMcpCalls.delete(serverName);
        const tool = pending?.tool ?? mcpToolFromMessage(params.message) ?? "tool";
        const input = pending?.input ?? metaToolParams(params);
        const itemId = pending?.itemId ?? String(params.turnId ?? randomUUID());
        const name = `mcp__${serverName}__${tool}`;
        // Announce so scrollback shows the real tool; keyed by the mcpToolCall
        // itemId so the item/completed handler pairs the tool_complete instead
        // of re-announcing (autonomous runs, which never elicit, still announce
        // retrospectively via codexItemToTool).
        this.#announcedItems.set(itemId, { name, input });
        this.#push({
          type: "tool_start",
          toolId: itemId,
          sdkToolUseId: itemId,
          name,
          input,
          approvalId: `codex-${itemId}`,
        });
        const verdict = await canUseTool(itemId, `codex-${itemId}`, name, input);
        return verdict.behavior === "allow" ? { action: "accept", content: {} } : { action: "decline" };
      }
      case "item/tool/requestUserInput": {
        const ask = this.#requestUserInput;
        if (!ask) return { answers: [] };
        const questions = (params.questions ?? []) as Array<Record<string, unknown>>;
        const answers: Array<Record<string, unknown>> = [];
        for (const q of questions) {
          const options = (q.options as Array<{ label?: string }> | undefined)
            ?.map((o) => o.label ?? "")
            .filter((l) => l.length > 0);
          const response = await ask({
            method: options && options.length > 0 ? "select" : "input",
            title: String(q.header ?? q.question ?? "Codex asks"),
            message: typeof q.question === "string" ? q.question : undefined,
            options,
          });
          answers.push({
            id: q.id,
            // Cancellation is "no answer", never consent (interface contract).
            answer: response.cancelled ? null : (response.value ?? null),
          });
        }
        return { answers };
      }
      default:
        // Unknown server request — refuse rather than guess (fail closed).
        throw new Error(`codeoid does not handle codex request: ${method}`);
    }
  }
}

/** Recover the MCP tool name from the elicitation `message` when the preceding
 *  item/started wasn't observed (defensive): `…run tool "recall"?` → `recall`. */
function mcpToolFromMessage(message: unknown): string | null {
  if (typeof message !== "string") return null;
  const m = message.match(/run tool "([^"]+)"/);
  return m ? m[1] : null;
}

/** Fallback tool arguments from the elicitation `_meta.tool_params`. */
function metaToolParams(params: Record<string, unknown>): Record<string, unknown> {
  const meta = params._meta as Record<string, unknown> | undefined;
  const tp = meta?.tool_params;
  return tp && typeof tp === "object" ? (tp as Record<string, unknown>) : {};
}

/** Render an env map as a TOML inline table (`{ KEY = "val", … }`) for a codex
 *  `-c mcp_servers.<name>.env=…` override — JSON of an object is NOT valid TOML. */
function tomlInlineTable(map: Record<string, string>): string {
  const entries = Object.entries(map).map(([k, v]) => `${k} = ${JSON.stringify(v)}`);
  return `{ ${entries.join(", ")} }`;
}

/** Map an approval request to a codeoid tool name + input. */
function approvalToTool(
  method: string,
  params: Record<string, unknown>,
): { name: string; input: Record<string, unknown> } {
  if (method === "item/commandExecution/requestApproval") {
    return {
      name: "Bash",
      input: {
        command: String(params.command ?? params.parsedCmd ?? ""),
        ...(params.cwd ? { cwd: params.cwd } : {}),
        ...(params.reason ? { reason: params.reason } : {}),
      },
    };
  }
  if (method === "item/fileChange/requestApproval") {
    return {
      name: "codex_file_change",
      input: {
        ...(params.changes !== undefined ? { changes: params.changes } : {}),
        ...(params.grantRoot !== undefined ? { grantRoot: params.grantRoot } : {}),
        ...(params.reason ? { reason: params.reason } : {}),
      },
    };
  }
  return { name: "codex_permissions", input: { ...params } };
}

/** Tool record for items codex ran without asking (trusted policy). */
function codexItemToTool(
  itemType: string,
  item: Record<string, unknown>,
): { name: string; input: Record<string, unknown> } {
  if (itemType === "commandExecution") {
    return { name: "Bash", input: { command: String(item.command ?? "") } };
  }
  if (itemType === "fileChange") {
    return { name: "codex_file_change", input: { changes: item.changes ?? item.patch ?? null } };
  }
  if (itemType === "mcpToolCall") {
    return {
      name: `mcp__${String(item.server ?? "codex")}__${String(item.tool ?? "tool")}`,
      input: (item.arguments as Record<string, unknown>) ?? {},
    };
  }
  return { name: `codex_${itemType}`, input: {} };
}

function extractItemOutput(item: Record<string, unknown>): string {
  const out = item.aggregatedOutput ?? item.output ?? item.result ?? item.text ?? "";
  return typeof out === "string" ? out : JSON.stringify(out);
}
