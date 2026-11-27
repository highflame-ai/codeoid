// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";

const clientRequestMock = vi.hoisted(() => vi.fn<(msg: { type: string; id: string; path?: string }) => Promise<unknown>>());
vi.mock("../../state/connection", () => ({
  newRequestId: () => "r",
  getClient: () => ({ request: clientRequestMock }),
}));

import { createSignal } from "solid-js";

import DirectoryPicker, { _resetDirectoryPickerForTest } from "./DirectoryPicker";

const HOME = "/home/me";
const TREE: Record<string, string[]> = {
  "/": ["Workspace", "home", "usr"],
  "/home": ["me"],
  [HOME]: ["notes", "src"],
  [`${HOME}/src`]: ["alpha", "beta"],
  "/Workspace": ["codeoid", "zeroid"],
  "/Workspace/codeoid": [],
  "/Workspace/zeroid": [],
  "/usr": ["lib", "local"],
  "/usr/local": [],
};

function serve(msg: { path?: string }): Promise<unknown> {
  let p = msg.path ?? HOME;
  if (p === "~") p = HOME;
  else if (p.startsWith("~/")) p = `${HOME}/${p.slice(2)}`;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  const kids = TREE[p];
  if (!kids) return Promise.reject(new Error(`no such path: ${p}`));
  return Promise.resolve({
    type: "fs.browse_dir.result",
    requestId: "r",
    path: p,
    root: "/",
    home: HOME,
    parent: p === "/" ? null : p.slice(0, p.lastIndexOf("/")) || "/",
    entries: kids.map((name) => ({
      name,
      path: p === "/" ? `/${name}` : `${p}/${name}`,
      kind: "directory",
      ...(name === "codeoid" ? { isGitRepo: true } : {}),
    })),
  });
}

afterEach(() => {
  cleanup();
  clientRequestMock.mockReset();
  _resetDirectoryPickerForTest();
});

function setup(initialPath?: string) {
  clientRequestMock.mockImplementation(serve);
  const onPick = vi.fn();
  const onClose = vi.fn();
  const utils = render(() => (
    <DirectoryPicker open initialPath={initialPath} onPick={onPick} onClose={onClose} />
  ));
  const input = utils.getByLabelText("Filter folders, or type a path") as HTMLInputElement;
  return { ...utils, input, onPick, onClose };
}

