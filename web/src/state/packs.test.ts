// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";

const clientRequestMock = vi.hoisted(() => vi.fn());
vi.mock("./connection", () => ({
  newRequestId: () => "r",
  getClient: () => ({ request: clientRequestMock }),
}));

import {
  fetchPacks,
  addRegistry,
  refreshRegistry,
  installPack,
  selectPack,
  packsState,
  _resetPacksForTest,
} from "./packs";

afterEach(() => {
  _resetPacksForTest();
  clientRequestMock.mockReset();
});

function result(over: Record<string, unknown> = {}) {
  return {
    type: "pipeline.pack.list.result",
    requestId: "r",
    installed: [],
    available: [],
    registries: [],
    ...over,
  };
}

describe("packs store", () => {
  it("fetchPacks applies the returned slice", async () => {
    clientRequestMock.mockResolvedValueOnce(
      result({
        installed: [{ id: "aif-sdlc", name: "AIF" }],
        registries: [{ name: "ai-factory", url: "u", cached: true }],
      }),
    );
    await fetchPacks();
    expect(packsState().installed).toHaveLength(1);
    expect(packsState().registries[0]?.name).toBe("ai-factory");
    expect(packsState().loaded).toBe(true);
    expect(packsState().loading).toBe(false);
    expect(packsState().error).toBeNull();
  });

  it("addRegistry sends the verb and replaces state from the fresh result", async () => {
    clientRequestMock.mockResolvedValueOnce(
      result({ registries: [{ name: "ai-factory", url: "u", cached: true, packCount: 2 }] }),
    );
    await addRegistry("https://github.com/x/ai-factory", "ai-factory", "main");
    expect(clientRequestMock).toHaveBeenCalledTimes(1);
    const sent = clientRequestMock.mock.calls[0]?.[0];
    expect(sent).toMatchObject({
      type: "pipeline.registry.add",
      url: "https://github.com/x/ai-factory",
      name: "ai-factory",
      ref: "main",
    });
    expect(packsState().registries[0]?.packCount).toBe(2);
    expect(packsState().busy).toBe(false);
  });

  it("installPack defaults trusted to false", async () => {
    clientRequestMock.mockResolvedValueOnce(result());
    await installPack("aif-sdlc");
    expect(clientRequestMock.mock.calls[0]?.[0]).toMatchObject({
      type: "pipeline.pack.install",
      packId: "aif-sdlc",
      trusted: false,
    });
  });

  it("selectPack forwards a null to clear the default", async () => {
    clientRequestMock.mockResolvedValueOnce(result());
    await selectPack(null);
    expect(clientRequestMock.mock.calls[0]?.[0]).toMatchObject({
      type: "pipeline.pack.select",
      packId: null,
    });
  });

  it("refreshRegistry sends the verb with the registry name and applies the result", async () => {
    clientRequestMock.mockResolvedValueOnce(
      result({ registries: [{ name: "ai-factory", url: "u", cached: true }] }),
    );
    await refreshRegistry("ai-factory");
    const sent = clientRequestMock.mock.calls[0]?.[0];
    expect(sent).toMatchObject({ type: "pipeline.registry.refresh", name: "ai-factory" });
    expect(packsState().busy).toBe(false);
    expect(packsState().registries[0]?.name).toBe("ai-factory");
  });

  it("surfaces a forbidden response.error without crashing", async () => {
    clientRequestMock.mockRejectedValueOnce({
      type: "response.error",
      requestId: "r",
      error: "Missing scope: pipeline:manage",
      code: "forbidden",
    });
    await installPack("aif-sdlc", true);
    expect(packsState().error).toBe("Missing scope: pipeline:manage");
    expect(packsState().busy).toBe(false);
  });

  it("surfaces a transport Error too", async () => {
    clientRequestMock.mockRejectedValueOnce(new Error("timeout"));
    await fetchPacks();
    expect(packsState().error).toBe("timeout");
  });
});
