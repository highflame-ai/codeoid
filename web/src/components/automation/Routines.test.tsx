// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";

import { RoutineDetail, type RoutineDetailProps } from "./RoutineDetail";
import { RoutineForm, type RoutineFormProps } from "./RoutineForm";
import { RoutineList } from "./RoutinesTab";
import { routine, runWire } from "../../lib/automation.fixtures";

afterEach(cleanup);

const NOW = Date.parse("2026-10-26T12:00:00.000Z");

function detailProps(over: Partial<RoutineDetailProps> = {}): RoutineDetailProps {
  return {
    routine: routine(),
    runs: [runWire()],
    now: NOW,
    sessionIds: new Set(["sess-1"]),
    onBack: vi.fn(),
    onEdit: vi.fn(),
    onSetEnabled: vi.fn(),
    onRunNow: vi.fn(async () => true),
    onCancelRun: vi.fn(),
    onDelete: vi.fn(async () => true),
    onRotateToken: vi.fn(async () => {}),
    onDismissToken: vi.fn(),
    onOpenSession: vi.fn(),
    onOpenLoopRun: vi.fn(),
    ...over,
  };
}

function formProps(over: Partial<RoutineFormProps> = {}): RoutineFormProps {
  return {
    recentWorkdirs: ["/repo"],
    providers: [{ id: "claude", label: "Claude" }],
    now: NOW,
    preview: vi.fn(async () => ["2026-10-26T13:00:00.000Z", "2026-10-26T14:00:00.000Z", "2026-10-26T15:00:00.000Z"]),
    onSubmit: vi.fn(async () => {}),
    onCancel: vi.fn(),
    previewDelayMs: 0,
    ...over,
  };
}

describe("RoutineList", () => {
  it("explains routines (and when to use a watch or a loop) when there are none", () => {
    const onNew = vi.fn();
    const { getByTestId, getByRole } = render(() => <RoutineList routines={[]} loaded now={NOW} onSelect={vi.fn()} onNew={onNew} />);
    expect(getByTestId("routines-empty").textContent).toMatch(/saved agent task/);
    expect(getByTestId("automation-explainer").textContent).toMatch(/Watch:.*Routine:/s);
    fireEvent.click(getByRole("button", { name: "Create a routine" }));
    expect(onNew).toHaveBeenCalled();
  });

  it("shows each routine's schedule in words, next fire, gate, state and last outcome", () => {
    const onSelect = vi.fn();
    const { getAllByTestId, getByRole } = render(() => (
      <RoutineList
        routines={[
          routine({ lastRun: runWire({ status: "failed" }) }),
          routine({ id: "rt_2", name: "digest", enabled: false, pausedReason: "3 failures" }, { schedule: { kind: "cron", expr: "30 8 * * 1-5", timezone: "UTC" }, check: undefined }),
        ]}
        loaded
        now={NOW}
        onSelect={onSelect}
        onNew={vi.fn()}
      />
    ));
    const rows = getAllByTestId("routine-row");
    expect(rows[0]!.textContent).toContain("every 15 minutes");
    expect(rows[0]!.textContent).toContain("next in 15m");
    expect(rows[0]!.textContent).toContain("gated");
    expect(rows[0]!.textContent).toContain("failed");
    expect(rows[1]!.textContent).toContain("weekdays at 08:30 (UTC)");
    expect(rows[1]!.textContent).toContain("auto-paused");
    expect(rows[1]!.textContent).toContain("never run");
    expect(getByRole("list", { name: "Routines" })).toBeTruthy();
    fireEvent.click(rows[1]!);
    expect(onSelect).toHaveBeenCalledWith("rt_2");
  });
});

