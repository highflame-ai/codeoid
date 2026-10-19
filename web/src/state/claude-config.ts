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
  McpApprovePreview,
  McpRefreshResult,
} from "../protocol/types";

interface State {
  loading: boolean;
  sessionId: string | null;
  workdir: string | null;
  agents: ClaudeConfigAgent[];
  skills: ClaudeConfigSkill[];
  mcpServers: ClaudeConfigMcpServer[];
  hooks: ClaudeConfigHook[];
  /** The backend can redial its MCP servers. */
  mcpReconnect: boolean;
  /** Claude's config changed since the session applied it: a refresh would apply it (#395). */
  mcpStale: boolean;
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
  mcpReconnect: false,
  mcpStale: false,
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
        mcpReconnect: result.mcpReconnect === true,
        mcpStale: result.mcpStale === true,
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

/**
 * Apply Claude's current MCP config to the session (#395): its backend is
 * rebuilt and resumes the conversation. Then refresh the snapshot.
 */
export async function refreshMcpServers(sessionId: string): Promise<McpRefreshResult> {
  const ok = await getClient().request({ type: "session.mcp_refresh", id: newRequestId(), sessionId }, { timeoutMs: 30_000 });
  if (inflightForSession === sessionId) await fetchClaudeConfig(sessionId).catch(() => {});
  return ok.data as McpRefreshResult;
}

/** What approving a project's MCP server would approve, in full (#395). */
export async function previewMcpApproval(sessionId: string, server: string, path: string): Promise<McpApprovePreview> {
  const ok = await getClient().request({ type: "mcp.approve.preview", id: newRequestId(), sessionId, server, path }, { timeoutMs: 15_000 });
  return ok.data as McpApprovePreview;
}

/** Approve a project's MCP server for every backend in the session's workdir (#395). */
export async function approveMcpServer(sessionId: string, server: string, path: string, fingerprint: string): Promise<void> {
  await getClient().request({ type: "mcp.approve", id: newRequestId(), sessionId, server, path, fingerprint }, { timeoutMs: 15_000 });
  if (inflightForSession === sessionId) await fetchClaudeConfig(sessionId).catch(() => {});
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
  // The drawer's statuses follow — unless it has moved on to another
  // session meanwhile. A failed refresh isn't a failed reconnect.
  if (inflightForSession === sessionId) await fetchClaudeConfig(sessionId).catch(() => {});
  return ok.data as McpReconnectResult;
}
