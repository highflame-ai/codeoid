// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";

const clientRequestMock = vi.hoisted(() => vi.fn<(msg: Record<string, unknown>) => Promise<unknown>>());
vi.mock("../state/connection", () => ({
  request: vi.fn(),
  newRequestId: () => "r",
  getClient: () => ({ request: clientRequestMock }),
}));

import { EndpointEditor, tokensOf } from "./EndpointEditor";
import type { EndpointInfo } from "../protocol/types";

const STORED: EndpointInfo = {
  name: "box",
  providerId: "oai:box",
  displayName: "GPU box",
  baseUrl: "http://gpu-box:8000/v1",
  flavor: "openai",
  hasApiKey: true,
  headerNames: ["x-team"],
  models: [{ id: "qwen3-coder", contextWindow: 128000 }],
  mcpServers: "all",
  streamUsage: true,
  strictToolSchemas: false,
  maxTokensField: "max_tokens",
  createdAt: "",
  updatedAt: "",
};

const sent = () => clientRequestMock.mock.calls.map((c) => c[0]);

afterEach(() => {
  cleanup();
  clientRequestMock.mockReset();
});

describe("EndpointEditor", () => {
  it("editing keeps the stored key and headers unless replaced — they are never sent back", async () => {
    clientRequestMock.mockResolvedValue({ type: "endpoints.result", requestId: "r", endpoints: [STORED] });
    const done = vi.fn();
    const { getByText, getByDisplayValue } = render(() => <EndpointEditor existing={STORED} onDone={done} />);
    // Same origin, new path: the stored secrets stay put.
    fireEvent.input(getByDisplayValue("http://gpu-box:8000/v1"), { target: { value: "http://gpu-box:8000/v2" } });
    fireEvent.click(getByText("Save"));
    await waitFor(() => expect(done).toHaveBeenCalled());
    const msg = sent()[0]!;
    expect(msg).toMatchObject({
      type: "endpoints.set",
      name: "box",
      baseUrl: "http://gpu-box:8000/v2",
      models: [{ id: "qwen3-coder", contextWindow: 128000 }],
      mcpServers: "all",
    });
    expect("apiKey" in msg).toBe(false);
    expect("headers" in msg).toBe(false);
  });

  it("removing the key sends null; replacing it sends the new one", async () => {
    clientRequestMock.mockResolvedValue({ type: "endpoints.result", requestId: "r", endpoints: [STORED] });
    const { getByText, getByLabelText } = render(() => <EndpointEditor existing={STORED} onDone={() => {}} />);
    fireEvent.click(getByLabelText(/remove it/));
    fireEvent.click(getByText("Save"));
    await waitFor(() => expect(sent()[0]).toMatchObject({ apiKey: null }));
  });

  it("clearing model and context overrides sends explicit nulls", async () => {
    clientRequestMock.mockResolvedValue({ type: "endpoints.result", requestId: "r", endpoints: [STORED] });
    const { getByText, getByDisplayValue } = render(() => <EndpointEditor existing={{ ...STORED, defaultModel: "local-default", contextWindow: 32768 }} onDone={() => {}} />);
    fireEvent.input(getByDisplayValue("local-default"), { target: { value: "" } });
    fireEvent.input(getByDisplayValue("32768"), { target: { value: "" } });
    fireEvent.click(getByText("Save"));
    await waitFor(() => expect(sent()[0]).toMatchObject({ defaultModel: null, contextWindow: null }));
  });

  it("a new endpoint: validates the name, tests the draft, and adds it", async () => {
    clientRequestMock.mockImplementation(async (msg) =>
      msg.type === "endpoints.test"
        ? { type: "endpoints.test.result", requestId: "r", ok: true, models: ["a", "b"], latencyMs: 5 }
        : { type: "endpoints.result", requestId: "r", endpoints: [] },
    );
    const done = vi.fn();
    const { getByText, getByPlaceholderText, findByText } = render(() => <EndpointEditor onDone={done} />);
    const add = getByText("Add endpoint") as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.input(getByPlaceholderText("gpu-box"), { target: { value: "Bad Name" } });
    fireEvent.input(getByPlaceholderText("http://localhost:11434/v1"), { target: { value: "http://localhost:11434/v1" } });
    expect(add.disabled).toBe(true);
    fireEvent.input(getByPlaceholderText("gpu-box"), { target: { value: "ollama" } });
    expect(add.disabled).toBe(false);

    fireEvent.click(getByText("Test connection"));
    await findByText(/answered in 5 ms — 2 models/);
    expect(sent()[0]).toMatchObject({ type: "endpoints.test", baseUrl: "http://localhost:11434/v1" });
    expect("name" in sent()[0]!).toBe(false);
    fireEvent.click(getByText("Add the server's models"));
    fireEvent.click(add);
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(sent()[1]).toMatchObject({ type: "endpoints.set", name: "ollama", models: [{ id: "a" }, { id: "b" }] });
  });

  it("typing into a model row keeps the same input, focused, with every character", () => {
    const { getByText, getByPlaceholderText } = render(() => <EndpointEditor onDone={() => {}} />);
    fireEvent.click(getByText("+ Model"));
    const el = getByPlaceholderText("model id") as HTMLInputElement;
    el.focus();
    for (const ch of "qwen") {
      el.value += ch;
      fireEvent.input(el);
    }
    expect(el.isConnected).toBe(true);
    expect(document.activeElement).toBe(el);
    expect((getByPlaceholderText("model id") as HTMLInputElement).value).toBe("qwen");
  });

  it("typing into a header row keeps the same input and every character", () => {
    const { getByText, getByPlaceholderText } = render(() => <EndpointEditor existing={STORED} onDone={() => {}} />);
    fireEvent.click(getByText("Replace headers"));
    fireEvent.click(getByText("+ Header"));
    const el = getByPlaceholderText("x-workspace") as HTMLInputElement;
    el.focus();
    for (const ch of "x-team") {
      el.value += ch;
      fireEvent.input(el);
    }
    expect(el.isConnected).toBe(true);
    expect(document.activeElement).toBe(el);
    expect((getByPlaceholderText("x-workspace") as HTMLInputElement).value).toBe("x-team");
  });

  it("'Replace headers' can be backed out of — the stored headers are then left alone", async () => {
    clientRequestMock.mockResolvedValue({ type: "endpoints.result", requestId: "r", endpoints: [STORED] });
    const { getByText } = render(() => <EndpointEditor existing={STORED} onDone={() => {}} />);
    fireEvent.click(getByText("Replace headers"));
    getByText(/saving removes all stored headers/);
    fireEvent.click(getByText("Keep stored headers"));
    getByText("Replace headers");
    fireEvent.click(getByText("Save"));
    await waitFor(() => expect(sent()[0]).toMatchObject({ type: "endpoints.set" }));
    expect("headers" in sent()[0]!).toBe(false);
  });

  it("replacing headers with no rows removes them all, explicitly", async () => {
    clientRequestMock.mockResolvedValue({ type: "endpoints.result", requestId: "r", endpoints: [STORED] });
    const { getByText } = render(() => <EndpointEditor existing={STORED} onDone={() => {}} />);
    fireEvent.click(getByText("Replace headers"));
    fireEvent.click(getByText("Save"));
    await waitFor(() => expect(sent()[0]).toMatchObject({ type: "endpoints.set", headers: {} }));
  });

  it("a test with 'replace' chosen but no key typed uses the stored key (apiKey left out)", async () => {
    clientRequestMock.mockResolvedValue({ type: "endpoints.test.result", requestId: "r", ok: true, models: [], latencyMs: 1 });
    const { getByText, getByLabelText, findByText } = render(() => <EndpointEditor existing={STORED} onDone={() => {}} />);
    fireEvent.click(getByLabelText(/replace/));
    fireEvent.click(getByText("Test connection"));
    await findByText(/answered in 1 ms/);
    expect(sent()[0]).toMatchObject({ type: "endpoints.test", name: "box" });
    expect("apiKey" in sent()[0]!).toBe(false);
  });

  it("moving the base URL to another origin can't keep the stored key or headers", async () => {
    clientRequestMock.mockImplementation(async (msg) =>
      msg.type === "endpoints.test"
        ? { type: "endpoints.test.result", requestId: "r", ok: true, models: [], latencyMs: 1 }
        : { type: "endpoints.result", requestId: "r", endpoints: [STORED] },
    );
    const { getByText, getByDisplayValue, getByLabelText, queryByLabelText, queryByText, findByText } = render(() => (
      <EndpointEditor existing={STORED} onDone={() => {}} />
    ));
    const url = getByDisplayValue("http://gpu-box:8000/v1");
    // A port change is a different origin.
    fireEvent.input(url, { target: { value: "http://gpu-box:8001/v1" } });
    getByText(/only sent to the origin they were entered for/);
    expect(queryByLabelText(/keep stored key/)).toBeNull();
    expect(queryByText("Keep stored headers")).toBeNull();
    expect((getByText("Save") as HTMLButtonElement).disabled).toBe(true);

    // Remove the key; the headers are already in replace mode (no rows → none).
    fireEvent.click(getByLabelText(/remove it/));
    fireEvent.click(getByText("Test connection"));
    await findByText(/answered in 1 ms/);
    expect(sent()[0]).toMatchObject({ type: "endpoints.test", baseUrl: "http://gpu-box:8001/v1", apiKey: null, headers: {} });
    fireEvent.click(getByText("Save"));
    await waitFor(() => expect(sent()[1]).toMatchObject({ type: "endpoints.set", apiKey: null, headers: {} }));

    // Back to the stored origin (or an unparsable URL): keeping is on offer again.
    fireEvent.input(url, { target: { value: "not a url" } });
    expect(queryByText(/only sent to the origin/)).toBeNull();
    fireEvent.input(url, { target: { value: "http://gpu-box:8000/other" } });
    getByLabelText(/keep stored key/);
    getByText("Replace headers");
  });

  it("shows the daemon's validation message on save", async () => {
    clientRequestMock.mockRejectedValue(new Error("the base URL must be https for a public host"));
    const { getByText, findByRole } = render(() => <EndpointEditor existing={STORED} onDone={() => {}} />);
    fireEvent.click(getByText("Save"));
    expect((await findByRole("alert")).textContent).toContain("https");
  });

  it("tokensOf reads 32k and plain numbers", () => {
    expect(tokensOf("32k")).toBe(32000);
    expect(tokensOf("131072")).toBe(131072);
    expect(tokensOf("")).toBeUndefined();
    expect(Number.isNaN(tokensOf("lots"))).toBe(true);
  });
});
