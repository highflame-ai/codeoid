// @vitest-environment jsdom
/**
 * The automation drawer as a whole: tabs, which store polls, Esc layering,
 * and cross-links between a loop run and the routine that started it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";

const clientRequestMock = vi.hoisted(() => vi.fn());
vi.mock("../state/connection", () => ({
  newRequestId: () => "r",
  getClient: () => ({ request: clientRequestMock }),
}));

import LoopsPanel, { automationTab, closeAutomation, openLoopRun, showLoops, showRoutines, showWatches } from "./LoopsPanel";
import { LoopDetail } from "./LoopDetail";
import { loopRun, routine, watch } from "../lib/automation.fixtures";
import { _resetLoopsForTest, loopsViewOpen } from "../state/loops";
import { _resetRoutinesForTest, routinesViewOpen } from "../state/routines";
import { _resetWatchesForTest, watchesViewOpen } from "../state/watches";

/** Answer each read with what its type asks for. */
function daemon() {
  clientRequestMock.mockImplementation(async (msg: { type: string }) => {
    switch (msg.type) {
      case "loop.list":
        return { type: "loop.list.result", requestId: "r", runs: [loopRun()] };
      case "loop.watch.list":
        return { type: "loop.watch.list.result", requestId: "r", watches: [watch()] };
      case "routine.list":
        return { type: "routine.list.result", requestId: "r", routines: [routine()] };
      default:
        throw new Error(`unexpected ${msg.type}`);
    }
  });
}

afterEach(() => {
  cleanup();
  closeAutomation();
  _resetLoopsForTest();
  _resetRoutinesForTest();
  _resetWatchesForTest();
  clientRequestMock.mockReset();
});

describe("automation drawer", () => {
  it("has three tabs; only the shown tab's view is open", async () => {
    daemon();
    const { getByRole, findAllByTestId } = render(() => <LoopsPanel />);
    showRoutines();
    const tabs = getByRole("tablist", { name: "Automation" });
    expect(tabs.querySelectorAll('[role="tab"]')).toHaveLength(3);
    expect(getByRole("tab", { name: /Routines/ }).getAttribute("aria-selected")).toBe("true");
    expect(getByRole("tabpanel").getAttribute("aria-labelledby")).toBe("automation-tab-routines");
    expect(await findAllByTestId("routine-row")).toHaveLength(1);
    expect([loopsViewOpen(), watchesViewOpen(), routinesViewOpen()]).toEqual([false, false, true]);

    fireEvent.click(getByRole("tab", { name: /Watches/ }));
    expect(await findAllByTestId("watch-row")).toHaveLength(1);
    expect([loopsViewOpen(), watchesViewOpen(), routinesViewOpen()]).toEqual([false, true, false]);
    expect(getByRole("button", { name: "New watch" })).toBeTruthy();
  });

  it("moves between tabs with the arrow keys", async () => {
    daemon();
    const { getByRole } = render(() => <LoopsPanel />);
    showLoops();
    const runs = getByRole("tab", { name: /Loop runs/ });
    fireEvent.keyDown(runs, { key: "ArrowRight" });
    expect(automationTab()).toBe("watches");
    await waitFor(() => expect(document.activeElement?.id).toBe("automation-tab-watches"));
    fireEvent.keyDown(getByRole("tab", { name: /Watches/ }), { key: "End" });
    expect(automationTab()).toBe("routines");
    fireEvent.keyDown(getByRole("tab", { name: /Routines/ }), { key: "ArrowRight" });
    expect(automationTab()).toBe("runs");
  });

  it("Esc shuts the drawer, but a dialog above it takes its own Esc first", async () => {
    daemon();
    clientRequestMock.mockImplementation(async (msg: { type: string }) =>
      msg.type === "loop.watch.get"
        ? { type: "loop.watch.snapshot", requestId: "r", watch: watch(), triggers: [] }
        : { type: "loop.watch.list.result", requestId: "r", watches: [watch()] },
    );
    const { getByRole, findByTestId, queryByRole } = render(() => <LoopsPanel />);
    showWatches("w_1");
    await findByTestId("watch-detail");
    fireEvent.click(getByRole("button", { name: "Delete" }));
    expect(getByRole("alertdialog")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await new Promise((r) => setTimeout(r, 0));
    expect(queryByRole("alertdialog")).toBeNull();
    expect(automationTab()).toBe("watches");

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(automationTab()).toBeNull());
  });

  it("a loop run opened from a watch or routine shows on the runs tab", async () => {
    clientRequestMock.mockResolvedValue({ type: "loop.snapshot", requestId: "r", run: loopRun(), attempts: [] });
    const { findByTestId } = render(() => <LoopsPanel />);
    showRoutines();
    openLoopRun("loop_1");
    expect(automationTab()).toBe("runs");
    expect(routinesViewOpen()).toBe(false);
    expect(await findByTestId("loop-detail")).toBeTruthy();
  });
});

describe("LoopDetail — started by a routine", () => {
  it("names the routine and links to it", () => {
    const onOpenRoutine = vi.fn();
    const run = loopRun({ trigger: { kind: "routine", key: "routine:rt_1:run_1", routineId: "rt_1", routineName: "flaky-repair", routineRunId: "run_1", summary: "" } });
    const { getByTestId, getByRole } = render(() => (
      <LoopDetail
        run={run}
        attempts={[]}
        events={null}
        historyOpen={false}
        now={Date.now()}
        workerAvailable={false}
        onBack={vi.fn()}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onCancel={vi.fn()}
        onSteer={vi.fn(async () => true)}
        onOpenWorker={vi.fn()}
        onToggleHistory={vi.fn()}
        onOpenRoutine={onOpenRoutine}
      />
    ));
    expect(getByTestId("loop-trigger").textContent).toContain("your routine flaky-repair");
    fireEvent.click(getByRole("button", { name: "flaky-repair" }));
    expect(onOpenRoutine).toHaveBeenCalledWith("rt_1");
  });
});
