/**
 * The account store for every backend (accounts.ts): kinds per backend,
 * write-only secrets, explicit replace, defaults per backend, resolve, homes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountError, AccountStore } from "../daemon/accounts.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeoid-accounts-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const storeAt = () => new AccountStore({ path: join(dir, "accounts.json"), homesRoot: join(dir, "homes"), legacyClaudePath: null });

describe("AccountStore", () => {
  test("accounts belong to one backend; secrets are stored 0600 and never listed", () => {
    const store = storeAt();
    store.upsert({ backend: "codex", name: "work", kind: "api-key", token: "sk-codex-secret" });
    store.upsert({ backend: "qwen", name: "work", kind: "api-key", token: "sk-sp-qwen-secret", baseUrl: "bailian-plan-intl" });
    store.upsert({ backend: "pi", name: "team", kind: "api-keys", env: { OPENROUTER_API_KEY: "or-secret" } });
    expect(statSync(join(dir, "accounts.json")).mode & 0o777).toBe(0o600);
    const listed = JSON.stringify([store.list("codex"), store.list("qwen"), store.list("pi")]);
    for (const secret of ["sk-codex-secret", "sk-sp-qwen-secret", "or-secret"]) expect(listed).not.toContain(secret);
    expect(store.list("pi")[0]).toMatchObject({ backend: "pi", name: "team", kind: "api-keys", envNames: ["OPENROUTER_API_KEY"] });
    // Same name, different backends: different accounts.
    expect(store.get("codex", "work")?.token).toBe("sk-codex-secret");
    expect(store.get("qwen", "work")?.token).toBe("sk-sp-qwen-secret");
    expect(store.get("gemini", "work")).toBeUndefined();
    expect(storeAt().get("codex", "work")?.token).toBe("sk-codex-secret");
  });

  test("each backend takes only its own kinds and fields", () => {
    const store = storeAt();
    expect(() => store.upsert({ backend: "mock", name: "a", kind: "api-key", token: "k" })).toThrow(/has no accounts/);
    expect(() => store.upsert({ backend: "openai", name: "a", kind: "gateway", token: "k" })).toThrow(/one of: api-key/);
    expect(() => store.upsert({ backend: "openai", name: "a", kind: "api-key" })).toThrow(/needs its api key/);
    expect(() => store.upsert({ backend: "openai", name: "a", kind: "api-key", token: "k", baseUrl: "https://x.example" })).toThrow(/no base URL/);
    expect(() => store.upsert({ backend: "qwen", name: "a", kind: "api-key", token: "k" })).toThrow(/needs its endpoint/);
    expect(() => store.upsert({ backend: "qwen", name: "a", kind: "api-key", token: "k", baseUrl: "http://evil.example/v1" })).toThrow(/https/);
    expect(() => store.upsert({ backend: "qwen", name: "a", kind: "api-key", token: "k", baseUrl: "https://openrouter.ai/api/v1" })).not.toThrow();
    expect(() => store.upsert({ backend: "pi", name: "p", kind: "api-keys", env: { AWS_SECRET_ACCESS_KEY: "x" } })).toThrow(/not a key this backend reads/);
    expect(() => store.upsert({ backend: "pi", name: "p", kind: "api-keys", env: {} })).toThrow(/at least one key/);
    // A login kind is created by signing in, never typed in.
    expect(() => store.upsert({ backend: "codex", name: "c", kind: "chatgpt-login", token: "x" })).toThrow(/sign in/);
    expect(() => store.upsert({ backend: "codex", name: "c", kind: "chatgpt-login" })).not.toThrow();
    expect(() => store.upsert({ backend: "openai", name: "default", kind: "api-key", token: "k" })).toThrow(/built-in/);
    expect(() => store.upsert({ backend: "openai", name: "k", kind: "api-key", token: "a\nb" })).toThrow(/single/);
  });

  test("an endpoint account needs a key or headers, and records its server", () => {
    const store = storeAt();
    expect(() => store.upsert({ backend: "oai:box", name: "a", kind: "api-key", origin: "http://box:8000" })).toThrow(/key or at least one header/);
    expect(() => store.upsert({ backend: "oai:box", name: "a", kind: "api-key", token: "k" })).toThrow(/server it was entered for/);
    expect(() =>
      store.upsert({ backend: "oai:box", name: "a", kind: "api-key", token: "k", headers: { Authorization: "Bearer x" }, origin: "http://box:8000" }),
    ).toThrow(/not both/);
    store.upsert({ backend: "oai:box", name: "a", kind: "api-key", headers: { "x-team": "t" }, origin: "http://box:8000" });
    expect(store.list("oai:box")[0]).toMatchObject({ headerNames: ["x-team"] });
  });

  test("an existing name is replaced only explicitly; a replacement is a new generation", () => {
    const store = storeAt();
    store.upsert({ backend: "openai", name: "work", kind: "api-key", token: "k1" });
    expect(() => store.upsert({ backend: "openai", name: "work", kind: "api-key", token: "k2" })).toThrow(/already exists/);
    const before = store.resolve("openai", "work")!.fingerprint;
    store.upsert({ backend: "openai", name: "work", kind: "api-key", token: "k2", replace: true });
    expect(store.get("openai", "work")).toMatchObject({ token: "k2", generation: 2 });
    expect(store.resolve("openai", "work")!.fingerprint).not.toBe(before);
    // A login account re-signed-in under the same name (same — empty — typed fields) still changes.
    store.upsert({ backend: "codex", name: "c", kind: "chatgpt-login" });
    const login = store.resolve("codex", "c")!.fingerprint;
    store.upsert({ backend: "codex", name: "c", kind: "chatgpt-login", replace: true });
    expect(store.resolve("codex", "c")!.fingerprint).not.toBe(login);
  });

  test("defaults are per backend; resolve follows them, pins, and refuses a missing account", () => {
    const store = storeAt();
    store.upsert({ backend: "openai", name: "team", kind: "api-key", token: "k" });
    expect(store.resolve("openai", null)).toBeNull(); // built-in default
    store.setDefault("openai", "team");
    expect(store.getDefault("openai")).toBe("team");
    expect(store.getDefault("gemini")).toBe("default");
    expect(store.resolve("openai", null)?.name).toBe("team");
    expect(store.resolve("openai", "default")).toBeNull(); // pinned built-in
    expect(() => store.resolve("openai", "gone")).toThrow(/no longer exists/);
    expect(() => store.setDefault("openai", "gone")).toThrow(AccountError);
    // Removing the default clears it.
    expect(store.remove("openai", "team")).toBe(true);
    expect(store.getDefault("openai")).toBe("default");
    expect(store.remove("openai", "team")).toBe(false);
  });

  test("removing an account deletes its home; removing an endpoint's backend removes its accounts", () => {
    const store = storeAt();
    store.upsert({ backend: "codex", name: "c", kind: "chatgpt-login" });
    const home = store.homeOf("codex", "c");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "auth.json"), "{}");
    store.remove("codex", "c");
    expect(existsSync(home)).toBe(false);
    store.upsert({ backend: "oai:box", name: "a", kind: "api-key", token: "k", origin: "http://box:8000" });
    store.removeBackend("oai:box");
    expect(store.list("oai:box")).toEqual([]);
    // Homes never escape the root, whatever the backend id.
    expect(store.homeOf("oai:../../x", "a").startsWith(join(dir, "homes"))).toBe(true);
  });

  test("change listeners hear the backend; a hand edit is re-read; a corrupt file fails closed", () => {
    const store = storeAt();
    const heard: string[] = [];
    store.onChange((b) => heard.push(b));
    store.upsert({ backend: "gemini", name: "g", kind: "api-key", token: "k" });
    store.setDefault("gemini", "g");
    expect(heard).toEqual(["gemini", "gemini"]);
    const path = join(dir, "accounts.json");
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    onDisk.backends.openai = { accounts: [{ name: "hand", kind: "api-key", token: "k", generation: 1, createdAt: "", updatedAt: "" }] };
    writeFileSync(path, JSON.stringify(onDisk));
    const later = new Date(Date.now() + 5_000);
    utimesSync(path, later, later);
    expect(store.list("openai").map((a) => a.name)).toEqual(["hand"]);
    writeFileSync(path, "{broken");
    utimesSync(path, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
    expect(() => store.list("openai")).toThrow(/not valid JSON/);
    expect(() => store.upsert({ backend: "openai", name: "x", kind: "api-key", token: "k" })).toThrow(/not valid JSON/);
    expect(readFileSync(path, "utf8")).toBe("{broken");
  });
});
