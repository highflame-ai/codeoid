// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";

const requestMock = vi.hoisted(() => vi.fn());
const authMock = vi.hoisted(() => vi.fn());
vi.mock("../state/connection", () => ({
  send: vi.fn(),
  request: requestMock,
  newRequestId: () => "r",
  refreshSessions: vi.fn(() => Promise.resolve([])),
  authIdentity: authMock,
  getClient: () => {
    throw new Error("not bootstrapped");
  },
}));

// Pack state is daemon-canonical; the modal only reads `packsState().installed`
// and fires `fetchPacks()` on open. Mock both so the installed list is
// controllable per-test without a live daemon.
const packsHolder = vi.hoisted(() => ({ installed: [] as unknown[] }));
const fetchPacksMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("../state/packs", () => ({
  fetchPacks: fetchPacksMock,
  packsState: () => ({
    installed: packsHolder.installed,
    available: [],
    registries: [],
    loading: false,
    busy: false,
    loaded: true,
    error: null,
  }),
}));

// Pipeline mode delegates the start to state/pipelines.runPipeline (create →
// focus session → advance). Mock it so we can assert the payload without a live
// daemon (getClient throws in this suite).
const runPipelineMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("../state/pipelines", () => ({ runPipeline: runPipelineMock }));

import type { PackWire } from "../protocol/types";
import NewSessionModal, {
  openCollaborateModal,
  openNewSessionModal,
  openPipelineModal,
} from "./NewSessionModal";
import { _resetSessionsForTest } from "../state/sessions";

/** Minimal installed PackWire for the modal's pack/role selectors. */
function pack(p: Partial<PackWire> & Pick<PackWire, "id" | "name">): PackWire {
  return {
    version: "1.0.0",
    dir: `/cache/${p.id}`,
    trusted: false,
    selected: false,
    phases: [],
    roles: [],
    gates: [],
    active: true,
    ...p,
  };
}

function authOk(providers?: string[]) {
  return {
    type: "auth.ok",
    identity: { sub: "u", type: "human" },
    scopes: [],
    ...(providers ? { providers } : {}),
  };
}

afterEach(() => {
  cleanup();
  _resetSessionsForTest();
  requestMock.mockReset();
  authMock.mockReset();
  fetchPacksMock.mockClear();
  runPipelineMock.mockClear();
  packsHolder.installed = [];
});

describe("NewSessionModal provider picker", () => {
  it("hides the picker when the daemon advertises no providers (legacy)", () => {
    authMock.mockReturnValue(authOk());
    const { queryByText } = render(() => <NewSessionModal />);
    openNewSessionModal();
    expect(queryByText("Backend")).toBeNull();
  });

  it("defaults to the first provider and omits providerId from the create", async () => {
    authMock.mockReturnValue(authOk(["claude", "pi"]));
    requestMock.mockResolvedValue({ id: "s-new", name: "n", workdir: "/w" });
    const { getByText, getByPlaceholderText } = render(() => <NewSessionModal />);
    openNewSessionModal();

    expect(getByText("claude (default)")).toBeTruthy();
    fireEvent.input(getByPlaceholderText("e.g. shield-refactor"), {
      target: { value: "demo" },
    });
    fireEvent.click(getByText("create"));
    await waitFor(() => expect(requestMock).toHaveBeenCalled());
    const sent = requestMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.type).toBe("session.create");
    expect("providerId" in sent).toBe(false);
  });

  it("sends the chosen non-default provider", async () => {
    authMock.mockReturnValue(authOk(["claude", "pi"]));
    requestMock.mockResolvedValue({ id: "s-new", name: "n", workdir: "/w" });
    const { getByText, getByPlaceholderText } = render(() => <NewSessionModal />);
    openNewSessionModal();

    fireEvent.click(getByText("pi"));
    fireEvent.input(getByPlaceholderText("e.g. shield-refactor"), {
      target: { value: "pi-session" },
    });
    fireEvent.click(getByText("create"));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "session.create", providerId: "pi" }),
      ),
    );
  });
});

