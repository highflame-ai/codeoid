import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_SCOPES, ALL_SCOPES_STRING } from "../protocol/scopes.js";

/**
 * Guard against the login scope set drifting from the canonical one.
 *
 * `codeoid login` asks ZeroID to mint a token with a fixed scope string, and
 * codeoid then enforces scopes from that token VERBATIM (`auth.ts`:
 * `scopes: (identity.scopes ?? [])`) — there is no server-side expansion or
 * default. So a scope missing from the mint request is unreachable for the
 * life of the key, and the failure surfaces far from its cause: a bare
 * "Missing scope: settings:read" from the daemon, on a config that is
 * otherwise correct, which neither re-login nor a ZeroID upgrade can fix.
 *
 * That is exactly what happened: the list was a hand-maintained literal that
 * fell behind when `settings:*`, `fleet:read`, and `pipeline:*` were added,
 * while also carrying four `tools:*` entries that were never real scopes.
 */
describe("login scope set", () => {
  const cli = readFileSync(join(import.meta.dir, "..", "cli.ts"), "utf8");

  test("is derived from ALL_SCOPES, not hand-listed", () => {
    // The literal-array form is what rotted. Assert on the source so the
    // regression is caught structurally, not just by value.
    expect(cli).toContain("const CODEOID_LOGIN_SCOPES = ALL_SCOPES_STRING;");
  });

  test("mints every scope the daemon can enforce", () => {
    const minted = new Set(ALL_SCOPES_STRING.split(" "));
    const missing = ALL_SCOPES.filter((s) => !minted.has(s));
    expect(missing).toEqual([]);
  });

  test("mints nothing the protocol doesn't define", () => {
    // The old list asked for tools:read/write/execute/agent, none of which
    // were ever in SCOPES — ZeroID was being sent scopes that meant nothing.
    const defined = new Set<string>(ALL_SCOPES);
    const unknown = ALL_SCOPES_STRING.split(" ").filter((s) => !defined.has(s));
    expect(unknown).toEqual([]);
  });

  test("covers the scopes whose absence caused the original failure", () => {
    const minted = new Set(ALL_SCOPES_STRING.split(" "));
    for (const s of [
      "settings:read",
      "settings:write",
      "fleet:read",
      "pipeline:create",
      "pipeline:read",
      "pipeline:answer",
      "pipeline:manage",
    ]) {
      expect(minted.has(s)).toBe(true);
    }
  });
});
