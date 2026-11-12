import { afterEach, describe, expect, it, vi } from "vitest";

const requests = vi.hoisted(() => [] as Array<{ resolve: (v: unknown) => void; msg: { id: string } }>);
vi.mock("./connection", () => ({
  newRequestId: (() => {
    let n = 0;
    return () => `r${++n}`;
  })(),
  getClient: () => ({
    request: (msg: { id: string }) => new Promise((resolve) => requests.push({ resolve, msg })),
  }),
}));

import { _resetWorkstreamsForTest, fetchWorkstreams, workstreamsState } from "./workstreams";

const list = (id: string, revision: string) => ({ type: "workstream.list.result", requestId: id, revision, isolateGlobalServers: false, workstreams: [] });

afterEach(() => {
  _resetWorkstreamsForTest();
  requests.length = 0;
});

describe("fetchWorkstreams", () => {
  it("a forced fetch during one in flight runs again after it: the newer list wins", async () => {
    const first = fetchWorkstreams(true);
    const forced = fetchWorkstreams(true);
    expect(requests).toHaveLength(1);
    requests[0]!.resolve(list(requests[0]!.msg.id, "old"));
    await first;
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    requests[1]!.resolve(list(requests[1]!.msg.id, "new"));
    await forced;
    expect(workstreamsState().revision).toBe("new");
  });
});
