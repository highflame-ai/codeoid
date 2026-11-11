// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ save: vi.fn(() => Promise.resolve()), settings: vi.fn(() => Promise.resolve()), setValue: vi.fn(() => Promise.resolve()), del: vi.fn(() => Promise.resolve()) }));
vi.mock("../state/connection", () => ({ getClient: () => ({ request: vi.fn() }), newRequestId: () => "r" }));
vi.mock("../state/workstreams", () => ({
  fetchWorkstreams: vi.fn(() => Promise.resolve()),
  fetchCredentials: vi.fn(() => Promise.resolve()),
  resolveWorkstream: vi.fn(() => Promise.resolve({ home: "acme", source: "matched", matchedBy: "~/acme", candidates: [] })),
  saveWorkstream: calls.save,
  deleteWorkstream: calls.del,
  saveWorkstreamSettings: calls.settings,
  saveCredential: vi.fn(() => Promise.resolve()),
  deleteCredential: vi.fn(() => Promise.resolve()),
  setCredentialValue: calls.setValue,
  workstreamsState: () => ({
    loaded: true,
    loading: false,
    revision: "r1",
    isolateGlobalServers: false,
    workstreams: [
      {
        id: "acme",
        name: "Acme",
        abstract: false,
        extends: [],
        claim: "exclusive",
        allowOverride: true,
        share: "ask",
        match: { paths: ["~/acme"], remotes: [] },
        servers: [{ server: "github", credential: "gh", from: "acme" }],
        accounts: {},
        defaults: {},
        env: ["GH_TOKEN"],
        skillDirs: [],
        config: { id: "acme", name: "Acme", claim: "exclusive", match: { paths: ["~/acme"], remotes: [] }, mcpServers: [{ server: "github", credential: "gh" }], env: { GH_TOKEN: { secret: "gh-env" } }, accounts: { claude: "work" } },
      },
    ],
    error: null,
  }),
  credentialsState: () => ({
    loaded: true,
    store: { kind: "env-file", writable: true },
    credentials: [{ id: "gh-env", kind: "env", status: { set: false }, usedBy: ["acme"] }],
    error: null,
  }),
}));

import { CredentialsPanel } from "./CredentialsPanel";
import { WorkstreamsPanel } from "./WorkstreamsPanel";

afterEach(() => {
  cleanup();
  for (const f of Object.values(calls)) f.mockClear();
});

describe("WorkstreamsPanel", () => {
  it("edits keep what the editor doesn't show; isolation is one switch", async () => {
    const r = render(() => <WorkstreamsPanel />);
    fireEvent.click(r.getByRole("button", { name: "Edit" }));
    const form = r.getByRole("form", { name: "Edit acme" });
    fireEvent.input(form.querySelector("textarea") as HTMLTextAreaElement, { target: { value: "~/acme\n~/acme-*" } });
    fireEvent.submit(form);
    await waitFor(() => expect(calls.save).toHaveBeenCalled());
    expect(calls.save.mock.calls[0][0]).toMatchObject({ id: "acme", match: { paths: ["~/acme", "~/acme-*"] }, accounts: { claude: "work" }, mcpServers: [{ server: "github", credential: "gh" }] });
    fireEvent.click(r.getByRole("checkbox", { name: /Isolate MCP servers/ }));
    await waitFor(() => expect(calls.settings).toHaveBeenCalledWith({ isolateGlobalServers: true }));
  });

  it("checks a folder", async () => {
    const r = render(() => <WorkstreamsPanel />);
    fireEvent.input(r.getByLabelText("Folder to check"), { target: { value: "~/acme" } });
    fireEvent.click(r.getByRole("button", { name: "Check" }));
    expect((await r.findByTestId("folder-check-result")).textContent).toContain("acme — matched by ~/acme");
  });
});

describe("CredentialsPanel", () => {
  it("a value is sent once from a password field and cleared; it is never shown", async () => {
    const r = render(() => <CredentialsPanel />);
    const field = r.getByLabelText("Value of gh-env") as HTMLInputElement;
    expect(field.type).toBe("password");
    fireEvent.input(field, { target: { value: "ghp_secret" } });
    fireEvent.click(r.getByRole("button", { name: "Set" }));
    await waitFor(() => expect(calls.setValue).toHaveBeenCalledWith("gh-env", "ghp_secret"));
    await waitFor(() => expect(field.value).toBe(""));
    expect(r.container.textContent).not.toContain("ghp_secret");
    expect(r.getByTestId("credential-gh-env").textContent).toContain("used by acme");
  });
});
