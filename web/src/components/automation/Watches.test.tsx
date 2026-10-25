// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";

import { TrustEditor } from "./TrustEditor";
import { VouchDialog } from "./VouchDialog";
import { WatchDetail, type WatchDetailProps } from "./WatchDetail";
import { WatchForm } from "./WatchForm";
import { WatchList } from "./WatchesTab";
import { loopRun, trigger, watch } from "../../lib/automation.fixtures";

afterEach(cleanup);

const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const HEAD = "0123456789abcdef0123";

function detailProps(over: Partial<WatchDetailProps> = {}): WatchDetailProps {
  return {
    watch: watch(),
    triggers: [],
    lastPoll: null,
    runs: [],
    now: NOW,
    onBack: vi.fn(),
    onSetEnabled: vi.fn(),
    onPoll: vi.fn(),
    onDelete: vi.fn(async () => true),
    onSaveTrust: vi.fn(async () => {}),
    onVouch: vi.fn(async () => {}),
    onOpenLoopRun: vi.fn(),
    ...over,
  };
}

describe("WatchList", () => {
  it("explains watches when there are none", () => {
    const { getByTestId } = render(() => <WatchList watches={[]} loaded runs={[]} now={NOW} onSelect={vi.fn()} onNew={vi.fn()} />);
    expect(getByTestId("watches-empty").textContent).toMatch(/only ever runs code from heads you, or people you trust, pushed or merged/);
    expect(getByTestId("automation-explainer")).toBeTruthy();
  });

  it("shows repo, what it watches, health, last poll, the error and the runs it started", () => {
    const runs = [loopRun({ trigger: { kind: "ci_failure", key: "k", watchId: "w_1", summary: "" } })];
    const { getAllByTestId } = render(() => (
      <WatchList
        watches={[
          watch(),
          watch({ id: "w_2", myPrs: true, branches: [], lastError: "listing check runs: API rate limit exceeded for user" }),
          watch({ id: "w_3", enabled: false }),
        ]}
        loaded
        runs={runs}
        now={NOW}
        onSelect={vi.fn()}
        onNew={vi.fn()}
      />
    ));
    const rows = getAllByTestId("watch-row");
    expect(rows[0]!.textContent).toContain("acme/shop");
    expect(rows[0]!.textContent).toContain("main");
    expect(rows[0]!.textContent).toContain("watching");
    expect(rows[0]!.textContent).toContain("1 run");
    expect(rows[0]!.textContent).toContain("polled 5m ago");
    expect(rows[1]!.textContent).toContain("your open pull requests");
    expect(rows[1]!.textContent).toContain("backing off");
    expect(rows[1]!.textContent).toContain("rate limit exceeded");
    expect(rows[2]!.textContent).toContain("paused");
  });
});

