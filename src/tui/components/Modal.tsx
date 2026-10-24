/**
 * Modal — overlay dialogs for new-session, switch-session, destroy confirm,
 * and cross-session search. Intentionally minimal; renders inline at the
 * bottom so it doesn't fight with Ink's single-surface render model.
 */

import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { ModalState, TuiSession } from "../types.js";
import type { EffortLevel, ProviderInfo, SessionSearchHit } from "../../protocol/types.js";
import type { TuiWsClient } from "../ws.js";
import { BackendPicker } from "./BackendPicker.js";
import { NewSessionModal, type NewSessionOptions } from "./NewSessionModal.js";

/**
 * Which sessions a search covers. `workspace` scopes to the focused session's
 * repo; `all` runs the cross-workspace resolution path (global fusion +
 * cross-encoder rerank) — see docs/session-resolution.md.
 */
export type SearchScope = "workspace" | "all";

interface Props {
  modal: ModalState;
  sessions: TuiSession[];
  focusedSession: TuiSession | null;
  providers: ProviderInfo[];
  client: TuiWsClient | null;
  onSubmitNewSession: (name: string, workdir: string, options: NewSessionOptions) => Promise<void>;
  onSetProvider: (sessionId: string, providerId: string) => Promise<void>;
  /** "" follows the backend's daemon default; `backend` is the one the picker listed. */
  onSetAccount: (sessionId: string, account: string, backend: string) => Promise<void>;
  onSelectSession: (sessionId: string) => void;
  onConfirmDestroy: (sessionId: string) => void;
  onCancel: () => void;
  /** Run a full-text + semantic session search. Resolves to result hits. */
  onSearch?: (query: string, scope: SearchScope) => Promise<SessionSearchHit[]>;
  /** Set a session's model. */
  onSetModel?: (sessionId: string, model: string) => Promise<void>;
  onSetEffort?: (sessionId: string, effort: EffortLevel | null) => Promise<void>;
}

export function Modal(props: Props) {
  switch (props.modal.kind) {
    case "new-session":
      return (
        <NewSessionModal providers={props.providers} client={props.client} onSubmit={props.onSubmitNewSession} onCancel={props.onCancel} />
      );
    case "switch-session":
      return (
        <SwitchModal
          query={props.modal.query}
          sessions={props.sessions}
          onSelect={props.onSelectSession}
          onCancel={props.onCancel}
        />
      );
    case "confirm-destroy": {
      const targetId = props.modal.sessionId;
      return (
        <ConfirmDestroyModal
          sessionId={targetId}
          session={props.sessions.find((s) => s.info.id === targetId) ?? null}
          onConfirm={() => props.onConfirmDestroy(targetId)}
          onCancel={props.onCancel}
        />
      );
    }
    case "help":
      return <HelpModal onCancel={props.onCancel} />;
    case "search":
      return (
        <SearchModal
          query={props.modal.query}
          // With no focused session there is no workspace to scope to, so
          // open straight into cross-workspace rather than a dead scope.
          initialScope={props.focusedSession ? "workspace" : "all"}
          onSearch={props.onSearch}
          onSelect={props.onSelectSession}
          onCancel={props.onCancel}
        />
      );
    case "model":
    case "provider":
    case "effort":
    case "account": {
      // The session the picker was opened for, not whichever is focused now.
      const { kind, sessionId } = props.modal;
      const target = props.sessions.find((s) => s.info.id === sessionId);
      if (!target) return <SessionGoneModal message="That session no longer exists." onCancel={props.onCancel} />;
      const provider = target.info.providerId ?? "claude";
      // The account picker lists, and applies, the accounts of the backend it
      // was opened on. If the session has moved to another backend since, it
      // closes and says so: re-targeting it quietly would offer the other
      // backend's accounts, and drop the close a pick in flight is owed.
      if (props.modal.kind === "account" && props.modal.backend !== provider) {
        return <SessionGoneModal message={`${target.info.name} switched to ${provider} — reopen /account`} onCancel={props.onCancel} />;
      }
      return (
        <BackendPicker
          // A provider switch changes which catalog the MODEL picker shows. The
          // provider picker must not remount on it: the daemon's info update
          // arrives before the switch's reply, and a remount would drop the
          // close that follows a successful pick.
          key={kind === "model" || kind === "effort" ? `${kind}:${provider}` : kind}
          kind={kind}
          provider={provider}
          model={target.info.model}
          sessionName={target.info.name}
          providers={props.providers}
          client={props.client}
          current={
            kind === "model"
              ? (target.info.model ?? "")
              : kind === "effort"
                ? (target.info.effort ?? "default")
                : kind === "provider"
                  ? provider
                  : (target.info.account ?? (provider === "claude" ? target.info.claudeAccount : undefined) ?? "")
          }
          onPick={async (value) => {
            if (kind === "model") await props.onSetModel?.(sessionId, value);
            else if (kind === "effort") await props.onSetEffort?.(sessionId, value === "default" ? null : (value as EffortLevel));
            else if (kind === "provider") await props.onSetProvider(sessionId, value);
            else await props.onSetAccount(sessionId, value, provider);
          }}
          onCancel={props.onCancel}
        />
      );
    }
  }
}

