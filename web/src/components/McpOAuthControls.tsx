/**
 * Connect / disconnect an OAuth MCP server for the viewer's workspace, inside
 * its row in the MCP Servers panel. The sign-in opens in a new tab and the
 * daemon completes it there; when that tab cannot reach the daemon, the user
 * pastes the address it landed on.
 */

import { type Component, Show, createSignal } from "solid-js";

import {
  beginMcpOAuth,
  checkMcpOAuth,
  completeMcpOAuth,
  disconnectMcpOAuth,
  dismissMcpOAuth,
  mcpOAuthState,
} from "../state/mcp-oauth";
import type { McpServerStatus } from "../protocol/types";

export const McpOAuthControls: Component<{ server: McpServerStatus }> = (props) => {
  const [pasted, setPasted] = createSignal("");
  const oauth = () => props.server.oauth!;
  const connected = () => oauth().status === "connected";
  const st = () => mcpOAuthState();
  const mine = () => st().server === props.server.name;
  const phase = () => (mine() ? st().phase : "idle");
  // A redirect that completed in the other tab shows up as `connected` in the
  // next snapshot, which supersedes the "waiting" step.
  const awaiting = () => phase() === "awaiting_redirect" && !connected();

  const finish = async () => {
    const value = pasted().trim();
    if (value.length === 0) return;
    if (await completeMcpOAuth(value)) setPasted("");
  };

  return (
    <div class="mt-2 border-t border-border/60 pt-2">
      <div class="flex flex-wrap items-center gap-2">
        <span
          class={`rounded px-1.5 py-0.5 text-[10px] ${
            connected() ? "bg-success/10 text-success" : "bg-bg-active/40 text-fg-muted"
          }`}
        >
          {connected() ? "signed in" : "not signed in"}
        </span>
        <Show when={!awaiting()}>
          <Show
            when={connected()}
            fallback={
              <button
                type="button"
                class="rounded border border-accent/40 px-2.5 py-1 text-[11px] text-accent hover:bg-accent/10 disabled:opacity-50"
                disabled={phase() === "starting"}
                onClick={() => void beginMcpOAuth(props.server.name)}
              >
                {phase() === "starting" ? "Contacting the server…" : "Connect"}
              </button>
            }
          >
            <button
              type="button"
              class="rounded border border-border px-2.5 py-1 text-[11px] text-fg-muted hover:text-fg disabled:opacity-50"
              disabled={phase() === "disconnecting"}
              onClick={() => void disconnectMcpOAuth(props.server.name)}
            >
              Disconnect
            </button>
          </Show>
        </Show>
        <Show when={mine() && st().error}>
          <span class="text-[11px] text-danger">{st().error}</span>
        </Show>
      </div>

      <Show when={awaiting() && st().url} keyed>
        {(url) => (
          <div class="mt-2 flex flex-col gap-2">
            <div>
              <div class="text-[11px] font-semibold text-fg">1 · Open this link and approve</div>
              <div class="mt-1 flex items-center gap-2">
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer noopener"
                  class="truncate text-[11px] text-accent underline"
                  title={url}
                >
                  {url}
                </a>
                <button
                  type="button"
                  class="shrink-0 rounded border border-border px-2 py-0.5 text-[10px] text-fg-muted hover:text-fg"
                  onClick={() => void navigator.clipboard?.writeText(url)}
                  title="Copy the link — useful when your browser is on another machine"
                >
                  Copy
                </button>
              </div>
            </div>
            <div>
              <div class="text-[11px] font-semibold text-fg">2 · Come back here</div>
              <p class="mt-0.5 text-[11px] text-fg-muted">
                The tab will say it is connected.{" "}
                <button type="button" class="text-accent underline" onClick={() => void checkMcpOAuth()}>
                  Check now
                </button>
                . If it showed an error page instead (the daemon is on another machine), paste that
                page's address:
              </p>
              <div class="mt-1 flex items-center gap-2">
                <input
                  type="text"
                  autocomplete="off"
                  spellcheck={false}
                  class="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 font-mono text-[11px] text-fg"
                  placeholder="http://127.0.0.1:…/mcp/oauth/callback?code=…"
                  value={pasted()}
                  disabled={phase() === "completing"}
                  onInput={(e) => setPasted(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void finish();
                  }}
                />
                <button
                  type="button"
                  class="shrink-0 rounded border border-accent/40 px-2.5 py-1 text-[11px] text-accent hover:bg-accent/10 disabled:opacity-50"
                  disabled={phase() === "completing" || pasted().trim().length === 0}
                  onClick={() => void finish()}
                >
                  {phase() === "completing" ? "Connecting…" : "Finish"}
                </button>
                <button
                  type="button"
                  class="shrink-0 text-[11px] text-fg-faint hover:text-fg"
                  onClick={() => {
                    setPasted("");
                    dismissMcpOAuth();
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>

      <Show when={oauth().unsupportedBackends.length > 0}>
        <p class="mt-1.5 text-[11px] text-fg-faint">
          Available on the daemon-run backends only for now — not mounted on{" "}
          {oauth().unsupportedBackends.join(", ")}.
        </p>
      </Show>
    </div>
  );
};
