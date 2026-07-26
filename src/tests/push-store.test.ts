/**
 * push_registrations persistence — owner-scoped device tokens keyed by the
 * ZeroID identity (sub == sessions.created_by), tenant-scoped by account/project.
 * The guarantees the push routing relies on: register/refresh, tenant + owner
 * isolation on lookup, and owner-scoped delete.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../daemon/store.js";

let tmp: string;
let store: Store;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-push-store-"));
  store = new Store(join(tmp, "codeoid.db"));
});

afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("push_registrations store", () => {
  test("register then list, scoped to owner + tenant", () => {
    store.registerPush("tok-a", "ios", "user:a", "acc", "proj");
    expect(store.listPushForOwner("user:a", "acc", "proj")).toEqual([
      { token: "tok-a", platform: "ios" },
    ]);
  });

  test("lookup is isolated by owner AND by tenant", () => {
    store.registerPush("tok-a", "ios", "user:a", "acc", "proj");
    store.registerPush("tok-b", "android", "user:b", "acc", "proj"); // other owner
    store.registerPush("tok-a2", "ios", "user:a", "acc2", "proj"); // other account
    store.registerPush("tok-a3", "ios", "user:a", "acc", "proj2"); // other project

    expect(store.listPushForOwner("user:a", "acc", "proj")).toEqual([
      { token: "tok-a", platform: "ios" },
    ]);
    expect(store.listPushForOwner("user:b", "acc", "proj")).toEqual([
      { token: "tok-b", platform: "android" },
    ]);
    expect(store.listPushForOwner("user:c", "acc", "proj")).toEqual([]);
  });

  test("multiple devices for one owner all come back", () => {
    store.registerPush("tok-1", "ios", "user:a", "acc", "proj");
    store.registerPush("tok-2", "android", "user:a", "acc", "proj");
    const tokens = store.listPushForOwner("user:a", "acc", "proj").map((r) => r.token).sort();
    expect(tokens).toEqual(["tok-1", "tok-2"]);
  });

  test("re-registering the same token updates owner/platform (no duplicate row)", () => {
    store.registerPush("tok-x", "ios", "user:a", "acc", "proj");
    // Same physical device, now owned by user:b (e.g. a shared device re-signed-in).
    store.registerPush("tok-x", "android", "user:b", "acc", "proj");
    expect(store.listPushForOwner("user:a", "acc", "proj")).toEqual([]);
    expect(store.listPushForOwner("user:b", "acc", "proj")).toEqual([
      { token: "tok-x", platform: "android" },
    ]);
  });

  test("unregister is owner-scoped — cannot delete another user's token", () => {
    store.registerPush("tok-a", "ios", "user:a", "acc", "proj");
    store.registerPush("tok-b", "ios", "user:b", "acc", "proj");
    // user:a attempts to unregister user:b's token — must be a no-op.
    store.unregisterPush("tok-b", "user:a");
    expect(store.listPushForOwner("user:b", "acc", "proj")).toHaveLength(1);
    // user:a unregisters its own token — removed.
    store.unregisterPush("tok-a", "user:a");
    expect(store.listPushForOwner("user:a", "acc", "proj")).toEqual([]);
  });
});
