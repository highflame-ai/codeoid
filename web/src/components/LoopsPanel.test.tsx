// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";

import { LoopDetail, type LoopDetailProps } from "./LoopDetail";
import { LoopList } from "./LoopsPanel";
import { LoopStartForm } from "./LoopStartForm";
import { LOOP_APPROVAL_WAIT } from "../lib/loops";
import type { LoopAttemptWire, LoopRunWire } from "../protocol/types";

afterEach(cleanup);

const NOW = Date.parse("2026-10-25T12:00:00.000Z");

function run(over: Partial<LoopRunWire> = {}): LoopRunWire {
  return {
    id: "loop_1",
    recipe: "repair",
    objective: "Fix the checkout test\nIt fails on a rounding error.",
    workdir: "/repo",
    checks: [{ id: "unit", command: "bun test src/checkout", timeoutSec: 600 }],
    limits: { attempts: 3, attemptMinutes: 10, runMinutes: 30 },
    toolBudget: 60,
    status: "running",
    reason: "attempt 2 started",
    waitingOn: null, waitingKind: null,
    baseRevision: "0123456789abcdef",
    branch: "codeoid/loop-1",
    worktreePath: "/wt",
    workerSessionId: "sess-w",
    acceptedAttemptId: null,
    deliveredCommit: null,
    attempts: 2,
    activeMs: 125_000,
    costUsd: 0.42,
    createdAt: "2026-10-25T11:00:00.000Z",
    updatedAt: "2026-10-25T11:50:00.000Z",
    endedAt: null,
    ...over,
  };
}

function attempt(over: Partial<LoopAttemptWire> = {}): LoopAttemptWire {
  return {
    id: "att_1",
    ordinal: 1,
    status: "done",
    result: "unverified",
    note: "1 of 1 checks failed",
    report: { outcome: "ready_for_verification", summary: "Rounded the total before tax" },
    candidateTree: "tree1",
    evidenceIds: ["ev_1", "ev_2"],
    workerSessionId: "sess-w",
    provider: "claude",
    model: null,
    startedAt: "2026-10-25T11:00:00.000Z",
    endedAt: "2026-10-25T11:01:30.000Z",
    costUsd: 0.2,
    ...over,
  };
}

function detailProps(over: Partial<LoopDetailProps> = {}): LoopDetailProps {
  return {
    run: run(),
    attempts: [attempt()],
    events: null,
    historyOpen: false,
    now: NOW,
    workerAvailable: true,
    onBack: vi.fn(),
    onPause: vi.fn(),
    onResume: vi.fn(),
    onCancel: vi.fn(),
    onSteer: vi.fn(async () => true),
    onOpenWorker: vi.fn(),
    onToggleHistory: vi.fn(),
    ...over,
  };
}

const button = (root: HTMLElement, name: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === name) as HTMLButtonElement | undefined;

describe("LoopList", () => {
  it("renders one row per run: status, objective's first line, attempts, cost, age", () => {
    const onSelect = vi.fn();
    const { getAllByTestId } = render(() => (
      <LoopList
        runs={[run(), run({ id: "loop_2", status: "completed", objective: "Make lint pass", attempts: 1, costUsd: 0.05 })]}
        loaded
        now={NOW}
        onSelect={onSelect}
        onNew={vi.fn()}
      />
    ));
    const rows = getAllByTestId("loop-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Fix the checkout test");
    expect(rows[0]!.textContent).not.toContain("rounding error");
    expect(rows[0]!.textContent).toContain("2/3");
    expect(rows[0]!.textContent).toContain("$0.42");
    expect(rows[0]!.textContent).toContain("1h ago");
    expect(rows[1]!.textContent).toContain("verified");
    fireEvent.click(rows[1]!);
    expect(onSelect).toHaveBeenCalledWith("loop_2");
  });

  it("says what a loop is when there are none", () => {
    const onNew = vi.fn();
    const { container } = render(() => <LoopList runs={[]} loaded now={NOW} onSelect={vi.fn()} onNew={onNew} />);
    expect(container.textContent).toContain("No loop runs yet");
    fireEvent.click(button(container, "Start a loop")!);
    expect(onNew).toHaveBeenCalled();
  });
});

