// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";

const clientRequestMock = vi.hoisted(() => vi.fn<(msg: { type: string; id: string; path?: string }) => Promise<unknown>>());
vi.mock("../../state/connection", () => ({
  newRequestId: () => "r",
  getClient: () => ({ request: clientRequestMock }),
}));

import DirectoryPicker, { _resetDirectoryPickerForTest } from "./DirectoryPicker";

const HOME = "/home/me";
const TREE: Record<string, string[]> = {
  "/": ["Workspace", "home", "usr"],
  "/home": ["me"],
  [HOME]: ["notes", "src"],
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
    const { findByText, findByRole, getByText, input, onClose } = setup();
    await findByText("src");
    fireEvent.input(input, { target: { value: "/nope/" } });
    expect((await findByRole("alert")).textContent).toContain("no such path");
    expect(getByText("src")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
