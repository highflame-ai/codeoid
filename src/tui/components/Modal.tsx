/**
 * Modal — overlay dialogs for new-session, switch-session, destroy confirm,
 * and cross-session search. Intentionally minimal; renders inline at the
 * bottom so it doesn't fight with Ink's single-surface render model.
 */

import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { ModalState, TuiSession } from "../types.js";
import type { SessionSearchHit } from "../../protocol/types.js";
import { MODEL_CATALOG, findModel, type ModelDescriptor } from "../../daemon/models.js";

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
  onSubmitNewSession: (name: string, workdir: string) => void;
  onSelectSession: (sessionId: string) => void;
  onConfirmDestroy: (sessionId: string) => void;
  onCancel: () => void;
  /** Run a full-text + semantic session search. Resolves to result hits. */
  onSearch?: (query: string, scope: SearchScope) => Promise<SessionSearchHit[]>;
  /** Set the focused session's model. */
  onSetModel?: (model: string) => Promise<void>;
}

export function Modal(props: Props) {
  switch (props.modal.kind) {
    case "new-session":
      return (
        <NewSessionModal onSubmit={props.onSubmitNewSession} onCancel={props.onCancel} />
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
      return (
        <ModelModal
          current={props.focusedSession?.info.model ?? null}
          onPick={async (modelId) => {
            if (!props.onSetModel) return;
            await props.onSetModel(modelId);
          }}
          onCancel={props.onCancel}
        />
      );
  }
}

function NewSessionModal({
  onSubmit,
  onCancel,
}: {
  onSubmit: (name: string, workdir: string) => void;
  onCancel: () => void;
}) {
  // Both fields are always rendered as TextInputs so the workdir is
  // visibly editable. `focused` controls which one captures keystrokes
  // (via ink-text-input's `focus` prop). Tab / Enter on name moves focus
  // to workdir; Enter on workdir submits.
  const [focused, setFocused] = useState<"name" | "workdir">("name");
  const [name, setName] = useState("");
  const [workdir, setWorkdir] = useState(process.cwd());

  useInput((_input, key) => {
    if (key.escape) onCancel();
    if (key.tab) {
      setFocused((f) => (f === "name" ? "workdir" : "name"));
    }
  });

  const pointer = (field: "name" | "workdir") =>
    focused === field ? "▸ " : "  ";

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="cyan"
      paddingX={1}
      paddingY={0}
    >
      <Text bold color="cyan">
        New Session
      </Text>
      <Box marginTop={1}>
        <Text color={focused === "name" ? "cyan" : undefined}>
          {pointer("name")}name:
        </Text>
        <TextInput
          focus={focused === "name"}
          value={name}
          onChange={setName}
          onSubmit={() => {
            if (name.trim()) setFocused("workdir");
          }}
        />
      </Box>
      <Box>
        <Text color={focused === "workdir" ? "cyan" : undefined}>
          {pointer("workdir")}workdir:
        </Text>
        <TextInput
          focus={focused === "workdir"}
          value={workdir}
          onChange={setWorkdir}
          onSubmit={() => {
            if (name.trim() && workdir.trim())
              onSubmit(name.trim(), workdir.trim());
          }}
        />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          Tab switches fields · Enter on name → workdir · Enter on workdir creates · Esc cancels
        </Text>
      </Box>
    </Box>
  );
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

// ── Model picker ────────────────────────────────────────────────────────

function ModelModal({
  current,
  onPick,
  onCancel,
}: {
  current: string | null;
  onPick: (modelId: string) => Promise<void>;
  onCancel: () => void;
}) {
  // Pre-select the current model when present, else default to index 0.
  const initialIdx = (() => {
    if (!current) return 0;
    const hit = MODEL_CATALOG.findIndex(
      (m) => m.id === current || m.alias === current,
    );
    return hit >= 0 ? hit : 0;
  })();
  const [idx, setIdx] = useState(initialIdx);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useInput((_input, key) => {
    if (busy) return;
    if (key.escape) onCancel();
    if (key.upArrow) setIdx((i) => Math.max(0, i - 1));
    if (key.downArrow) setIdx((i) => Math.min(MODEL_CATALOG.length - 1, i + 1));
    if (key.return) {
      const pick = MODEL_CATALOG[idx];
      if (!pick) return;
      setBusy(true);
      setError(null);
      onPick(pick.id)
        .then(() => onCancel())
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err));
          setBusy(false);
        });
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="cyan"
      paddingX={1}
    >
      <Text bold color="cyan">
        Select model
      </Text>
      <Box marginTop={1} flexDirection="column">
        {MODEL_CATALOG.map((m, i) => (
          <ModelRow
            key={m.id}
            model={m}
            selected={i === idx}
            active={m.id === current}
          />
        ))}
      </Box>
      {error && (
        <Box marginTop={1}>
          <Text color="red">⚠ {error}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>
          {busy
            ? "switching…"
            : "↑↓ navigate · Enter to switch · Esc to cancel · switching invalidates prompt cache"}
        </Text>
      </Box>
    </Box>
  );
}

function ModelRow({
  model,
  selected,
  active,
}: {
  model: ModelDescriptor;
  selected: boolean;
  active: boolean;
}) {
  const tierColor =
    model.tier === "premium"
      ? "magenta"
      : model.tier === "balanced"
        ? "cyan"
        : "green";
  const bar = selected ? "▸ " : "  ";
  const activeBadge = active ? " ●" : "";
  return (
    <Box flexDirection="column" marginBottom={0}>
      <Text color={selected ? "white" : tierColor} bold={selected}>
        {bar}
        {model.label}
        <Text dimColor>
          {` — ${model.alias} · ${Math.round(model.contextWindow / 1000)}k ctx`}
        </Text>
        {active && <Text color="green">{activeBadge}</Text>}
      </Text>
      <Text dimColor>{`    ${model.description}`}</Text>
    </Box>
  );
}

// Re-export so callers (App.tsx slash handler) can resolve aliases without
// reaching into the daemon module directly — keeps the TUI layer's imports
// predictable.
export { findModel };

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