describe("LoopDetail", () => {
  it("shows the contract: branch and base, budget, checks", () => {
    const { container, getByTestId } = render(() => <LoopDetail {...detailProps()} />);
    expect(container.textContent).toContain("codeoid/loop-1");
    expect(container.textContent).toContain("from 0123456789ab");
    expect(getByTestId("loop-budget").textContent).toContain("2/3 attempts");
    expect(getByTestId("loop-budget").textContent).toContain("2m 5s of 30m");
    expect(getByTestId("loop-budget").textContent).toContain("60 tool calls per attempt");
    expect(container.textContent).toContain("bun test src/checkout");
  });

  it("lists attempts with their result, note, worker report, duration, cost and evidence", () => {
    const { getAllByTestId } = render(() => (
      <LoopDetail {...detailProps({ attempts: [attempt(), attempt({ id: "att_2", ordinal: 2, result: null, status: "running", report: null, note: null, endedAt: null, startedAt: "2026-10-25T11:59:00.000Z", evidenceIds: [] })] })} />
    ));
    const [first, second] = getAllByTestId("loop-attempt");
    expect(first!.textContent).toContain("#1");
    expect(first!.textContent).toContain("checks failed");
    expect(first!.textContent).toContain("1 of 1 checks failed");
    expect(first!.textContent).toContain("ready_for_verification");
    expect(first!.textContent).toContain("Rounded the total before tax");
    expect(first!.textContent).toContain("1m 30s");
    expect(first!.textContent).toContain("$0.20");
    expect(first!.textContent).toContain("Show check output (2 checks)");
    expect(second!.textContent).toContain("running");
    expect(second!.textContent).toContain("1m");
    expect(second!.textContent).not.toContain("Show check output");
  });

  it("puts a question first and labels the steer box as the answer", async () => {
    const onSteer = vi.fn(async () => true);
    const { container, getByTestId, getByLabelText } = render(() => (
      <LoopDetail {...detailProps({ run: run({ status: "waiting", waitingOn: "the owner's answer: Keep the v1 API?" }), onSteer })} />
    ));
    expect(getByTestId("loop-waiting").textContent).toContain("Keep the v1 API?");
    expect(getByTestId("loop-waiting").textContent).not.toContain("the owner's answer");
    const box = getByLabelText("Your answer") as HTMLTextAreaElement;
    fireEvent.input(box, { target: { value: "Yes, keep it" } });
    fireEvent.click(button(container, "Answer")!);
    await Promise.resolve();
    expect(onSteer).toHaveBeenCalledWith("Yes, keep it");
  });

  it("an approval wait points at the worker session", () => {
    const { getByTestId, queryByLabelText } = render(() => (
      <LoopDetail {...detailProps({ run: run({ status: "waiting", waitingOn: LOOP_APPROVAL_WAIT }) })} />
    ));
    expect(getByTestId("loop-waiting").textContent).toContain("approval");
    expect(queryByLabelText("Your answer")).toBeNull();
    expect(queryByLabelText("Steer the next attempt")).not.toBeNull();
  });

  it("enables the controls a running run accepts, and cancel asks first", () => {
    const p = detailProps();
    const { container } = render(() => <LoopDetail {...p} />);
    expect(button(container, "Pause")!.disabled).toBe(false);
    expect(button(container, "Resume")).toBeUndefined();
    fireEvent.click(button(container, "Cancel run")!);
    expect(p.onCancel).not.toHaveBeenCalled();
    fireEvent.click(button(container, "Yes, cancel")!);
    expect(p.onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(button(container, "Open worker session")!);
    expect(p.onOpenWorker).toHaveBeenCalled();
  });

  it("a paused run offers Resume", () => {
    const p = detailProps({ run: run({ status: "paused" }) });
    const { container } = render(() => <LoopDetail {...p} />);
    expect(button(container, "Pause")).toBeUndefined();
    fireEvent.click(button(container, "Resume")!);
    expect(p.onResume).toHaveBeenCalled();
  });

  it("an ended run has no live controls and says how it ended", () => {
    const { container, getByTestId, queryByLabelText } = render(() => (
      <LoopDetail {...detailProps({ run: run({ status: "completed", deliveredCommit: "abc123def456", endedAt: "2026-10-25T11:58:00.000Z" }), workerAvailable: false })} />
    ));
    expect(button(container, "Pause")!.disabled).toBe(true);
    expect(button(container, "Cancel run")!.disabled).toBe(true);
    expect(button(container, "Open worker session")!.disabled).toBe(true);
    expect(queryByLabelText("Steer the next attempt")).toBeNull();
    expect(getByTestId("loop-status").textContent).toContain("verified");
    expect(getByTestId("loop-outcome").textContent).toContain("Every check passed on the delivered commit");
    expect(getByTestId("loop-commit").textContent).toBe("abc123def456");
  });

  it("tells out of budget, blocked and failed apart", () => {
    const words = (["budget_exhausted", "blocked", "failed"] as const).map((status) => {
      const { getByTestId, unmount } = render(() => <LoopDetail {...detailProps({ run: run({ status }) })} />);
      const text = `${getByTestId("loop-status").textContent} ${getByTestId("loop-outcome").textContent}`;
      unmount();
      return text;
    });
    expect(words[0]).toContain("out of budget");
    expect(words[0]).toContain("attempts or time ran out");
    expect(words[1]).toContain("blocked");
    expect(words[1]).toContain("can't make progress without you");
    expect(words[2]).toContain("failed");
    expect(words[2]).toContain("outside the work");
  });

  it("history opens on request and lists events", () => {
    const p = detailProps();
    const first = render(() => <LoopDetail {...p} />);
    fireEvent.click(button(first.container, "▸ Show history")!);
    expect(p.onToggleHistory).toHaveBeenCalledWith(true);
    first.unmount();
    const { getByTestId } = render(() => (
      <LoopDetail {...detailProps({ historyOpen: true, events: [{ seq: 1, at: "2026-10-25T11:00:00.000Z", actor: "u", type: "run.started", detail: "repair" }] })} />
    ));
    expect(getByTestId("loop-history").textContent).toContain("run.started");
  });
});

describe("LoopStartForm", () => {
  const providers = [{ id: "claude", label: "Claude" }];

  it("builds the loop.start message from the form", async () => {
    const onSubmit = vi.fn(async () => {});
    const { container, getByLabelText, getAllByTestId } = render(() => (
      <LoopStartForm objective="Fix the checkout test" recentWorkdirs={["/repo"]} providers={providers} onSubmit={onSubmit} onCancel={vi.fn()} />
    ));
    fireEvent.click(button(container, "/repo")!);
    fireEvent.input(getByLabelText("Check 1 id"), { target: { value: "unit" } });
    fireEvent.input(getByLabelText("Check 1 command"), { target: { value: "bun test src/checkout" } });
    fireEvent.click(getByLabelText("Check 1 is a test run"));
    fireEvent.click(button(container, "+ Add check")!);
    expect(getAllByTestId("loop-check-row")).toHaveLength(2);
    fireEvent.input(getByLabelText("Check 2 command"), { target: { value: "bun run typecheck" } });
    fireEvent.input(getByLabelText("Check 2 timeout seconds"), { target: { value: "120" } });
    fireEvent.input(getByLabelText("Attempts"), { target: { value: "5" } });
    fireEvent.change(getByLabelText("Backend"), { target: { value: "claude" } });
    fireEvent.click(button(container, "Start loop")!);
    await Promise.resolve();
    expect(onSubmit).toHaveBeenCalledWith({
      type: "loop.start",
      objective: "Fix the checkout test",
      workdir: "/repo",
      checks: [
        { id: "unit", command: "bun test src/checkout", expectTests: true },
        { command: "bun run typecheck", timeoutSec: 120 },
      ],
      provider: "claude",
      limits: { attempts: 5 },
    });
  });

  it("shows the defaults and refuses a form without a check", () => {
    const onSubmit = vi.fn(async () => {});
    const { container, getByLabelText, getByRole } = render(() => (
      <LoopStartForm objective="x" recentWorkdirs={[]} providers={providers} onSubmit={onSubmit} onCancel={vi.fn()} />
    ));
    expect((getByLabelText("Attempts") as HTMLInputElement).placeholder).toBe("3");
    expect((getByLabelText("Minutes per attempt") as HTMLInputElement).placeholder).toBe("10");
    expect((getByLabelText("Minutes per run") as HTMLInputElement).placeholder).toBe("30");
    expect((getByLabelText("Tool calls per attempt") as HTMLInputElement).placeholder).toBe("60");
    fireEvent.input(getByLabelText("Repository"), { target: { value: "/repo" } });
    fireEvent.click(button(container, "Start loop")!);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(getByRole("alert").textContent).toBe("Add at least one check: the command that must pass");
  });

  it("shows the daemon's refusal verbatim", async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error("workdir not usable: /nope");
    });
    const { container, getByLabelText, findByRole } = render(() => (
      <LoopStartForm objective="x" recentWorkdirs={[]} providers={providers} onSubmit={onSubmit} onCancel={vi.fn()} />
    ));
    fireEvent.input(getByLabelText("Repository"), { target: { value: "/nope" } });
    fireEvent.input(getByLabelText("Check 1 command"), { target: { value: "make test" } });
    fireEvent.click(button(container, "Start loop")!);
    expect((await findByRole("alert")).textContent).toBe("workdir not usable: /nope");
  });
});