describe("NewSessionModal pack + role picker", () => {
  it("fetches packs on open and degrades to a subtle note when none are installed", () => {
    authMock.mockReturnValue(authOk());
    packsHolder.installed = [];
    const { queryByLabelText, getByText } = render(() => <NewSessionModal />);
    openNewSessionModal();

    // Fetch is kicked off on open (graceful even if it rejects).
    expect(fetchPacksMock).toHaveBeenCalled();
    // No pack <select> — just the subtle freestyle note.
    expect(queryByLabelText("Pack")).toBeNull();
    expect(getByText(/No packs installed/)).toBeTruthy();
  });

  it("renders installed packs as options and reveals roles once a pack is chosen", () => {
    authMock.mockReturnValue(authOk());
    packsHolder.installed = [
      pack({ id: "aif-sdlc", name: "AI Factory SDLC", roles: ["reviewer", "builder"] }),
    ];
    const { getByLabelText, queryByLabelText, getByText, queryByText } = render(
      () => <NewSessionModal />,
    );
    openNewSessionModal();

    // Pack <select> present with None + the installed pack.
    const packSel = getByLabelText("Pack") as HTMLSelectElement;
    expect(packSel).toBeTruthy();
    expect(getByText("None (freestyle)")).toBeTruthy();
    expect(getByText("AI Factory SDLC")).toBeTruthy();

    // Role select hidden until a pack is chosen.
    expect(queryByLabelText("Pack role")).toBeNull();
    expect(queryByText("Default (no role restriction)")).toBeNull();

    // Choose the pack → its roles surface.
    fireEvent.change(packSel, { target: { value: "aif-sdlc" } });
    expect(getByLabelText("Pack role")).toBeTruthy();
    expect(getByText("Default (no role restriction)")).toBeTruthy();
    expect(getByText("reviewer")).toBeTruthy();
    expect(getByText("builder")).toBeTruthy();
  });

  it("resets the chosen role when the pack changes", () => {
    authMock.mockReturnValue(authOk());
    packsHolder.installed = [
      pack({ id: "aif-sdlc", name: "AI Factory SDLC", roles: ["reviewer", "builder"] }),
    ];
    const { getByLabelText, queryByLabelText } = render(() => <NewSessionModal />);
    openNewSessionModal();

    const packSel = getByLabelText("Pack") as HTMLSelectElement;
    fireEvent.change(packSel, { target: { value: "aif-sdlc" } });
    const roleSel = getByLabelText("Pack role") as HTMLSelectElement;
    fireEvent.change(roleSel, { target: { value: "reviewer" } });
    expect((getByLabelText("Pack role") as HTMLSelectElement).value).toBe("reviewer");

    // Back to None hides the role select…
    fireEvent.change(packSel, { target: { value: "" } });
    expect(queryByLabelText("Pack role")).toBeNull();

    // …and re-choosing the pack starts from the default (role was reset).
    fireEvent.change(packSel, { target: { value: "aif-sdlc" } });
    expect((getByLabelText("Pack role") as HTMLSelectElement).value).toBe("");
  });

  it("includes pack + packRole in the create payload only when set", async () => {
    authMock.mockReturnValue(authOk());
    requestMock.mockResolvedValue({ id: "s-new", name: "n", workdir: "/w" });
    packsHolder.installed = [
      pack({ id: "aif-sdlc", name: "AI Factory SDLC", roles: ["reviewer"] }),
    ];
    const { getByLabelText, getByText, getByPlaceholderText } = render(() => (
      <NewSessionModal />
    ));
    openNewSessionModal();

    fireEvent.input(getByPlaceholderText("e.g. shield-refactor"), {
      target: { value: "review-run" },
    });
    fireEvent.change(getByLabelText("Pack") as HTMLSelectElement, {
      target: { value: "aif-sdlc" },
    });
    fireEvent.change(getByLabelText("Pack role") as HTMLSelectElement, {
      target: { value: "reviewer" },
    });
    fireEvent.click(getByText("create"));

    await waitFor(() => expect(requestMock).toHaveBeenCalled());
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session.create",
        pack: "aif-sdlc",
        packRole: "reviewer",
      }),
    );
  });

  it("omits pack + packRole from the payload when left freestyle", async () => {
    authMock.mockReturnValue(authOk());
    requestMock.mockResolvedValue({ id: "s-new", name: "n", workdir: "/w" });
    packsHolder.installed = [pack({ id: "aif-sdlc", name: "AI Factory SDLC" })];
    const { getByText, getByPlaceholderText } = render(() => <NewSessionModal />);
    openNewSessionModal();

    fireEvent.input(getByPlaceholderText("e.g. shield-refactor"), {
      target: { value: "plain" },
    });
    fireEvent.click(getByText("create"));

    await waitFor(() => expect(requestMock).toHaveBeenCalled());
    const sent = requestMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.type).toBe("session.create");
    expect("pack" in sent).toBe(false);
    expect("packRole" in sent).toBe(false);
  });
});

