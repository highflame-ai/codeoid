/**
 * Cached Claude config snapshot for the focused session — agents,
 * skills, MCP servers, hooks. Daemon-canonical: refetched whenever the
 * focused session changes (or the user explicitly refreshes).
 */

import { batch, createSignal } from "solid-js";

import { getClient, newRequestId } from "./connection";
import type {
  ClaudeConfigAgent,
  ClaudeConfigHook,
  ClaudeConfigMcpServer,
  ClaudeConfigResultMsg,
  ClaudeConfigSkill,
  McpReconnectResult,
} from "../protocol/types";

interface State {
  loading: boolean;
  sessionId: string | null;
  workdir: string | null;
  agents: ClaudeConfigAgent[];
  skills: ClaudeConfigSkill[];
  mcpServers: ClaudeConfigMcpServer[];
  hooks: ClaudeConfigHook[];
  error: string | null;
  fetchedAt: number;
}

const EMPTY: State = {
  loading: false,
  sessionId: null,
  workdir: null,
  agents: [],
  skills: [],
  mcpServers: [],
  hooks: [],
  error: null,
  fetchedAt: 0,
};

const [state, setState] = createSignal<State>(EMPTY);

export const claudeConfig = state;

let inflightForSession: string | null = null;

/**
 * Fetch and cache the snapshot for `sessionId`. Idempotent — multiple
 * concurrent calls for the same session collapse into one daemon round
 * trip; calls for a different session cancel the previous waiter.
 */
export async function fetchClaudeConfig(sessionId: string): Promise<void> {
  inflightForSession = sessionId;
  setState((s) =>
    s.sessionId === sessionId
      ? { ...s, loading: true, error: null }
      : { ...EMPTY, sessionId, loading: true },
  );
  try {
    const id = newRequestId();
    const result = await getClient().request<ClaudeConfigResultMsg>(
      { type: "claude.config", id, sessionId },
      {
        waitForResult: (m) =>
          m.type === "claude.config.result" && m.requestId === id ? m : undefined,
        timeoutMs: 8_000,
      },
    );
    if (inflightForSession !== sessionId) return; // user moved on; drop result
    batch(() => {
      setState({
        loading: false,
        sessionId,
        workdir: result.workdir,
        agents: result.agents,
        skills: result.skills,
        mcpServers: result.mcpServers,
        hooks: result.hooks,
        error: null,
        fetchedAt: Date.now(),
      });
    });
  } catch (err) {
    if (inflightForSession !== sessionId) return;
    setState((s) => ({
      ...s,
      loading: false,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}

export function resetClaudeConfig(): void {
  inflightForSession = null;
  setState(EMPTY);
}

/**
 * Redial one of the session backend's MCP servers (#389), then refresh the
 * snapshot so the drawer shows the backend's new answer.
 */
export async function reconnectMcpServer(sessionId: string, server: string): Promise<McpReconnectResult> {
  const ok = await getClient().request({ type: "session.mcp_reconnect", id: newRequestId(), sessionId, server }, { timeoutMs: 30_000 });
  // The drawer's statuses follow; a failed refresh isn't a failed reconnect.
  await fetchClaudeConfig(sessionId).catch(() => {});
  return ok.data as McpReconnectResult;
}
