import { afterEach, describe, expect, it } from "vitest";

import {
  _resetProvidersForTest,
  defaultProviderId,
  ingestAuthProviders,
  providerIds,
  providerLabel,
  setProviders,
} from "./providers";

afterEach(() => _resetProvidersForTest());

describe("providers store", () => {
  it("prefers auth.ok's providerInfo, with display names", () => {
    ingestAuthProviders({
      providers: ["claude", "oai:box"],
      providerInfo: [
        { id: "claude", displayName: "Claude (Anthropic)", kind: "builtin", isDefault: true },
        { id: "oai:box", displayName: "GPU box", kind: "endpoint", isDefault: false },
      ],
    });
    expect(providerIds()).toEqual(["claude", "oai:box"]);
    expect(providerLabel("oai:box")).toBe("GPU box");
    expect(defaultProviderId()).toBe("claude");
  });

  it("falls back to bare ids from an older daemon", () => {
    ingestAuthProviders({ providers: ["claude", "pi", "oai:x"] });
    expect(providerLabel("pi")).toBe("pi");
    expect(defaultProviderId()).toBe("claude");
  });

  it("labels an unknown id (a removed endpoint) by the id itself", () => {
    setProviders([{ id: "claude", displayName: "Claude", kind: "builtin", isDefault: true }]);
    expect(providerLabel("oai:gone")).toBe("oai:gone");
    expect(providerLabel(undefined)).toBe("");
  });
});