describe("RoutineDetail", () => {
  it("renders the definition, next fires with absolute times on hover, and runs", () => {
    const { getByTestId, getAllByTestId, container } = render(() => <RoutineDetail {...detailProps()} />);
    expect(getByTestId("routine-schedule").textContent).toContain("every 15 minutes");
    expect(getByTestId("routine-upcoming").querySelectorAll("time")).toHaveLength(3);
    expect(container.querySelector("time")!.getAttribute("title")).toMatch(/2026/);
    expect(getByTestId("routine-check").textContent).toContain("gh run list");
    expect(getByTestId("routine-budget").textContent).toContain("guarded");
    expect(getAllByTestId("routine-run")[0]!.textContent).toContain("CI is green again");
  });

  it("shows why a routine paused itself, and offers resume", () => {
    const onSetEnabled = vi.fn();
    const { getByTestId, getByRole } = render(() => (
      <RoutineDetail {...detailProps({ routine: routine({ enabled: false, pausedReason: "paused after 3 failed runs in a row" }), onSetEnabled })} />
    ));
    expect(getByTestId("routine-paused-reason").textContent).toContain("paused after 3 failed runs in a row");
    expect((getByRole("button", { name: "Run now" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(getByRole("button", { name: "Resume" }));
    expect(onSetEnabled).toHaveBeenCalledWith(true);
  });

  it("runs now, with a payload when one is given", async () => {
    const onRunNow = vi.fn(async () => true);
    const { getByRole, getByLabelText } = render(() => <RoutineDetail {...detailProps({ onRunNow })} />);
    fireEvent.click(getByRole("button", { name: "Run now" }));
    expect(onRunNow).toHaveBeenLastCalledWith();
    fireEvent.click(getByRole("button", { name: "with a payload…" }));
    fireEvent.input(getByLabelText("Payload"), { target: { value: "p99 is 4s" } });
    fireEvent.click(getByRole("button", { name: "Run with payload" }));
    expect(onRunNow).toHaveBeenLastCalledWith("p99 is 4s");
  });

  it("cancels a running run only after confirming", () => {
    const onCancelRun = vi.fn();
    const { getByRole } = render(() => <RoutineDetail {...detailProps({ runs: [runWire({ status: "running", endedAt: undefined })], onCancelRun })} />);
    fireEvent.click(getByRole("button", { name: "cancel" }));
    expect(onCancelRun).not.toHaveBeenCalled();
    fireEvent.click(getByRole("button", { name: "Yes, cancel" }));
    expect(onCancelRun).toHaveBeenCalledWith("run_1");
  });

  it("opens a run's session only when this client can see it, and a run's loop run", () => {
    const onOpenSession = vi.fn();
    const onOpenLoopRun = vi.fn();
    const { getAllByRole, getByRole } = render(() => (
      <RoutineDetail
        {...detailProps({
          runs: [runWire({ sessionId: "sess-1" }), runWire({ id: "run_2", sessionId: "gone", loop: { runId: "loop_7", status: "running" } })],
          onOpenSession,
          onOpenLoopRun,
        })}
      />
    ));
    const open = getAllByRole("button", { name: "open session" }) as HTMLButtonElement[];
    expect(open[0]!.disabled).toBe(false);
    expect(open[1]!.disabled).toBe(true);
    fireEvent.click(open[0]!);
    expect(onOpenSession).toHaveBeenCalledWith("sess-1");
    fireEvent.click(getByRole("button", { name: /loop run/ }));
    expect(onOpenLoopRun).toHaveBeenCalledWith("loop_7");
  });

  it("deletes through a confirm dialog that Esc dismisses", async () => {
    const onDelete = vi.fn(async () => true);
    const { getByRole, queryByRole } = render(() => <RoutineDetail {...detailProps({ onDelete })} />);
    fireEvent.click(getByRole("button", { name: "Delete" }));
    const dialog = getByRole("alertdialog", { name: "Delete ci-watch?" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Cancel"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(queryByRole("alertdialog")).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(getByRole("button", { name: "Delete" }));
    fireEvent.click(getByRole("button", { name: "Delete routine" }));
    await waitFor(() => expect(queryByRole("alertdialog")).toBeNull());
    expect(onDelete).toHaveBeenCalled();
  });

  it("a failed delete keeps the dialog open with the daemon's words", async () => {
    const { getByRole } = render(() => <RoutineDetail {...detailProps({ onDelete: vi.fn(async () => false), error: "a delegated token cannot change routines" })} />);
    fireEvent.click(getByRole("button", { name: "Delete" }));
    fireEvent.click(getByRole("button", { name: "Delete routine" }));
    await waitFor(() => expect(getByRole("alertdialog").textContent).toContain("a delegated token cannot change routines"));
  });

  it("shows a fresh API token once and mints a new one through a confirm", async () => {
    const onRotateToken = vi.fn(async () => {});
    const { getByTestId, getByRole } = render(() => (
      <RoutineDetail {...detailProps({ routine: routine({ apiTokenSet: true }, { api: true }), token: { apiToken: "rt_abcdef", endpointPath: "/routines/rt_1/fire" }, onRotateToken })} />
    ));
    expect(getByTestId("routine-token").textContent).toContain("rt_abcdef");
    fireEvent.click(getByRole("button", { name: "new token…" }));
    expect(getByRole("alertdialog").textContent).toContain("stops working at once");
    fireEvent.click(getByRole("button", { name: "New token" }));
    await waitFor(() => expect(onRotateToken).toHaveBeenCalled());
  });

  it("renders a loop routine's acceptance checks and calls its prompt the objective", () => {
    const r = routine({}, {
      approvals: "autonomous",
      loop: { checks: [{ id: "lint", command: "bun run lint", timeoutSec: 600 }], toolBudget: 60, limits: { attempts: 3, attemptMinutes: 10, runMinutes: 30 } },
    });
    const { getByTestId, getByText } = render(() => <RoutineDetail {...detailProps({ routine: r })} />);
    expect(getByTestId("routine-loop").textContent).toContain("lint: bun run lint");
    expect(getByTestId("routine-budget").textContent).toContain("3 attempts of up to 10m");
    expect(getByText("Objective")).toBeTruthy();
    expect(getByText("Gate")).toBeTruthy();
  });
});

describe("RoutineForm", () => {
  it("validates inline: the field is marked and the reason shown", async () => {
    const onSubmit = vi.fn(async () => {});
    const { getByRole, getByLabelText, getByTestId } = render(() => <RoutineForm {...formProps({ onSubmit })} />);
    fireEvent.click(getByRole("button", { name: "Create routine" }));
    expect(getByTestId("routine-form-error").textContent).toBe("Name the routine");
    expect(getByLabelText("Name").getAttribute("aria-invalid")).toBe("true");
    fireEvent.input(getByLabelText("Name"), { target: { value: "Bad Name" } });
    fireEvent.click(getByRole("button", { name: "Create routine" }));
    expect(getByTestId("routine-form-error").textContent).toMatch(/lowercase/);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("previews the next three fires from the daemon as the schedule changes", async () => {
    const preview = vi.fn(async () => ["2026-10-26T13:00:00.000Z", "2026-10-26T14:00:00.000Z", "2026-10-26T15:00:00.000Z"]);
    const { getByTestId, getByRole, getByLabelText } = render(() => <RoutineForm {...formProps({ preview })} />);
    await waitFor(() => expect(getByTestId("routine-preview").querySelectorAll("time")).toHaveLength(3));
    expect(preview).toHaveBeenLastCalledWith({ kind: "every", seconds: 3600 });
    expect(getByTestId("routine-preview").textContent).toContain("every 1 hour");

    fireEvent.click(getByRole("radio", { name: "Cron" }));
    fireEvent.input(getByLabelText("Timezone"), { target: { value: "Europe/London" } });
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith({ kind: "cron", expr: "0 9 * * 1-5", timezone: "Europe/London" }));
  });

  it("shows the daemon's reason when it rejects the schedule, and the form's own first", async () => {
    const preview = vi.fn(async () => {
      throw new Error('unknown timezone "Mars/Olympus" — use an IANA name such as Europe/London');
    });
    const { getByTestId, getByRole, getByLabelText } = render(() => <RoutineForm {...formProps({ preview })} />);
    fireEvent.click(getByRole("radio", { name: "Cron" }));
    fireEvent.input(getByLabelText("Timezone"), { target: { value: "Mars/Olympus" } });
    await waitFor(() => expect(getByTestId("routine-preview").textContent).toContain('unknown timezone "Mars/Olympus"'));
    fireEvent.input(getByLabelText("Cron expression"), { target: { value: "0 9" } });
    await waitFor(() => expect(getByTestId("routine-preview").textContent).toContain("A cron has 5 fields"));
  });

  it("submits a create with the spec", async () => {
    const onSubmit = vi.fn(async () => {});
    const { getByRole, getByLabelText } = render(() => <RoutineForm {...formProps({ onSubmit })} />);
    fireEvent.input(getByLabelText("Name"), { target: { value: "digest" } });
    fireEvent.input(getByLabelText("Workdir"), { target: { value: "/repo" } });
    fireEvent.input(getByLabelText("Prompt"), { target: { value: "Summarise new issues" } });
    fireEvent.input(getByLabelText("Check command"), { target: { value: "gh issue list" } });
    fireEvent.click(getByRole("button", { name: "Create routine" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect((onSubmit.mock.calls as unknown[][])[0]![0]).toMatchObject({
      kind: "create",
      spec: { name: "digest", workdir: "/repo", prompt: "Summarise new issues", schedule: { kind: "every", seconds: 3600 }, check: { command: "gh issue list" }, approvals: "guarded" },
    });
  });

  it("keeps the daemon's refusal in the form", async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error("Missing scope: session:approve (an autonomous routine, or one with a check command, pre-approves work)");
    });
    const { getByRole, getByLabelText, findByText } = render(() => <RoutineForm {...formProps({ onSubmit })} />);
    fireEvent.input(getByLabelText("Name"), { target: { value: "x" } });
    fireEvent.input(getByLabelText("Workdir"), { target: { value: "/repo" } });
    fireEvent.input(getByLabelText("Prompt"), { target: { value: "p" } });
    fireEvent.click(getByRole("button", { name: "Create routine" }));
    expect(await findByText(/Missing scope: session:approve/)).toBeTruthy();
  });

  it("edits: nothing to save until something changes, then only the change", async () => {
    const onSubmit = vi.fn(async () => {});
    const { getByRole, getByLabelText } = render(() => <RoutineForm {...formProps({ routine: routine(), onSubmit })} />);
    expect((getByRole("button", { name: "No changes" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.input(getByLabelText("Check command"), { target: { value: "" } });
    fireEvent.click(getByRole("button", { name: "Save 1 change" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ kind: "update", patch: { check: null } }));
  });

  it("warns about a persistent autonomous routine", () => {
    const { getByLabelText, getByTestId, getByRole } = render(() => <RoutineForm {...formProps()} />);
    fireEvent.click(getByRole("radio", { name: /Autonomous/ }));
    fireEvent.change(getByLabelText("Session"), { target: { value: "persistent" } });
    expect(getByTestId("routine-warnings").textContent).toMatch(/Persistent and autonomous/);
  });

  it("starting a loop swaps in the acceptance checks, and the session-only settings step aside saying why", async () => {
    const onSubmit = vi.fn(async () => {});
    const { getByRole, getByLabelText, getByTestId, queryByLabelText, queryByRole } = render(() => <RoutineForm {...formProps({ onSubmit })} />);
    fireEvent.click(getByRole("radio", { name: "Starts a loop" }));
    expect(getByTestId("routine-loop-fields")).toBeTruthy();
    expect(getByTestId("routine-loop-approvals").textContent).toMatch(/can't be guarded/);
    expect(queryByRole("radio", { name: /Guarded/ })).toBeNull();
    expect(queryByLabelText("Tool calls")).toBeNull();
    expect((getByLabelText("Session") as HTMLSelectElement).disabled).toBe(true);
    expect(queryByRole("button", { name: "{{check}}" })).toBeNull();

    fireEvent.input(getByLabelText("Name"), { target: { value: "flaky-repair" } });
    fireEvent.input(getByLabelText("Workdir"), { target: { value: "/repo" } });
    fireEvent.input(getByLabelText("Objective"), { target: { value: "Fix it {{check}}" } });
    fireEvent.input(getByLabelText("Acceptance check 1 command"), { target: { value: "bun test" } });
    fireEvent.click(getByRole("button", { name: "Create routine" }));
    expect(getByTestId("routine-form-error").textContent).toMatch(/placeholders/);

    fireEvent.input(getByLabelText("Objective"), { target: { value: "Fix the flaky tests" } });
    fireEvent.input(getByLabelText("Attempts"), { target: { value: "2" } });
    fireEvent.click(getByRole("button", { name: "Create routine" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect((onSubmit.mock.calls as unknown[][])[0]![0]).toMatchObject({
      kind: "create",
      spec: { prompt: "Fix the flaky tests", approvals: "autonomous", loop: { checks: [{ command: "bun test" }], limits: { attempts: 2 } } },
    });
  });
});
