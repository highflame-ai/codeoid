// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

const requestMock = vi.hoisted(() =>
  vi.fn<(msg: unknown, opts?: unknown) => Promise<unknown>>(),
);
vi.mock("./connection", () => ({
  getClient: () => ({ request: requestMock }),
  newRequestId: () => `r-${Math.random()}`,
}));

import {
  fetchModels,
  modelCatalog,
  modelsLive,
  _resetModelsForTest,
  resolveModelInput,
} from "./models";
import type { ModelInfo } from "../protocol/types";

function result(provider: string, models: ModelInfo[], live = true) {
  return {
    type: "models.list.result" as const,
    requestId: "x",
    provider,
    models,
    live,
  };
}

const CLAUDE: ModelInfo[] = [
  { value: "opus", displayName: "Opus" },
  { value: "sonnet", displayName: "Sonnet" },
];
const CODEX: ModelInfo[] = [{ value: "gpt-5-codex", displayName: "GPT-5 Codex" }];

beforeEach(() => _resetModelsForTest());
afterEach(() => {
  requestMock.mockReset();
  _resetModelsForTest();
});

describe("fetchModels — per-backend catalog", () => {
  it("sends the requested provider on the wire", async () => {
    requestMock.mockResolvedValueOnce(result("codex", CODEX));
    await fetchModels("codex");
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls[0]![0]).toMatchObject({
      type: "models.list",
      provider: "codex",
    });
    expect(modelCatalog().map((m) => m.value)).toEqual(["gpt-5-codex"]);
    expect(modelsLive()).toBe(true);
  });

  it("omits provider when none is given (daemon default)", async () => {
    requestMock.mockResolvedValueOnce(result("claude", CLAUDE));
    await fetchModels();
    expect(requestMock.mock.calls[0]![0]).not.toHaveProperty("provider");
  });

  it("switching backends swaps the catalog — never shows the old backend's models", async () => {
    requestMock.mockResolvedValueOnce(result("claude", CLAUDE));
    await fetchModels("claude");
    expect(modelCatalog().map((m) => m.value)).toEqual(["opus", "sonnet"]);

    // Switch to codex: the claude list must not linger.
    requestMock.mockResolvedValueOnce(result("codex", CODEX));
    await fetchModels("codex", true);
    expect(modelCatalog().map((m) => m.value)).toEqual(["gpt-5-codex"]);
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it("serves a cached live list without refetching (unless forced)", async () => {
    requestMock.mockResolvedValueOnce(result("claude", CLAUDE));
    await fetchModels("claude");
    await fetchModels("claude"); // cached + live → no second request
    expect(requestMock).toHaveBeenCalledTimes(1);

    await fetchModels("claude", true); // force → refetch
    // (mockResolvedValueOnce is exhausted; force still issues the request)
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it("a not-yet-live backend is refetched (models unknown until first use)", async () => {
    requestMock.mockResolvedValueOnce(result("codex", [], false)); // empty + not live
    await fetchModels("codex");
    expect(modelCatalog()).toEqual([]);
    expect(modelsLive()).toBe(false);

    requestMock.mockResolvedValueOnce(result("codex", CODEX, true)); // now populated
    await fetchModels("codex");
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(modelCatalog().map((m) => m.value)).toEqual(["gpt-5-codex"]);
  });

  it("clears a stale catalog immediately when switching to an unfetched backend", async () => {
    requestMock.mockResolvedValueOnce(result("claude", CLAUDE));
    await fetchModels("claude");

    // Switch to codex; the response is slow — the claude list must clear NOW,
    // not after the await resolves.
    let resolveCodex!: (v: unknown) => void;
    requestMock.mockImplementationOnce(() => new Promise((r) => (resolveCodex = r)));
    const pending = fetchModels("codex", true);
    expect(modelCatalog()).toEqual([]); // synchronously cleared
    resolveCodex(result("codex", CODEX));
    await pending;
    expect(modelCatalog().map((m) => m.value)).toEqual(["gpt-5-codex"]);
  });

  it("a slow response for a backend the user already switched away from is dropped", async () => {
    // codex fetch is slow…
    let resolveCodex!: (v: unknown) => void;
    requestMock.mockImplementationOnce(() => new Promise((r) => (resolveCodex = r)));
    const codexFetch = fetchModels("codex", true);

    // …user switches to claude, which resolves first.
    requestMock.mockResolvedValueOnce(result("claude", CLAUDE));
    await fetchModels("claude", true);
    expect(modelCatalog().map((m) => m.value)).toEqual(["opus", "sonnet"]);

    // Now the stale codex response lands — it must NOT clobber the claude view.
    resolveCodex(result("codex", CODEX));
    await codexFetch;
    expect(modelCatalog().map((m) => m.value)).toEqual(["opus", "sonnet"]);
  });
});

describe("resolveModelInput — shares the daemon's rule", () => {
  // The real payload: the backend reports the variant as a suffix on the
  // VALUE ("opus[1m]") and a display name that never matches the bare alias
  // ("Opus (1M context)"). The client used to compare only those two fields
  // verbatim, so `/model opus` was rejected as unknown before the request was
  // sent — while the daemon behind it resolved the very same input fine.
  const LIVE: ModelInfo[] = [
    { value: "default", displayName: "Default (recommended)" },
    { value: "opus[1m]", displayName: "Opus (1M context)" },
    { value: "claude-fable-5-1[1m]", displayName: "Fable" },
    { value: "sonnet", displayName: "Sonnet" },
  ];

  it("resolves a bare alias against the variant-suffixed value", async () => {
    requestMock.mockResolvedValueOnce(result("claude", LIVE));
    await fetchModels("claude");
    expect(resolveModelInput("opus")).toBe("opus[1m]");
    expect(resolveModelInput("OPUS")).toBe("opus[1m]");
  });

  it("resolves an exact value and a display name", async () => {
    requestMock.mockResolvedValueOnce(result("claude", LIVE));
    await fetchModels("claude");
    expect(resolveModelInput("sonnet")).toBe("sonnet");
    expect(resolveModelInput("fable")).toBe("claude-fable-5-1[1m]");
  });

  it("passes input through before the catalog has arrived", () => {
    expect(resolveModelInput("opus")).toBe("opus");
  });

  it("returns null for input that matches nothing", async () => {
    requestMock.mockResolvedValueOnce(result("claude", LIVE));
    await fetchModels("claude");
    expect(resolveModelInput("nope")).toBeNull();
  });
});
