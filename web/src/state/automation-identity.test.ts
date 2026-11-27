// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";

vi.mock("./connection", () => ({
  newRequestId: () => "r",
  getClient: () => ({ request: vi.fn().mockReturnValue(new Promise(() => {})) }),
}));

import { followAutomationIdentity } from "./automation-identity";
import { _resetRoutinesForTest, revealRoutineToken, routinesState } from "./routines";
import type { AuthOkMsg } from "../protocol/types";

const auth = (sub: string, scopes = ["session:create", "session:approve"]): AuthOkMsg =>
  ({ type: "auth.ok", identity: { sub, type: "human" }, scopes }) as AuthOkMsg;
const token = { routineId: "rt_1", apiToken: "rt_secret", endpointPath: "/routines/rt_1/fire" };

afterEach(() => _resetRoutinesForTest());

describe("the automation stores follow the identity signed in", () => {
  it("a reconnect as the same identity keeps a token shown once; another identity or a sign-out takes it", () => {
    const [who, setWho] = createSignal<AuthOkMsg | null>(auth("spiffe://t/user/a"));
    const dispose = createRoot((d) => {
      followAutomationIdentity(who);
      return d;
    });
    try {
      revealRoutineToken(token);

      // A re-authenticated connection hands over a new auth.ok for the same identity.
      setWho(auth("spiffe://t/user/a", ["session:approve", "session:create"]));
      expect(routinesState().token).toEqual(token);

      setWho(auth("spiffe://t/user/b"));
      expect(routinesState().token).toBeNull();

      revealRoutineToken(token);
      setWho(null);
      expect(routinesState().token).toBeNull();
    } finally {
      dispose();
    }
  });
});
