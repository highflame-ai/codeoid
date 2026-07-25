// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import { PackBrowserView } from "./PackBrowser";
import type {
  AvailablePackWire,
  PackWire,
  RegistryWire,
} from "../protocol/types";

afterEach(cleanup);

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

function available(
  p: Partial<AvailablePackWire> & Pick<AvailablePackWire, "id" | "name">,
): AvailablePackWire {
  return {
    version: "1.0.0",
    registry: "ai-factory",
    dir: `/cache/${p.id}`,
    installed: false,
    ...p,
  };
}

function registry(
  p: Partial<RegistryWire> & Pick<RegistryWire, "name">,
): RegistryWire {
  return { url: `https://github.com/x/${p.name}`, cached: true, ...p };
}

const noop = () => {};

function baseProps() {
  return {
    installed: [],
    available: [],
    registries: [],
    onAddRegistry: noop,
    onRefresh: noop,
    onInstall: noop,
    onRemove: noop,
    onTrust: noop,
    onSelect: noop,
  };
}

describe("PackBrowserView", () => {
  it("renders registries, installed packs (with phase pipeline + trust), and available packs", () => {
    const { getByText, getAllByText, container } = render(() => (
      <PackBrowserView
        {...baseProps()}
        registries={[
          registry({ name: "ai-factory", cached: true, packCount: 3, ref: "main" }),
        ]}
        installed={[
          pack({
            id: "aif-sdlc",
            name: "AI Factory SDLC",
            description: "The canonical SDLC methodology.",
            trusted: true,
            selected: true,
            registry: "ai-factory",
            roles: ["reviewer"],
            gates: [{ id: "review", kind: "skill" }],
            phases: [
              { id: "plan", role: "reviewer" },
              { id: "build", gate: "review" },
              { id: "verify" },
            ],
          }),
        ]}
        available={[
          available({ id: "aif-docs", name: "Docs Pack", registry: "ai-factory" }),
        ]}
      />
    ));

    // Section headers.
    expect(getByText("Registries")).toBeTruthy();
    expect(getByText("Installed")).toBeTruthy();
    expect(getByText("Available")).toBeTruthy();

    // Registry card — the URL is unique; the name "ai-factory" also appears as
    // the installed pack's source and the available pack's registry.
    expect(getByText("https://github.com/x/ai-factory")).toBeTruthy();
    expect(getByText("cached")).toBeTruthy();
    expect(container.textContent).toContain("3 packs");
    expect(getAllByText("ai-factory").length).toBeGreaterThan(0);

    // Installed pack card: name, trust, default badge, phase chips.
    expect(getByText("AI Factory SDLC")).toBeTruthy();
    expect(getByText("The canonical SDLC methodology.")).toBeTruthy();
    expect(getByText("🔓 trusted")).toBeTruthy();
    expect(getByText("default")).toBeTruthy();
    expect(getByText("plan")).toBeTruthy();
    expect(getByText("build")).toBeTruthy();
    expect(getByText("verify")).toBeTruthy();
    // Actions present.
    expect(getByText("Untrust")).toBeTruthy();
    expect(getByText("Remove")).toBeTruthy();

    // Available pack card + install control.
    expect(getByText("Docs Pack")).toBeTruthy();
    expect(getByText("Install")).toBeTruthy();
  });

  it("shows empty states for every section", () => {
    const { getByText } = render(() => <PackBrowserView {...baseProps()} />);
    expect(getByText("No registries configured.")).toBeTruthy();
    expect(getByText("No packs installed.")).toBeTruthy();
    expect(getByText("No available packs.")).toBeTruthy();
  });

  it("renders a broken pack as a removable broken card", () => {
    const { getByText } = render(() => (
      <PackBrowserView
        {...baseProps()}
        installed={[pack({ id: "bad", name: "bad", error: "missing pack.yaml" })]}
      />
    ));
    expect(getByText("broken")).toBeTruthy();
    expect(getByText("missing pack.yaml")).toBeTruthy();
  });

  it("filters out already-installed packs from Available", () => {
    const { queryByText, getByText } = render(() => (
      <PackBrowserView
        {...baseProps()}
        available={[
          available({ id: "a", name: "Fresh Pack", installed: false }),
          available({ id: "b", name: "Already Installed", installed: true }),
        ]}
      />
    ));
    expect(getByText("Fresh Pack")).toBeTruthy();
    expect(queryByText("Already Installed")).toBeNull();
  });

  it("fires onRefresh with the registry name when the Refresh button is clicked", () => {
    const onRefresh = vi.fn();
    const { getAllByTitle } = render(() => (
      <PackBrowserView
        {...baseProps()}
        onRefresh={onRefresh}
        registries={[
          registry({ name: "ai-factory" }),
          registry({ name: "my-other-registry" }),
        ]}
      />
    ));
    const refreshBtns = getAllByTitle("Pull + reload this registry");
    fireEvent.click(refreshBtns[0]!);
    expect(onRefresh).toHaveBeenCalledWith("ai-factory");
    fireEvent.click(refreshBtns[1]!);
    expect(onRefresh).toHaveBeenCalledWith("my-other-registry");
  });

  it("fires onAddRegistry with the typed git URL", () => {
    const onAddRegistry = vi.fn();
    const { getByLabelText, getByText } = render(() => (
      <PackBrowserView {...baseProps()} onAddRegistry={onAddRegistry} />
    ));
    fireEvent.input(getByLabelText("Registry git URL"), {
      target: { value: "https://github.com/highflame-ai/ai-factory" },
    });
    fireEvent.click(getByText("Add registry"));
    expect(onAddRegistry).toHaveBeenCalledWith(
      "https://github.com/highflame-ai/ai-factory",
      undefined,
      undefined,
    );
  });

  it("fires onInstall with the trust-on-install choice", () => {
    const onInstall = vi.fn();
    const { getByText, getByLabelText } = render(() => (
      <PackBrowserView
        {...baseProps()}
        onInstall={onInstall}
        available={[available({ id: "aif-docs", name: "Docs Pack" })]}
      />
    ));
    // Default: untrusted install.
    fireEvent.click(getByText("Install"));
    expect(onInstall).toHaveBeenLastCalledWith("aif-docs", false);
    // Flip the section toggle → trusted install.
    fireEvent.click(getByLabelText("Trust on install"));
    fireEvent.click(getByText("Install"));
    expect(onInstall).toHaveBeenLastCalledWith("aif-docs", true);
  });
});