describe("DirectoryPicker", () => {
  it("navigates outside home via the Computer place and picks a folder", async () => {
    const { findByText, getByText, getByTitle, onPick } = setup();
    await findByText("src");
    fireEvent.click(getByTitle("/"));
    fireEvent.click(await findByText("Workspace"));
    await findByText("codeoid");
    expect(getByText("git")).toBeTruthy();
    fireEvent.click(getByTitle("Use /Workspace/codeoid"));
    expect(onPick).toHaveBeenCalledWith("/Workspace/codeoid");
  });

  it("browses a typed path live, completes with Tab and selects with Ctrl+Enter", async () => {
    const { findByText, queryByText, getAllByRole, getByRole, input, onPick } = setup();
    await findByText("src");
    fireEvent.input(input, { target: { value: "/usr/lo" } });
    // /usr is browsed and narrowed to the "lo" prefix, highlighted in the row.
    await waitFor(() => expect(getAllByRole("option").map((o) => o.textContent)).toEqual([expect.stringContaining("local")]));
    expect(queryByText("lib")).toBeNull();
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input.value).toBe("/usr/local/");
    await waitFor(() => expect(getByRole("navigation", { name: "Path" }).textContent).toContain("local"));
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(onPick).toHaveBeenCalledWith("/usr/local"));
  });

  it("filters the folder on screen, opens with Enter and goes up with Backspace", async () => {
    const { findByText, queryByText, getByRole, input } = setup("/Workspace");
    await findByText("zeroid");
    fireEvent.input(input, { target: { value: "zer" } });
    expect(queryByText("codeoid")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(getByRole("navigation", { name: "Path" }).textContent).toContain("zeroid"));
    expect(input.value).toBe("");
    fireEvent.keyDown(input, { key: "Backspace" });
    await findByText("codeoid");
  });

  it("falls back to the nearest existing folder above a stale initial path", async () => {
    const { findByText, getByText } = setup("/Workspace/gone/deeper");
    await findByText("codeoid");
    expect(getByText(/isn't available/)).toBeTruthy();
  });

  it("keeps the listing when a typed path is wrong, and Esc clears before it closes", async () => {
    const { findByText, findByRole, getByText, queryByText, input, onClose } = setup();
    await findByText("src");
    fireEvent.input(input, { target: { value: "/nope/" } });
    expect((await findByRole("alert")).textContent).toContain("no such path");
    // Home's folders aren't offered for a path they don't belong to…
    expect(queryByText("src")).toBeNull();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
    // …and come back once the path is cleared.
    expect(getByText("src")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("selects the typed path on ⌘/Ctrl+Enter right after a paste, before its listing lands", async () => {
    const { findByText, input, onPick } = setup();
    await findByText("src");
    // No wait: the debounced browse of /Workspace/ hasn't run, so the listing is still home.
    fireEvent.input(input, { target: { value: "/Workspace/codeoid" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(onPick).toHaveBeenCalledWith("/Workspace/codeoid"));
  });

  it("opens the typed path on Enter, never a same-named folder of the stale listing", async () => {
    const { findByText, findByRole, getByRole, input } = setup();
    await findByText("src");
    // Home has "notes"; while /Workspace/ is pending the needle "no" must not open ~/notes.
    fireEvent.input(input, { target: { value: "/Workspace/no" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect((await findByRole("alert")).textContent).toContain("no such path");
    expect(clientRequestMock.mock.calls.map((c) => c[0].path)).not.toContain(`${HOME}/notes`);
    expect(getByRole("navigation", { name: "Path" }).textContent).not.toContain("notes");
  });

  it("selects the folder on screen from the footer even after the pointer crossed a row", async () => {
    const { findByText, getByText, getByTitle, onPick } = setup("/Workspace");
    await findByText("zeroid");
    fireEvent.mouseMove(getByText("zeroid"));
    fireEvent.click(getByTitle(/Use \/Workspace \(/));
    expect(onPick).toHaveBeenCalledWith("/Workspace");
  });

  it("does not climb folders while Backspace auto-repeats after clearing the filter", async () => {
    const { findByText, getByRole, input } = setup("/Workspace");
    await findByText("zeroid");
    fireEvent.keyDown(input, { key: "Backspace", repeat: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(getByRole("navigation", { name: "Path" }).textContent).toContain("Workspace");
    expect(clientRequestMock.mock.calls.map((c) => c[0].path)).not.toContain("/");
  });

  it("ignores a double-click's second click on a row", async () => {
    const { findByText, getByText } = setup("/Workspace");
    await findByText("zeroid");
    const calls = clientRequestMock.mock.calls.length;
    fireEvent.click(getByText("zeroid"), { detail: 2 });
    await new Promise((r) => setTimeout(r, 10));
    expect(clientRequestMock.mock.calls.length).toBe(calls);
    fireEvent.click(getByText("zeroid"), { detail: 1 });
    await waitFor(() => expect(clientRequestMock.mock.calls.length).toBe(calls + 1));
  });

  it("keeps a typed ~/ path's listing when hidden folders are toggled", async () => {
    const { findByText, getByLabelText, getByText, input } = setup();
    await findByText("notes");
    fireEvent.input(input, { target: { value: "~/src/" } });
    await findByText("alpha");
    fireEvent.click(getByLabelText(/Hidden folders/));
    await waitFor(() => expect(clientRequestMock.mock.calls.at(-1)?.[0]).toMatchObject({ showHidden: true }));
    await new Promise((r) => setTimeout(r, 30)); // the refreshed listing has landed
    expect(getByText("alpha")).toBeTruthy();
  });

  it("stops the initial-path walk once the user navigates elsewhere", async () => {
    let fail!: () => void;
    clientRequestMock.mockImplementation((msg) =>
      msg.path === "/gone/deep" ? new Promise((_res, rej) => (fail = () => rej(new Error("no such directory")))) : serve(msg),
    );
    const onPick = vi.fn();
    const utils = render(() => <DirectoryPicker open initialPath="/gone/deep" onPick={onPick} onClose={() => {}} />);
    const input = utils.getByLabelText("Filter folders, or type a path") as HTMLInputElement;
    await waitFor(() => expect(fail).toBeTypeOf("function"));
    fireEvent.input(input, { target: { value: "/usr/" } });
    await utils.findByText("local");
    fail();
    await new Promise((r) => setTimeout(r, 30));
    expect(clientRequestMock.mock.calls.map((c) => c[0].path)).not.toContain("/gone");
    expect(input.value).toBe("/usr/");
    expect(utils.getByText("local")).toBeTruthy();
    expect(utils.queryByText(/isn't available/)).toBeNull();
  });

  it("leaves Enter and Esc to an IME composition", async () => {
    const { findByText, getByRole, input, onClose } = setup();
    await findByText("notes");
    fireEvent.input(input, { target: { value: "s" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true, keyCode: 229 });
    fireEvent.keyDown(input, { key: "Escape", isComposing: true, keyCode: 229 });
    await new Promise((r) => setTimeout(r, 20));
    expect(getByRole("navigation", { name: "Path" }).textContent).not.toContain("src");
    expect(input.value).toBe("s");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps a filter typed while the folder it opened was loading", async () => {
    let release!: () => void;
    clientRequestMock.mockImplementation((msg) =>
      msg.path === `${HOME}/src` ? new Promise((res) => (release = () => res(serve(msg)))) : serve(msg),
    );
    const utils = render(() => <DirectoryPicker open onPick={() => {}} onClose={() => {}} />);
    const input = utils.getByLabelText("Filter folders, or type a path") as HTMLInputElement;
    await utils.findByText("notes");
    fireEvent.input(input, { target: { value: "src" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.input(input, { target: { value: "be" } });
    release();
    await utils.findByText("be", { selector: "mark" });
    expect(input.value).toBe("be");
    expect(utils.queryByText("alpha")).toBeNull();
  });

  it("gives focus back to what had it when the picker closes", async () => {
    clientRequestMock.mockImplementation(serve);
    const [open, setOpen] = createSignal(false);
    const utils = render(() => (
      <>
        <button type="button">Browse…</button>
        <DirectoryPicker open={open()} onPick={() => {}} onClose={() => setOpen(false)} />
      </>
    ));
    const opener = utils.getByText("Browse…");
    opener.focus();
    setOpen(true);
    await utils.findByText("notes");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});