function SwitchModal({
  query,
  sessions,
  onSelect,
  onCancel,
}: {
  query: string;
  sessions: TuiSession[];
  onSelect: (id: string) => void;
  onCancel: () => void;
}) {
  const [q, setQ] = useState(query);
  const [idx, setIdx] = useState(0);

  const filtered = sessions.filter((s) =>
    s.info.name.toLowerCase().includes(q.toLowerCase()),
  );

  useInput((_input, key) => {
    if (key.escape) onCancel();
    if (key.upArrow) setIdx((i) => Math.max(0, i - 1));
    if (key.downArrow) setIdx((i) => Math.min(filtered.length - 1, i + 1));
    if (key.return && filtered[idx]) onSelect(filtered[idx]!.info.id);
  });

  return (
    <Box flexDirection="column" borderStyle="double" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        Switch Session
      </Text>
      <Box marginTop={1}>
        <Text>{"filter: "}</Text>
        <TextInput value={q} onChange={setQ} onSubmit={() => {}} />
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {filtered.length === 0 ? (
          <Text dimColor>(no matches)</Text>
        ) : (
          filtered.map((s, i) => (
            <Text key={s.info.id} color={i === idx ? "cyan" : "white"}>
              {i === idx ? "▸ " : "  "}
              {s.info.name} · {s.info.status}
            </Text>
          ))
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑↓ to move · Enter to select · Esc to cancel</Text>
      </Box>
    </Box>
  );
}

/**
 * Replaces a backend picker whose target went away while it was open: the
 * session was destroyed, or (for the account picker) moved to another backend.
 */
function SessionGoneModal({ message, onCancel }: { message: string; onCancel: () => void }) {
  useInput((_input, key) => {
    if (key.escape || key.return) onCancel();
  });
  return (
    <Box flexDirection="column" borderStyle="double" borderColor="red" paddingX={1}>
      <Text color="red">{message}</Text>
      <Text dimColor>Esc / Enter to close</Text>
    </Box>
  );
}

function ConfirmDestroyModal({
  session,
  onConfirm,
  onCancel,
}: {
  sessionId: string;
  session: TuiSession | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useInput((input, key) => {
    if (key.escape || input === "n" || input === "N") onCancel();
    if (input === "y" || input === "Y" || key.return) onConfirm();
  });

  return (
    <Box flexDirection="column" borderStyle="double" borderColor="red" paddingX={1}>
      <Text bold color="red">
        Destroy Session
      </Text>
      <Box marginTop={1}>
        <Text>Destroy </Text>
        <Text bold>{session?.info.name ?? "(unknown)"}</Text>
        <Text>? This cannot be undone.</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>y to confirm · n/Esc to cancel</Text>
      </Box>
    </Box>
  );
}

// ── Search modal ────────────────────────────────────────────────────────

function SearchModal({
  query,
  initialScope,
  onSearch,
  onSelect,
  onCancel,
}: {
  query: string;
  initialScope: SearchScope;
  onSearch?: (q: string, scope: SearchScope) => Promise<SessionSearchHit[]>;
  onSelect: (id: string) => void;
  onCancel: () => void;
}) {
  const [q, setQ] = useState(query);
  const [scope, setScope] = useState<SearchScope>(initialScope);
  const [hits, setHits] = useState<SessionSearchHit[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);

  // Debounce — hit the daemon after the user stops typing for 200 ms.
  // Any typing in between cancels prior in-flight requests via a ref
  // guard so old results don't race ahead of new ones. Toggling scope
  // re-runs the same query through the other regime.
  const requestSeq = useRef(0);
  useEffect(() => {
    if (!onSearch) return;
    const trimmed = q.trim();
    if (!trimmed) {
      setHits([]);
      setError(null);
      setIsSearching(false);
      return;
    }
    const seq = ++requestSeq.current;
    const timer = setTimeout(async () => {
      setIsSearching(true);
      setError(null);
      try {
        const results = await onSearch(trimmed, scope);
        if (seq !== requestSeq.current) return; // stale response
        setHits(results);
        setIdx(0);
      } catch (err) {
        if (seq !== requestSeq.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setHits([]);
      } finally {
        if (seq === requestSeq.current) setIsSearching(false);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [q, scope, onSearch]);

  useInput((_input, key) => {
    if (key.escape) onCancel();
    if (key.tab) setScope((s) => (s === "workspace" ? "all" : "workspace"));
    if (key.upArrow) setIdx((i) => Math.max(0, i - 1));
    if (key.downArrow) setIdx((i) => Math.min(Math.max(0, hits.length - 1), i + 1));
    if (key.return && hits[idx]) onSelect(hits[idx]!.sessionId);
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="cyan"
      paddingX={1}
    >
      <Text bold color="cyan">
        🔍 Search across sessions
        <Text dimColor>{"  ·  scope: "}</Text>
        <Text color={scope === "all" ? "green" : "yellow"}>
          {scope === "all" ? "all workspaces" : "this workspace"}
        </Text>
      </Text>
      <Box marginTop={1}>
        <Text>{"query: "}</Text>
        <TextInput value={q} onChange={setQ} onSubmit={() => {}} />
      </Box>

      {error && (
        <Box marginTop={1}>
          <Text color="red">error: {error}</Text>
        </Box>
      )}

      {q.trim().length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>
            Hybrid search (FTS5 keywords + vector + recency) over every
            message, tool call, and assistant reply.{" "}
            {scope === "all"
              ? "Searching sessions in every workspace, ranked as one batch and reranked by a cross-encoder."
              : "Searching sessions in this workspace only — press Tab to search every workspace."}
          </Text>
        </Box>
      ) : isSearching && hits.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>searching…</Text>
        </Box>
      ) : hits.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>(no matches)</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {hits.map((hit, i) => (
            <SearchHitRow
              key={hit.sessionId}
              hit={hit}
              selected={i === idx}
              showWorkspace={scope === "all"}
            />
          ))}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          ↑↓ navigate · Enter to focus session · Tab to switch scope · Esc to close
        </Text>
      </Box>
    </Box>
  );
}

function SearchHitRow({
  hit,
  selected,
  showWorkspace,
}: {
  hit: SessionSearchHit;
  selected: boolean;
  /** Cross-workspace results are ambiguous without the originating repo. */
  showWorkspace?: boolean;
}) {
  const bar = selected ? "▸ " : "  ";
  const when = formatAgo(hit.lastMatchAt);
  const top = hit.snippets[0];
  const where = showWorkspace ? basename(hit.workdir) : "";
  return (
    <Box flexDirection="column" marginBottom={0}>
      <Text color={selected ? "cyan" : "white"} bold={selected}>
        {bar}
        {hit.sessionName}
        {where && <Text dimColor>{` [${where}]`}</Text>}
        <Text dimColor>
          {` — ${hit.matchCount} match${hit.matchCount === 1 ? "" : "es"} · ${when}`}
        </Text>
      </Text>
      {top && (
        <Text dimColor>
          {"    "}
          {top.kind === "user_turn"
            ? "you: "
            : top.kind === "assistant_turn"
              ? "claude: "
              : top.kind === "tool_call"
                ? (top.toolName ? `${top.toolName}: ` : "tool: ")
                : "!: "}
          {compactExcerpt(top.excerpt)}
        </Text>
      )}
    </Box>
  );
}

/**
 * Last path segment of a workdir, for labelling cross-workspace hits.
 * Total on purpose: a hit whose session is no longer live can carry an
 * empty workdir, and a missing repo label must not break the result list.
 */
function basename(p: string | undefined): string {
  if (!p) return "";
  const trimmed = p.replace(/[/\\]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}

function formatAgo(when: number): string {
  const dt = Math.max(0, Date.now() - when);
  if (dt < 60_000) return "just now";
  if (dt < 3_600_000) return `${Math.round(dt / 60_000)}m ago`;
  if (dt < 86_400_000) return `${Math.round(dt / 3_600_000)}h ago`;
  return `${Math.round(dt / 86_400_000)}d ago`;
}

function compactExcerpt(s: string): string {
  // Collapse internal whitespace + cap length for a single inline row.
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.length > 120 ? `${collapsed.slice(0, 117)}…` : collapsed;
}

function HelpModal({ onCancel }: { onCancel: () => void }) {
  useInput((_input, key) => {
    if (key.escape || key.return) onCancel();
  });
  return (
    <Box flexDirection="column" borderStyle="double" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        Keybindings
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text bold>Ctrl-N</Text> new session
        </Text>
        <Text>
          <Text bold>Ctrl-G</Text> switch session
        </Text>
        <Text>
          <Text bold>Ctrl-D</Text> destroy focused session
        </Text>
        <Text>
          <Text bold>Ctrl-X</Text> interrupt focused session
        </Text>
        <Text>
          <Text bold>y / n</Text> approve/deny pending tool
        </Text>
        <Text>
          <Text bold>Shift-Tab / Ctrl-M</Text> cycle mode (interactive → guarded → autonomous)
        </Text>
        <Text>
          <Text bold>?</Text> show this help
        </Text>
        <Text>
          <Text bold>Ctrl-C</Text> quit
        </Text>
        <Text> </Text>
        <Text dimColor>Prompt:</Text>
        <Text>
          <Text bold>Alt-Enter / Ctrl-J / \&lt;Enter&gt;</Text> newline · <Text bold>Up/Down</Text> history
        </Text>
        <Text>
          <Text bold>Ctrl-A/E</Text> line start/end · <Text bold>Ctrl-U/K</Text> clear to start/end · <Text bold>Ctrl-W</Text> delete word
        </Text>
        <Text>
          Type <Text bold>/</Text> for slash commands (Tab completes, Enter runs).
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Esc / Enter to close</Text>
      </Box>
    </Box>
  );
}
