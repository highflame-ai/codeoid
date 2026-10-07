// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import { PipelineRunnerView } from "./PipelineRunner";
import type { PipelinePhaseWire, PipelineWire } from "../protocol/types";

afterEach(cleanup);

function phase(
  p: Partial<PipelinePhaseWire> & Pick<PipelinePhaseWire, "id">,
): PipelinePhaseWire {
  return { status: "pending", ...p };
}

function pipeline(over: Partial<PipelineWire> = {}): PipelineWire {
  return {
    id: "p1",
    name: "Add a widget",
    status: "running",
    cursor: 0,
    phases: [],
    sessionId: "sess-1",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

const noop = () => {};

/** The cockpit no longer starts runs (the create-session dialog does), so the
 *  view only takes the active pipeline + the steer callbacks. */
function baseProps() {
  return {
    pipeline: null as PipelineWire | null,
    onApprove: noop,
    onReject: noop,
    onRevise: noop,
  };
}

describe("PipelineRunnerView — empty", () => {
  it("shows a subtle note when there is no active run (starting is done from the dialog)", () => {
    const { getByText } = render(() => <PipelineRunnerView {...baseProps()} />);
    expect(getByText("No active run.")).toBeTruthy();
  });
});

describe("PipelineRunnerView — Run view", () => {
  const halted = () =>
    pipeline({
      status: "halted",
      cursor: 1,
      phases: [
        phase({ id: "spec", role: "planner", status: "passed" }),
        phase({
          id: "architect",
          name: "Design",
          role: "reviewer",
          status: "halted",
          requestId: "q1",
          reason: "Review the proposed design",
          questions: ["Is the schema right?"],
          feedback: ["earlier: use UUIDs"],
        }),
        phase({ id: "implement", status: "pending" }),
      ],
    });

  it("renders the phase rail from the pipeline", () => {
    const { getByText } = render(() => (
      <PipelineRunnerView {...baseProps()} pipeline={halted()} />
    ));
    expect(getByText("spec")).toBeTruthy();
    expect(getByText("architect")).toBeTruthy();
    expect(getByText("implement")).toBeTruthy();
  });

  it("shows Approve/Revise/Reject at a halt and calls slice fns with the requestId", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const onRevise = vi.fn();
    const { getByText, getByLabelText } = render(() => (
      <PipelineRunnerView
        {...baseProps()}
        pipeline={halted()}
        onApprove={onApprove}
        onReject={onReject}
        onRevise={onRevise}
      />
    ));

    // Halt context is rendered.
    expect(getByText("Review the proposed design")).toBeTruthy();
    expect(getByText("Is the schema right?")).toBeTruthy();
    expect(getByText("earlier: use UUIDs")).toBeTruthy();

    // Approve → onApprove(requestId, undefined) (no note entered).
    fireEvent.click(getByText("Approve"));
    expect(onApprove).toHaveBeenCalledWith("q1", undefined);

    // Revise requires feedback; fill it then click.
    fireEvent.input(getByLabelText("Revise feedback"), {
      target: { value: "please tighten it" },
    });
    fireEvent.click(getByText("Revise"));
    expect(onRevise).toHaveBeenCalledWith("q1", "please tighten it");

    // Reject → onReject(requestId, undefined).
    fireEvent.click(getByText("Reject"));
    expect(onReject).toHaveBeenCalledWith("q1", undefined);
  });

  it("a phase halted on its own question offers Answer, not Approve (#348)", () => {
    const onRevise = vi.fn();
    const asking = pipeline({
      status: "halted",
      cursor: 0,
      phases: [
        phase({
          id: "impl",
          status: "halted",
          requestId: "input:impl",
          reason: 'phase "impl" needs input — reply with Revise to re-run it with your answer',
          questions: ["Which language should I use?"],
        }),
      ],
    });
    const { getByText, queryByText, getByLabelText } = render(() => (
      <PipelineRunnerView {...baseProps()} pipeline={asking} onRevise={onRevise} />
    ));
    expect(getByText("Which language should I use?")).toBeTruthy();
    expect(queryByText("Approve")).toBeNull();
    expect(getByText("Reject")).toBeTruthy();
    fireEvent.input(getByLabelText("Your answer"), { target: { value: "TypeScript" } });
    fireEvent.click(getByText("Answer"));
    expect(onRevise).toHaveBeenCalledWith("input:impl", "TypeScript");
  });

  it("renders a terminal status", () => {
    const { container } = render(() => (
      <PipelineRunnerView {...baseProps()} pipeline={pipeline({ status: "done" })} />
    ));
    expect(container.textContent).toContain("done");
    expect(container.textContent).toContain("Run done.");
  });
});