describe("NewSessionModal pipeline mode", () => {
  it("shows a goal box, hides the role picker, and starts a run with {pack, goal, workdir}", async () => {
    authMock.mockReturnValue(authOk());
    packsHolder.installed = [
      pack({ id: "aif-sdlc", name: "AI Factory SDLC", selected: true, roles: ["reviewer"] }),
    ];
    const { getByText, getByLabelText, queryByLabelText, getByPlaceholderText } = render(() => (
      <NewSessionModal />
    ));
    openPipelineModal("build a --json flag");

    // Pipeline framing: header + a goal box prefilled from the trigger.
    expect(getByText("Start a pipeline run")).toBeTruthy();
    expect((getByLabelText("Goal") as HTMLTextAreaElement).value).toBe("build a --json flag");
    // No per-session role picker in pipeline mode (roles are per-phase).
    expect(queryByLabelText("Pack role")).toBeNull();

    fireEvent.input(getByPlaceholderText("."), { target: { value: "/repo" } });
    fireEvent.click(getByText("start run"));

    await waitFor(() => expect(runPipelineMock).toHaveBeenCalled());
    expect(runPipelineMock).toHaveBeenCalledWith(
      expect.objectContaining({ pack: "aif-sdlc", goal: "build a --json flag", workdir: "/repo" }),
    );
    // It starts a run, not a plain session.
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("keeps Start disabled until there is a goal", () => {
    authMock.mockReturnValue(authOk());
    packsHolder.installed = [pack({ id: "aif-sdlc", name: "AI Factory SDLC", selected: true })];
    const { getByText } = render(() => <NewSessionModal />);
    openPipelineModal();
    expect((getByText("start run") as HTMLButtonElement).disabled).toBe(true);
  });
});


describe("NewSessionModal collaborative mode", () => {
  /** Open in collaborative mode with a name filled in. */
  function openCollab(providers = ["claude", "gemini"]) {
    authMock.mockReturnValue(authOk(providers));
    requestMock.mockResolvedValue({ id: "s-collab", name: "demo", workdir: "/w" });
    const r = render(() => <NewSessionModal />);
    openCollaborateModal();
    fireEvent.input(r.getByPlaceholderText("e.g. shield-refactor"), {
      target: { value: "demo" },
    });
    return r;
  }

  const goalBox = (r: ReturnType<typeof render>) =>
    r.getByPlaceholderText(
      "The one goal every role works on — e.g. Add rate limiting to the public API",
    );

  it("sends a collaboration with the default orchestrator + worker profile", async () => {
    const r = openCollab();
    fireEvent.input(goalBox(r), { target: { value: "Ship rate limiting" } });
    fireEvent.click(r.getByText("create collaboration"));

    await waitFor(() => expect(requestMock).toHaveBeenCalled());
    const sent = requestMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.type).toBe("session.create");
    const collab = sent.collaboration as { goal: string; roles: Array<Record<string, unknown>> };
    expect(collab.goal).toBe("Ship rate limiting");
    expect(collab.roles.map((x) => x.name)).toEqual(["orchestrator", "search"]);
    // The orchestrator is claude-pinned in v1 (#245).
    expect(collab.roles[0]!.providerId).toBe("claude");
  });

  // A collaborative session IS its orchestrator, so the daemon derives the
  // backend from that role and REJECTS a conflicting explicit providerId.
  // Sending one would turn every create into an error.
  it("never sends a top-level providerId", async () => {
    const r = openCollab();
    fireEvent.input(goalBox(r), { target: { value: "g" } });
    fireEvent.click(r.getByText("create collaboration"));
    await waitFor(() => expect(requestMock).toHaveBeenCalled());
    const sent = requestMock.mock.calls[0]![0] as Record<string, unknown>;
    expect("providerId" in sent).toBe(false);
  });

  it("omits optional fields rather than sending empty values", async () => {
    const r = openCollab();
    fireEvent.input(goalBox(r), { target: { value: "g" } });
    fireEvent.click(r.getByText("create collaboration"));
    await waitFor(() => expect(requestMock).toHaveBeenCalled());
    const sent = requestMock.mock.calls[0]![0] as Record<string, unknown>;
    const roles = (sent.collaboration as { roles: Array<Record<string, unknown>> }).roles;
    // count:1 and write:false are the daemon's defaults — sending them adds
    // noise, and an empty-string model would fail provider-aware validation.
    for (const role of roles) {
      expect("model" in role).toBe(false);
      expect("count" in role).toBe(false);
      expect("write" in role).toBe(false);
    }
  });

  it("blocks submit until a goal is given, and says why", async () => {
    const r = openCollab();
    expect(r.getByText("a goal is required")).toBeTruthy();
    expect((r.getByText("create collaboration") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.input(goalBox(r), { target: { value: "g" } });
    await waitFor(() =>
      expect((r.getByText("create collaboration") as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it("rejects duplicate role names before hitting the daemon", async () => {
    const r = openCollab();
    fireEvent.input(goalBox(r), { target: { value: "g" } });
    fireEvent.click(r.getByText("+ add role"));
    const nameInputs = r.getAllByLabelText("Role name") as HTMLInputElement[];
    // Row 0 is the orchestrator (locked); rename the two workers to collide.
    fireEvent.input(nameInputs[1]!, { target: { value: "review" } });
    fireEvent.input(nameInputs[2]!, { target: { value: "Review" } });
    await waitFor(() => expect(r.getByText('duplicate role "Review"')).toBeTruthy());
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("keeps the orchestrator row non-removable and claude-pinned", () => {
    const r = openCollab();
    const removes = r.getAllByLabelText("Remove role") as HTMLButtonElement[];
    expect(removes[0]!.disabled).toBe(true);
    const backends = r.getAllByLabelText("Backend") as HTMLSelectElement[];
    expect(backends[0]!.disabled).toBe(true);
    expect(backends[0]!.value).toBe("claude");
  });

  it("carries model, count and write when set", async () => {
    const r = openCollab();
    fireEvent.input(goalBox(r), { target: { value: "g" } });
    const models = r.getAllByLabelText("Model") as HTMLInputElement[];
    fireEvent.input(models[1]!, { target: { value: "gemini-2.5-pro" } });
    const counts = r.getAllByLabelText("Count") as HTMLInputElement[];
    fireEvent.input(counts[0]!, { target: { value: "3" } });
    const writes = r.container.querySelectorAll('input[type="checkbox"]');
    fireEvent.click(writes[0]!);

    fireEvent.click(r.getByText("create collaboration"));
    await waitFor(() => expect(requestMock).toHaveBeenCalled());
    const sent = requestMock.mock.calls[0]![0] as Record<string, unknown>;
    const worker = (sent.collaboration as { roles: Array<Record<string, unknown>> }).roles[1]!;
    expect(worker.model).toBe("gemini-2.5-pro");
    expect(worker.count).toBe(3);
    expect(worker.write).toBe(true);
  });

  it("a plain session still sends no collaboration", async () => {
    authMock.mockReturnValue(authOk(["claude"]));
    requestMock.mockResolvedValue({ id: "s", name: "n", workdir: "/w" });
    const r = render(() => <NewSessionModal />);
    openNewSessionModal();
    fireEvent.input(r.getByPlaceholderText("e.g. shield-refactor"), {
      target: { value: "plain" },
    });
    fireEvent.click(r.getByText("create"));
    await waitFor(() => expect(requestMock).toHaveBeenCalled());
    expect("collaboration" in (requestMock.mock.calls[0]![0] as object)).toBe(false);
  });
});

// ── Pipeline as a first-class third mode ─────────────────────────────────────

// The reported symptom: a user opened `+ new session`, picked a pack, and saw
// no phase tracing. The pack WAS honored — as ambient activation — but pipeline
// mode was reachable only from /pipeline and the Pack Browser, so the dialog
// offered a pack picker whose meaning depended on a mode you couldn't select.
// Design §9: "the run IS a session plus a goal and a config, so it extends the
// existing create-session dialog rather than a bespoke panel."
describe("NewSessionModal — three modes", () => {
  it("offers Pipeline in the kind toggle alongside the other two", async () => {
    packsHolder.installed = [pack({ id: "sdlc", name: "SDLC" })];
    openNewSessionModal();
    const { getByRole } = render(() => <NewSessionModal />);
    // All three are radios in one group — the discovery fix.
    expect(getByRole("radio", { name: "Single agent" })).toBeTruthy();
    expect(getByRole("radio", { name: "Collaborative" })).toBeTruthy();
    expect(getByRole("radio", { name: "Pipeline" })).toBeTruthy();
  });

  it("keeps the toggle visible IN pipeline mode, so you can leave it", async () => {
    // Arriving from Pack Browser → Run used to hide the toggle entirely, which
    // left you in a mode you could neither see nor exit.
    packsHolder.installed = [pack({ id: "sdlc", name: "SDLC" })];
    openPipelineModal();
    const { getByRole } = render(() => <NewSessionModal />);
    expect(getByRole("radio", { name: "Pipeline" }).getAttribute("aria-checked")).toBe("true");
    expect(getByRole("radio", { name: "Single agent" })).toBeTruthy();
  });

  it("states what a pack MEANS in each mode — ambient vs phases", async () => {
    packsHolder.installed = [pack({ id: "sdlc", name: "SDLC" })];
    openNewSessionModal();
    const { getByRole, getByText } = render(() => <NewSessionModal />);
    // Session mode: the same picker means ambient activation, and says so.
    expect(getByText(/pack here is AMBIENT/)).toBeTruthy();
    fireEvent.click(getByRole("radio", { name: "Pipeline" }));
    expect(getByText(/auto-advances through the pack's PHASES/)).toBeTruthy();
  });

  it("preserves the chosen pack across a mode switch", async () => {
    // Not data loss: pipeline → session with the pack kept IS the other
    // legitimate use of that pack ("constitution, not phases").
    packsHolder.installed = [pack({ id: "sdlc", name: "SDLC" })];
    openNewSessionModal();
    const { getByRole, getByLabelText } = render(() => <NewSessionModal />);
    const picker = getByLabelText("Pack") as HTMLSelectElement;
    fireEvent.change(picker, { target: { value: "sdlc" } });
    expect(picker.value).toBe("sdlc");

    fireEvent.click(getByRole("radio", { name: "Pipeline" }));
    expect((getByLabelText("Pack") as HTMLSelectElement).value).toBe("sdlc");
    fireEvent.click(getByRole("radio", { name: "Single agent" }));
    expect((getByLabelText("Pack") as HTMLSelectElement).value).toBe("sdlc");
  });

  it("drops packRole when leaving session mode — a pipeline sets roles per-phase", async () => {
    packsHolder.installed = [pack({ id: "sdlc", name: "SDLC", roles: ["architect"] })];
    openNewSessionModal();
    const { getByRole, getByLabelText, queryByLabelText } = render(() => <NewSessionModal />);
    fireEvent.change(getByLabelText("Pack"), { target: { value: "sdlc" } });
    fireEvent.change(getByLabelText("Pack role"), { target: { value: "architect" } });
    expect((getByLabelText("Pack role") as HTMLSelectElement).value).toBe("architect");

    fireEvent.click(getByRole("radio", { name: "Pipeline" }));
    // The role picker is session-only, and the value is cleared rather than
    // silently ignored by the daemon.
    expect(queryByLabelText("Pack role")).toBeNull();
    fireEvent.click(getByRole("radio", { name: "Single agent" }));
    expect((getByLabelText("Pack role") as HTMLSelectElement).value).toBe("");
  });

  it("names an inactive pack instead of silently dropping it from the list", async () => {
    // Pipeline mode filters to active packs. Carrying an inactive selection in
    // used to make it vanish with Start disabled and nothing explaining why.
    packsHolder.installed = [
      pack({ id: "live", name: "Live" }),
      pack({ id: "off", name: "Dormant", active: false }),
    ];
    openNewSessionModal();
    const { getByRole, getByLabelText, getByText } = render(() => <NewSessionModal />);
    fireEvent.change(getByLabelText("Pack"), { target: { value: "off" } });
    fireEvent.click(getByRole("radio", { name: "Pipeline" }));
    expect(getByText(/Dormant is installed but not active/)).toBeTruthy();
  });

  it("still starts a real pipeline run from the toggle path", async () => {
    // The toggle must reach the SAME run machinery /pipeline uses, not a
    // look-alike that quietly creates a plain session.
    packsHolder.installed = [pack({ id: "sdlc", name: "SDLC" })];
    openNewSessionModal();
    const { getByRole, getByLabelText } = render(() => <NewSessionModal />);
    fireEvent.click(getByRole("radio", { name: "Pipeline" }));
    fireEvent.input(getByLabelText(/Goal/i), { target: { value: "ship the thing" } });
    fireEvent.change(getByLabelText("Pack"), { target: { value: "sdlc" } });
    fireEvent.click(getByRole("button", { name: /start|create/i }));
    await waitFor(() => expect(runPipelineMock).toHaveBeenCalledTimes(1));
    expect(runPipelineMock).toHaveBeenCalledWith(
      expect.objectContaining({ pack: "sdlc", goal: "ship the thing" }),
    );
  });
});
