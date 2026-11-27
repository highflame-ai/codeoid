/**
 * `/loops` — the owner's loop runs (docs/loops.md): a list, one run's detail
 * (the same lines `codeoid loop show` prints), and the controls. Starting a
 * run is left to `codeoid loop start`, which takes checks as flags.
 *
 * There is no push for loops, so the open view re-reads every few seconds.
 *
 *   list    ↑↓ move · Enter open · Esc close
 *   detail  s steer (or answer) · p pause · r resume · c cancel · h history ·
 *           o open the worker session · Esc back
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { DaemonMessage, LoopAttemptWire, LoopEventWire, LoopRunWire } from "../../protocol/types.js";
import { LOOP_APPROVAL_WAIT, LOOP_OUTCOME, formatLoop, formatLoopRow } from "../../terminal/loop-format.js";
import { sanitizeTerminalOutput } from "../ansi/codes.js";

/** The slice of the daemon client this view uses (tests pass a fake). */
export interface LoopsClient {
  loopList(limit?: number): Promise<DaemonMessage>;
  loopGet(runId: string, events?: boolean): Promise<DaemonMessage>;
  loopControl(verb: "pause" | "resume" | "cancel", runId: string): Promise<DaemonMessage>;
  loopSteer(runId: string, text: string): Promise<DaemonMessage>;
}

interface Props {
  client: LoopsClient | null;
  /** Open on this run's detail: a full id, or an unambiguous prefix of one. */
  initialRunId?: string;
  /** Focus a session (the run's worker) and close. */
  onOpenSession: (sessionId: string) => void;
  onCancel: () => void;
  /** Re-read cadence; tests shorten it. */
  pollMs?: number;
}

type Mode = "list" | "detail" | "steer" | "confirm-cancel";

interface Snapshot {
  run: LoopRunWire;
  attempts: LoopAttemptWire[];
  events?: LoopEventWire[];
}

const LIVE_STATUSES: ReadonlySet<LoopRunWire["status"]> = new Set(["running", "verifying", "waiting", "paused"]);

function errorOf(res: DaemonMessage): string {
  return res.type === "response.error" ? res.error : `unexpected reply: ${res.type}`;
}

/**
 * Model-authored text (a worker's summary, its question) reaches the terminal
 * here. Plain text only: after the shared sanitizer, the colour and link
 * sequences it keeps go too, then any control byte left.
 */