describe("WatchDetail", () => {
  it("renders the CI mappings, review settings and the trust list", () => {
    const { getByTestId } = render(() => (
      <WatchDetail {...detailProps({ watch: watch({ ci: [{ ciName: "lint", app: "circleci-checks", command: "bun run lint", timeoutSec: 300 }], review: { enabled: true, allow: [], mention: "@codeoid" } }) })} />
    ));
    expect(getByTestId("watch-ci").textContent).toContain("lint@circleci-checks → bun run lint");
    expect(getByTestId("watch-review").textContent).toContain("@codeoid by you (@me)");
    expect(getByTestId("watch-trust").textContent).toContain("alice");
  });

  it("lists what it acted on, with why a head was refused, and links runs", () => {
    const onOpenLoopRun = vi.fn();
    const { getAllByTestId, getByRole } = render(() => (
      <WatchDetail
        {...detailProps({
          onOpenLoopRun,
          triggers: [
            trigger(),
            trigger({
              key: `untrusted:w_1:${HEAD}::main`,
              kind: "head",
              runId: null,
              outcome: "ignored",
              note: "not pushed by someone you trust: pushed by @mallory",
            }),
          ],
        })}
      />
    ));
    const rows = getAllByTestId("watch-trigger");
    expect(rows[0]!.textContent).toContain("started a run");
    expect(rows[0]!.textContent).toContain("failing check");
    expect(rows[1]!.textContent).toContain("untrusted head");
    expect(rows[1]!.textContent).toContain("why: not pushed by someone you trust: pushed by @mallory");
    fireEvent.click(getByRole("button", { name: "open run" }));
    expect(onOpenLoopRun).toHaveBeenCalledWith("loop_1");
  });

  it("links the repository only on github.com, and shows a back-off's meaning", () => {
    const { getByRole, getByTestId } = render(() => <WatchDetail {...detailProps({ watch: watch({ lastError: "GitHub API rate limit exceeded" }) })} />);
    expect(getByRole("link", { name: "acme/shop" }).getAttribute("href")).toBe("https://github.com/acme/shop");
    expect(getByTestId("watch-last-error").textContent).toMatch(/Rate-limited: backing off.*doubling up to six hours/s);
  });

  it("polls, pauses and resumes", () => {
    const onPoll = vi.fn();
    const onSetEnabled = vi.fn();
    const { getByRole, unmount } = render(() => <WatchDetail {...detailProps({ onPoll, onSetEnabled })} />);
    fireEvent.click(getByRole("button", { name: "Poll now" }));
    fireEvent.click(getByRole("button", { name: "Pause" }));
    expect(onPoll).toHaveBeenCalled();
    expect(onSetEnabled).toHaveBeenCalledWith(false);
    unmount();
    const paused = render(() => <WatchDetail {...detailProps({ watch: watch({ enabled: false }), onSetEnabled })} />);
    expect((paused.getByRole("button", { name: "Poll now" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(paused.getByRole("button", { name: "Resume" }));
    expect(onSetEnabled).toHaveBeenCalledWith(true);
  });

  it("shows what a poll started and skipped", () => {
    const { getByTestId } = render(() => <WatchDetail {...detailProps({ lastPoll: { started: ["loop_9"], skipped: ["main: not vouched for yet"] } })} />);
    expect(getByTestId("watch-poll-result").textContent).toContain("Started 1 run.");
    expect(getByTestId("watch-poll-result").textContent).toContain("main: not vouched for yet");
  });

  it("offers no vouch on a my-PRs watch", () => {
    const { queryByRole } = render(() => <WatchDetail {...detailProps({ watch: watch({ myPrs: true, branches: [] }) })} />);
    expect(queryByRole("button", { name: "Vouch for current head…" })).toBeNull();
  });

  it("deletes through a confirm dialog", async () => {
    const onDelete = vi.fn(async () => true);
    const { getByRole, queryByRole } = render(() => <WatchDetail {...detailProps({ onDelete })} />);
    fireEvent.click(getByRole("button", { name: "Delete" }));
    expect(getByRole("alertdialog", { name: "Delete this watch?" }).textContent).toMatch(/Runs it already started carry on/);
    fireEvent.click(getByRole("button", { name: "Delete watch" }));
    await waitFor(() => expect(queryByRole("alertdialog")).toBeNull());
    expect(onDelete).toHaveBeenCalled();
  });

  it("opens the vouch dialog pinned to the head the history names", () => {
    const { getByRole, getByLabelText } = render(() => (
      <WatchDetail {...detailProps({ triggers: [trigger({ key: `untrusted:w_1:${HEAD}::main`, kind: "head", outcome: "ignored", runId: null })] })} />
    ));
    fireEvent.click(getByRole("button", { name: "Vouch for current head…" }));
    expect((getByLabelText("main head commit") as HTMLInputElement).value).toBe(HEAD);
  });
});

describe("VouchDialog", () => {
  const known = { main: { sha: HEAD, source: "untrusted head" as const, at: "2026-10-26T11:00:00.000Z" } };

  it("explains that it vouches for everything beneath the head", () => {
    const { getByRole } = render(() => <VouchDialog open watch={watch()} known={known} now={NOW} onVouch={vi.fn(async () => {})} onClose={vi.fn()} />);
    const dialog = getByRole("alertdialog", { name: "Vouch for the current head" });
    expect(dialog.textContent).toMatch(/It and every commit beneath it become trusted/);
    expect(dialog.textContent).toMatch(/including commits you didn't review/);
    expect(getByRole("link", { name: "view" }).getAttribute("href")).toBe(`https://github.com/acme/shop/commit/${HEAD}`);
  });

  it("pins to the commit (compare-and-set), and on a moved head vouches for nothing until asked again", async () => {
    const onVouch = vi
      .fn()
      .mockRejectedValueOnce(new Error(`main's head is fedcba987654 now, not ${HEAD.slice(0, 12)}: it moved, so nothing was vouched for; look at it again`))
      .mockResolvedValueOnce(undefined);
    const onClose = vi.fn();
    const { getByRole, getByTestId, getByLabelText } = render(() => <VouchDialog open watch={watch()} known={known} now={NOW} onVouch={onVouch} onClose={onClose} />);

    fireEvent.click(getByRole("button", { name: "Vouch for it" }));
    await waitFor(() => expect(getByTestId("vouch-moved").textContent).toContain("fedcba987654"));
    expect(onVouch).toHaveBeenNthCalledWith(1, { main: HEAD });
    expect(onClose).not.toHaveBeenCalled();
    expect((getByLabelText("main head commit") as HTMLInputElement).value).toBe("fedcba987654");
    expect(getByRole("alertdialog", { name: "main moved: nothing was vouched for" })).toBeTruthy();

    fireEvent.click(getByRole("button", { name: "Vouch for the new head" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onVouch).toHaveBeenNthCalledWith(2, { main: "fedcba987654" });
  });

  it("can't confirm a pin without a commit; unpinned vouches for every head as read", async () => {
    const onVouch = vi.fn(async () => {});
    const { getByRole, getByLabelText } = render(() => (
      <VouchDialog open watch={watch({ branches: ["main", "release"] })} known={{}} now={NOW} onVouch={onVouch} onClose={vi.fn()} />
    ));
    expect((getByRole("button", { name: "Vouch for 2 branches" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(getByLabelText(/Only while each head is still the commit above/));
    fireEvent.click(getByRole("button", { name: "Vouch for 2 branches" }));
    await waitFor(() => expect(onVouch).toHaveBeenCalledWith(true));
  });

  it("shows any other refusal as the daemon said it", async () => {
    const onVouch = vi.fn().mockRejectedValue(new Error("A delegated token cannot create, change, enable, or poll a loop watch"));
    const { getByRole } = render(() => <VouchDialog open watch={watch()} known={known} now={NOW} onVouch={onVouch} onClose={vi.fn()} />);
    fireEvent.click(getByRole("button", { name: "Vouch for it" }));
    await waitFor(() => expect(getByRole("alert").textContent).toContain("A delegated token cannot"));
  });
});

describe("TrustEditor", () => {
  it("widening saves straight away and says what it keeps", async () => {
    const onSave = vi.fn(async () => {});
    const { getByLabelText, getByRole, getByTestId, queryByRole } = render(() => (
      <TrustEditor trust={["alice"]} ghLogin="me" canVouch onSave={onSave} onCancel={vi.fn()} />
    ));
    fireEvent.input(getByLabelText("Add a trusted login"), { target: { value: "dependabot[bot]" } });
    fireEvent.keyDown(getByLabelText("Add a trusted login"), { key: "Enter" });
    expect(getByTestId("trust-diff").textContent).toMatch(/are kept/);
    fireEvent.click(getByRole("button", { name: "Save trust list" }));
    expect(queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(["alice", "dependabot[bot]"], false));
  });

  it("refuses logins GitHub acts as for everyone, and yourself", () => {
    const { getByLabelText, getByRole } = render(() => <TrustEditor trust={[]} ghLogin="me" canVouch onSave={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.input(getByLabelText("Add a trusted login"), { target: { value: "github-actions[bot]" } });
    fireEvent.click(getByRole("button", { name: "Add" }));
    expect(getByRole("alert").textContent).toMatch(/trusting it would trust everyone/);
    fireEvent.input(getByLabelText("Add a trusted login"), { target: { value: "Me" } });
    fireEvent.click(getByRole("button", { name: "Add" }));
    expect(getByRole("alert").textContent).toMatch(/is you/);
  });

  it("narrowing explains it forgets vouched heads and takes a confirm, optionally vouching again", async () => {
    const onSave = vi.fn(async () => {});
    const { getByRole, getByTestId, getByLabelText } = render(() => (
      <TrustEditor trust={["alice", "bob"]} ghLogin="me" canVouch onSave={onSave} onCancel={vi.fn()} />
    ));
    fireEvent.click(getByRole("button", { name: "Stop trusting alice" }));
    expect(getByTestId("trust-diff").textContent).toMatch(/forgets every head it judged trusted and every head you vouched for/);
    fireEvent.click(getByRole("button", { name: "Save trust list" }));
    const dialog = getByRole("alertdialog", { name: "Narrow the trust list?" });
    expect(dialog.textContent).toContain("alice");
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(getByLabelText(/Also vouch for each watched branch's head/));
    fireEvent.click(getByRole("button", { name: "Narrow and vouch again" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(["bob"], true));
  });

  it("'trust no one but me' empties the list", async () => {
    const onSave = vi.fn(async () => {});
    const { getByRole } = render(() => <TrustEditor trust={["alice"]} ghLogin="me" canVouch={false} onSave={onSave} onCancel={vi.fn()} />);
    fireEvent.click(getByRole("button", { name: "Trust no one but me" }));
    fireEvent.click(getByRole("button", { name: "Save trust list" }));
    fireEvent.click(getByRole("button", { name: "Narrow it" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith([], false));
  });
});

describe("WatchForm", () => {
  const props = () => ({ recentWorkdirs: ["/src/shop"], providers: [], onSubmit: vi.fn(async () => {}), onCancel: vi.fn() });

  it("validates inline", () => {
    const p = props();
    const { getByRole, getByTestId, getByLabelText } = render(() => <WatchForm {...p} />);
    fireEvent.click(getByRole("button", { name: "Create watch" }));
    expect(getByTestId("watch-form-error").textContent).toMatch(/Choose the repository/);
    expect(getByLabelText("Repository").getAttribute("aria-invalid")).toBe("true");
    fireEvent.input(getByLabelText("Repository"), { target: { value: "/src/shop" } });
    fireEvent.click(getByRole("button", { name: "Create watch" }));
    expect(getByTestId("watch-form-error").textContent).toMatch(/Map at least one CI check/);
    expect(p.onSubmit).not.toHaveBeenCalled();
  });

  it("submits a branch watch with a mapping and a vouch", async () => {
    const p = props();
    const { getByRole, getByLabelText } = render(() => <WatchForm {...p} />);
    fireEvent.input(getByLabelText("Repository"), { target: { value: "/src/shop" } });
    fireEvent.click(getByLabelText(/Named branches/));
    fireEvent.input(getByLabelText("Branches"), { target: { value: "main" } });
    fireEvent.input(getByLabelText("Mapping 1 check name"), { target: { value: "test (*)" } });
    fireEvent.input(getByLabelText("Mapping 1 command"), { target: { value: "bun test" } });
    fireEvent.click(getByRole("button", { name: "+ Add mapping" }));
    fireEvent.input(getByLabelText("Mapping 2 check name"), { target: { value: "lint" } });
    fireEvent.input(getByLabelText("Mapping 2 app"), { target: { value: "circleci-checks" } });
    fireEvent.input(getByLabelText("Mapping 2 command"), { target: { value: "bun run lint" } });
    fireEvent.click(getByLabelText(/Vouch for each branch's head now/));
    fireEvent.click(getByRole("button", { name: "Create watch" }));
    await waitFor(() => expect(p.onSubmit).toHaveBeenCalled());
    expect((p.onSubmit.mock.calls as unknown[][])[0]![0]).toEqual({
      type: "loop.watch.create",
      spec: {
        workdir: "/src/shop",
        branches: ["main"],
        ci: [
          { ciName: "test (*)", command: "bun test" },
          { ciName: "lint", command: "bun run lint", app: "circleci-checks" },
        ],
      },
      trustHead: true,
    });
  });

  it("keeps the daemon's refusal", async () => {
    const p = { ...props(), onSubmit: vi.fn(async () => Promise.reject(new Error("the workdir's origin isn't on github.com"))) };
    const { getByRole, getByLabelText, findByText } = render(() => <WatchForm {...p} />);
    fireEvent.input(getByLabelText("Repository"), { target: { value: "/src/shop" } });
    fireEvent.input(getByLabelText("Mapping 1 check name"), { target: { value: "t" } });
    fireEvent.input(getByLabelText("Mapping 1 command"), { target: { value: "x" } });
    fireEvent.click(getByRole("button", { name: "Create watch" }));
    expect(await findByText("the workdir's origin isn't on github.com")).toBeTruthy();
  });
});
