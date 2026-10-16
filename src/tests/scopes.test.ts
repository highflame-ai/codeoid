/**
 * Scope enforcement tests — validates permission checking, scope sets,
 * and the principle of least privilege.
 */

import { describe, test, expect } from "bun:test";
import {
  SCOPES,
  ALL_SCOPES,
  WATCHER_SCOPES,
  OPERATOR_SCOPES,
  ALL_SCOPES_STRING,
  hasScope,
  hasAllScopes,
} from "../protocol/scopes.js";

describe("SCOPES constants", () => {
  test("all 18 scopes are defined", () => {
    expect(Object.keys(SCOPES)).toHaveLength(18);
    expect(SCOPES.SESSION_CREATE).toBe("session:create");
    expect(SCOPES.SESSION_ATTACH).toBe("session:attach");
    expect(SCOPES.SESSION_WATCH).toBe("session:watch");
    expect(SCOPES.SESSION_SEND).toBe("session:send");
    expect(SCOPES.SESSION_INTERRUPT).toBe("session:interrupt");
    expect(SCOPES.SESSION_APPROVE).toBe("session:approve");
    expect(SCOPES.SESSION_DESTROY).toBe("session:destroy");
    expect(SCOPES.SESSION_LIST).toBe("session:list");
    expect(SCOPES.SESSION_READ).toBe("session:read");
    expect(SCOPES.SESSION_DISPATCH).toBe("session:dispatch");
    expect(SCOPES.FLEET_READ).toBe("fleet:read");
    expect(SCOPES.FS_READ).toBe("fs:read");
    expect(SCOPES.SETTINGS_READ).toBe("settings:read");
    expect(SCOPES.SETTINGS_WRITE).toBe("settings:write");
    expect(SCOPES.PIPELINE_CREATE).toBe("pipeline:create");
    expect(SCOPES.PIPELINE_READ).toBe("pipeline:read");
    expect(SCOPES.PIPELINE_ANSWER).toBe("pipeline:answer");
    expect(SCOPES.PIPELINE_MANAGE).toBe("pipeline:manage");
  });

  test("ALL_SCOPES contains all 18", () => {
    expect(ALL_SCOPES).toHaveLength(18);
    for (const scope of Object.values(SCOPES)) {
      expect(ALL_SCOPES).toContain(scope);
    }
  });

  test("ALL_SCOPES_STRING is space-delimited", () => {
    const parts = ALL_SCOPES_STRING.split(" ");
    expect(parts).toHaveLength(18);
    for (const scope of ALL_SCOPES) {
      expect(parts).toContain(scope);
    }
  });
});

describe("WATCHER_SCOPES (least privilege)", () => {
  test("has list, watch, and fs:read", () => {
    expect(WATCHER_SCOPES).toHaveLength(3);
    expect(WATCHER_SCOPES).toContain(SCOPES.SESSION_LIST);
    expect(WATCHER_SCOPES).toContain(SCOPES.SESSION_WATCH);
    expect(WATCHER_SCOPES).toContain(SCOPES.FS_READ);
  });

  test("cannot create sessions", () => {
    expect(hasScope(WATCHER_SCOPES as string[], SCOPES.SESSION_CREATE)).toBe(false);
  });

  test("cannot send messages", () => {
    expect(hasScope(WATCHER_SCOPES as string[], SCOPES.SESSION_SEND)).toBe(false);
  });

  test("cannot approve tools", () => {
    expect(hasScope(WATCHER_SCOPES as string[], SCOPES.SESSION_APPROVE)).toBe(false);
  });

  test("cannot destroy sessions", () => {
    expect(hasScope(WATCHER_SCOPES as string[], SCOPES.SESSION_DESTROY)).toBe(false);
  });

  test("cannot interrupt", () => {
    expect(hasScope(WATCHER_SCOPES as string[], SCOPES.SESSION_INTERRUPT)).toBe(false);
  });
});

describe("OPERATOR_SCOPES", () => {
  test("has all except destroy", () => {
    expect(OPERATOR_SCOPES).toContain(SCOPES.SESSION_CREATE);
    expect(OPERATOR_SCOPES).toContain(SCOPES.SESSION_ATTACH);
    expect(OPERATOR_SCOPES).toContain(SCOPES.SESSION_SEND);
    expect(OPERATOR_SCOPES).toContain(SCOPES.SESSION_APPROVE);
    expect(OPERATOR_SCOPES).not.toContain(SCOPES.SESSION_DESTROY);
  });

  test("can read settings but not write them (config is owner-only)", () => {
    expect(OPERATOR_SCOPES).toContain(SCOPES.SETTINGS_READ);
    expect(OPERATOR_SCOPES).not.toContain(SCOPES.SETTINGS_WRITE);
  });

  test("can create/read pipelines but not manage packs (owner-only, like settings:write)", () => {
    expect(OPERATOR_SCOPES).toContain(SCOPES.PIPELINE_CREATE);
    expect(OPERATOR_SCOPES).toContain(SCOPES.PIPELINE_READ);
    expect(OPERATOR_SCOPES).not.toContain(SCOPES.PIPELINE_MANAGE);
  });
});

describe("conductor scopes stay conductor-only", () => {
  test("watcher and operator profiles do not gain fleet scopes", () => {
    for (const profile of [WATCHER_SCOPES, OPERATOR_SCOPES]) {
      expect(profile).not.toContain(SCOPES.SESSION_READ);
      expect(profile).not.toContain(SCOPES.SESSION_DISPATCH);
    }
  });
});

describe("hasScope", () => {
  test("returns true when scope is present", () => {
    expect(hasScope(["session:create", "session:list"], SCOPES.SESSION_CREATE)).toBe(true);
  });

  test("returns false when scope is missing", () => {
    expect(hasScope(["session:list"], SCOPES.SESSION_CREATE)).toBe(false);
  });

  test("returns false for empty scopes", () => {
    expect(hasScope([], SCOPES.SESSION_CREATE)).toBe(false);
  });

  test("exact match only — no prefix matching", () => {
    expect(hasScope(["session:create:sub"], SCOPES.SESSION_CREATE)).toBe(false);
    expect(hasScope(["session"], SCOPES.SESSION_CREATE)).toBe(false);
  });
});

describe("hasAllScopes", () => {
  test("returns true when all required scopes present", () => {
    expect(hasAllScopes(
      ["session:create", "session:list", "session:send"],
      [SCOPES.SESSION_CREATE, SCOPES.SESSION_LIST],
    )).toBe(true);
  });

  test("returns false when any required scope missing", () => {
    expect(hasAllScopes(
      ["session:create"],
      [SCOPES.SESSION_CREATE, SCOPES.SESSION_LIST],
    )).toBe(false);
  });

  test("returns true for empty required set", () => {
    expect(hasAllScopes(["session:create"], [])).toBe(true);
  });

  test("returns true for empty required with empty granted", () => {
    expect(hasAllScopes([], [])).toBe(true);
  });
});