function clean(line: string): string {
  return sanitizeTerminalOutput(line)
    .replace(/\x1b\[[0-9;:]*m/g, "")
    .replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

const FULL_ID = /^loop_[0-9a-f-]{36}$/;

export function LoopsModal({ client, initialRunId, onOpenSession, onCancel, pollMs = 3_000 }: Props) {
  const exact = initialRunId && FULL_ID.test(initialRunId) ? initialRunId : null;
  const [mode, setMode] = useState<Mode>(exact ? "detail" : "list");
  const [runs, setRuns] = useState<LoopRunWire[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [selected, setSelected] = useState<string | null>(exact);
  /** A shortened id to open once the list is in (like `codeoid loop show <prefix>`). */
  const prefixRef = useRef(exact ? null : (initialRunId ?? null));
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [history, setHistory] = useState(false);
  const [steer, setSteer] = useState("");
  const [busy, setBusy] = useState(false);
  const inflight = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Replies for a run the view has since left are dropped.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const loadList = useCallback(async () => {
    if (!client) return setError("Not connected");
    try {
      const res = await client.loopList();
      if (res.type !== "loop.list.result") return setError(errorOf(res));
      setRuns(res.runs);
      setIdx((i) => Math.min(i, Math.max(0, res.runs.length - 1)));
      const prefix = prefixRef.current;
      if (prefix) {
        prefixRef.current = null;
        const hits = res.runs.filter((r) => r.id.startsWith(prefix) || r.id.startsWith(`loop_${prefix}`));
        if (hits.length === 1) open(hits[0]!.id);
        else setError(hits.length === 0 ? `No loop run matches "${prefix}".` : `"${prefix}" matches ${hits.length} runs; give more of the id.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client]);

  const loadRun = useCallback(
    async (runId: string) => {
      if (!client) return setError("Not connected");
      try {
        const res = await client.loopGet(runId, history);
        if (selectedRef.current !== runId) return;
        if (res.type !== "loop.snapshot") return setError(errorOf(res));
        setSnap({ run: res.run, attempts: res.attempts, ...(res.events ? { events: res.events } : {}) });
      } catch (e) {
        if (selectedRef.current === runId) setError(e instanceof Error ? e.message : String(e));
      }
    },
    [client, history],
  );

  // Read now, then keep reading while open: the run's detail, or the list.
  useEffect(() => {
    const read = () => void (selected ? loadRun(selected) : loadList());
    read();
    const timer = setInterval(read, pollMs);
    return () => clearInterval(timer);
  }, [selected, loadRun, loadList, pollMs]);

  /** A control's reply is the run's new state. */
  const act = async (what: string, call: () => Promise<DaemonMessage>) => {
    // Cancel may overlap another control, so busy clears when the last one ends.
    inflight.current += 1;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await call();
      if (res.type !== "loop.snapshot") {
        setError(errorOf(res));
        return false;
      }
      setSnap((s) => ({ run: res.run, attempts: res.attempts, ...(s?.events ? { events: s.events } : {}) }));
      setNotice(what);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      inflight.current -= 1;
      setBusy(inflight.current > 0);
    }
  };

  const open = (runId: string) => {
    setSelected(runId);
    setSnap(null);
    setHistory(false);
    setError(null);
    setNotice(null);
    setMode("detail");
  };

  const run = snap?.run ?? null;
  const question = run?.status === "waiting" && (run.waitingKind ? run.waitingKind === "question" : run.waitingOn !== LOOP_APPROVAL_WAIT);

  useInput((input, key) => {
    if (mode === "steer") {
      if (key.escape) setMode("detail");
      return;
    }
    if (mode === "confirm-cancel") {
      if (input === "y" || input === "Y") {
        setMode("detail");
        if (run) void act("Cancelled.", () => client!.loopControl("cancel", run.id));
      } else if (key.escape || input === "n" || input === "N") setMode("detail");
      return;
    }
    if (mode === "list") {
      const list = runs ?? [];
      if (key.escape) onCancel();
      else if (key.upArrow) setIdx((i) => Math.max(0, i - 1));
      else if (key.downArrow) setIdx((i) => Math.min(list.length - 1, i + 1));
      else if (key.return && list[idx]) open(list[idx]!.id);
      return;
    }
    // detail
    if (key.escape) {
      setSelected(null);
      setSnap(null);
      setError(null);
      setNotice(null);
      setMode("list");
      return;
    }
    if (!run || !client) return;
    const live = LIVE_STATUSES.has(run.status);
    // Cancel is a safety stop: it stays available while another request runs.
    if (input === "c" && live) {
      setMode("confirm-cancel");
      return;
    }
    if (busy) return;
    if (input === "s" && live) {
      setSteer("");
      setMode("steer");
    } else if (input === "p" && live && run.status !== "paused") void act("Pausing at the next attempt boundary.", () => client.loopControl("pause", run.id));
    else if (input === "r" && run.status === "paused") void act("Resumed.", () => client.loopControl("resume", run.id));
    else if (input === "h") setHistory((h) => !h);
    else if (input === "o" && run.workerSessionId) onOpenSession(run.workerSessionId);
  });

  const submitSteer = (text: string) => {
    const body = text.trim();
    if (!body || !run || !client) return;
    setMode("detail");
    void act(question ? "Answer sent." : "Steering queued for the next attempt.", () => client.loopSteer(run.id, body));
  };

  return (
    <Box flexDirection="column" borderStyle="double" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        Loops
        <Text dimColor>{"  ·  done only when the daemon's own checks pass"}</Text>
      </Text>
      {error && <Text color="red">{clean(error)}</Text>}
      {notice && <Text color="green">{notice}</Text>}

      {mode === "list" ? (
        <Box flexDirection="column" marginTop={1}>
          {runs === null ? (
            <Text dimColor>loading…</Text>
          ) : runs.length === 0 ? (
            <Text dimColor>No loop runs yet.</Text>
          ) : (
            runs.map((r, i) => (
              <Text key={r.id} color={i === idx ? "cyan" : "white"} bold={i === idx}>
                {i === idx ? "▸ " : "  "}
                {clean(formatLoopRow(r))}
              </Text>
            ))
          )}
          <Box marginTop={1}>
            <Text dimColor>↑↓ move · Enter open · Esc close · start one with `codeoid loop start "…" --workdir … --check "…"`</Text>
          </Box>
        </Box>
      ) : !run ? (
        <Box marginTop={1}>
          <Text dimColor>loading…</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {run.status === "waiting" && (
            <Text color="yellow" bold>
              {question
                ? `The worker asks: ${clean((run.waitingOn ?? "").replace(/^the owner's answer:\s*/, ""))}`
                : "Waiting on an approval in the worker session — press o to open it."}
            </Text>
          )}
          {LOOP_OUTCOME[run.status] && (
            <Text color={run.status === "completed" ? "green" : run.status === "cancelled" ? "gray" : run.status === "budget_exhausted" ? "yellow" : "red"}>
              {LOOP_OUTCOME[run.status]}
            </Text>
          )}
          {formatLoop(run, snap!.attempts, history ? snap!.events : undefined).map((line, i) => (
            <Text key={i}>{clean(line)}</Text>
          ))}
          {mode === "steer" ? (
            <Box marginTop={1}>
              <Text color="cyan">{question ? "Your answer: " : "Steer the next attempt: "}</Text>
              <TextInput value={steer} onChange={setSteer} onSubmit={submitSteer} />
            </Box>
          ) : mode === "confirm-cancel" ? (
            <Box marginTop={1}>
              <Text color="red">Stop the run now? y to cancel it · n/Esc to keep it running</Text>
            </Box>
          ) : (
            <Box marginTop={1}>
              <Text dimColor>
                {LIVE_STATUSES.has(run.status)
                  ? `${question ? "s answer" : "s steer"} · ${run.status === "paused" ? "r resume" : "p pause"} · c cancel · `
                  : ""}
                h {history ? "hide" : "show"} history{run.workerSessionId ? " · o open worker session" : ""} · Esc back
              </Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
