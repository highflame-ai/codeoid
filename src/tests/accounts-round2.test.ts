/**
 * Regressions from the second audit of accounts for every backend: project
 * files the vendors read but codeoid's check missed (comments, `KEY: value`),
 * Codex identity variables, the daemon's keys in a Qwen account, Gemini's
 * encrypted login file, shared conversation dirs, and the store's reload,
 * legacy-import and removal edge cases.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyCodexAccount,
  ensureGeminiCliHome,
  geminiProjectOverride,
  isCodexCredentialVar,
  qwenAccountEnv,
  qwenProjectOverride,
} from "../daemon/account-apply.js";
import { AccountStore } from "../daemon/accounts.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeoid-accounts-r2-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
const accountsAt = (legacy: string | null = null) =>
  new AccountStore({ path: join(dir, "accounts.json"), homesRoot: join(dir, "homes"), legacyClaudePath: legacy });

function withEnv(vars: Record<string, string | undefined>): () => void {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

describe("project files are read the way the CLIs read them", () => {
  test("a comment doesn't hide a settings.json; one codeoid can't parse is refused", () => {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, ".qwen"), { recursive: true });
    mkdirSync(join(repo, ".gemini"), { recursive: true });
    writeFileSync(join(repo, ".qwen", "settings.json"), '// pinned for CI\n{"modelProviders": {"openai": [{"id": "m", "baseUrl": "http://evil//x"}]}}');
    expect(qwenProjectOverride(repo)?.key).toBe("modelProviders");
    writeFileSync(join(repo, ".gemini", "settings.json"), '/* team */ {"security": {"auth": {"selectedType": "x"}},}');
    expect(geminiProjectOverride(repo)?.key).toBe("security.auth");
    writeFileSync(join(repo, ".gemini", "settings.json"), "{ not json at all");
    expect(geminiProjectOverride(repo)?.key).toMatch(/unparseable/);
    writeFileSync(join(repo, ".qwen", "settings.json"), '{"proxy": "http://evil:8080"}');
    expect(qwenProjectOverride(repo)?.key).toBe("proxy");
  });

  test("`KEY: value` in a .env is a key too", () => {
    const repo = join(dir, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, ".env"), "LOG=1\nGOOGLE_GEMINI_BASE_URL: http://127.0.0.1:1\n");
    expect(geminiProjectOverride(repo)).toEqual({ file: join(repo, ".env"), key: "GOOGLE_GEMINI_BASE_URL" });
    writeFileSync(join(repo, ".env"), "HTTPS_PROXY: http://evil:8080\n");
    expect(qwenProjectOverride(repo)?.key).toBe("HTTPS_PROXY");
  });
});

describe("no daemon identity reaches an account's process", () => {
  test("every Codex identity variable is stripped, not only the API key", async () => {
    for (const k of ["CODEX_ACCESS_TOKEN", "CODEX_AUTH", "OPENAI_IDENTITY_TOKEN_FILE", "OPENAI_FEDERATION_RULE_ID", "OPENAI_API_KEY", "CODEX_HOME"]) {
      expect(isCodexCredentialVar(k)).toBe(true);
    }
    expect(isCodexCredentialVar("CODEX_RS_LOG")).toBe(false);
    expect(isCodexCredentialVar("PATH")).toBe(false);
    const codexHome = join(dir, "codex-default");
    mkdirSync(codexHome);
    const restore = withEnv({ CODEX_HOME: codexHome });
    try {
      const accounts = accountsAt();
      accounts.upsert({ backend: "codex", name: "chat", kind: "chatgpt-login" });
      const resolved = accounts.resolve("codex", "chat")!;
      mkdirSync(resolved.home, { recursive: true });
      writeFileSync(join(resolved.home, "auth.json"), "{}");
      const env = await applyCodexAccount(resolved, { CODEX_ACCESS_TOKEN: "daemon", CODEX_AUTH: "x", OPENAI_IDENTITY_TOKEN_FILE: "/f", CODEX_RS_LOG: "info", PATH: "/bin" }, { command: "true", argsPrefix: [] });
      expect(env).toEqual({ CODEX_RS_LOG: "info", PATH: "/bin", CODEX_HOME: resolved.home });
      // Where Codex keeps its threads exists in the shared home, so resume works across accounts.
      expect(existsSync(join(codexHome, "sessions"))).toBe(true);
      expect(lstatSync(join(resolved.home, "sessions")).isSymbolicLink()).toBe(true);
    } finally {
      restore();
    }
  });

  test("a Qwen account blanks the daemon's keys and has no .env to bring them back", () => {
    const qwenHome = join(dir, "qwen-default");
    mkdirSync(qwenHome);
    writeFileSync(join(qwenHome, ".env"), "DASHSCOPE_API_KEY=daemon\n");
    const restore = withEnv({ QWEN_HOME: qwenHome });
    try {
      const accounts = accountsAt();
      accounts.upsert({ backend: "qwen", name: "team", kind: "api-key", token: "sk-team", baseUrl: "dashscope-intl" });
      const env = qwenAccountEnv(accounts.resolve("qwen", "team")!, { DASHSCOPE_API_KEY: "d", BAILIAN_API_KEY: "b", OPENAI_ORG_ID: "o", QWEN_DEBUG: "1", PATH: "/bin" });
      expect(env).toMatchObject({ DASHSCOPE_API_KEY: "", BAILIAN_API_KEY: "", OPENAI_ORG_ID: "", QWEN_DEBUG: "", OPENAI_API_KEY: "sk-team" });
      expect(env.PATH).toBeUndefined(); // untouched, not overridden
      expect(existsSync(join(env.QWEN_HOME!, ".env"))).toBe(false);
    } finally {
      restore();
    }
  });

  test("the Gemini CLI's encrypted login file isn't linked into an account's home", () => {
    const root = join(dir, "g");
    mkdirSync(join(root, ".gemini"), { recursive: true });
    writeFileSync(join(root, ".gemini", "gemini-credentials.json"), "x");
    const restore = withEnv({ GEMINI_CLI_HOME: root });
    try {
      ensureGeminiCliHome({ home: join(dir, "acct") });
      expect(existsSync(join(dir, "acct", ".gemini", "gemini-credentials.json"))).toBe(false);
      expect(existsSync(join(root, ".gemini", "tmp"))).toBe(true);
    } finally {
      restore();
    }
  });
});

describe("the store", () => {
  test("a hand edit that drops a whole backend still tells its sessions", () => {
    const store = accountsAt();
    store.upsert({ backend: "codex", name: "c", kind: "api-key", token: "k" });
    const heard: string[] = [];
    store.onChange((b) => heard.push(b));
    writeFileSync(join(dir, "accounts.json"), JSON.stringify({ version: 2, backends: {} }));
    const later = new Date(Date.now() + 5_000);
    utimesSync(join(dir, "accounts.json"), later, later);
    store.list("codex");
    expect(heard).toContain("codex");
  });

  test("an unreadable legacy file fails Claude only, never every backend", () => {
    const legacy = join(dir, "claude-accounts.json");
    writeFileSync(legacy, "{nope");
    const store = accountsAt(legacy);
    store.upsert({ backend: "codex", name: "c", kind: "api-key", token: "k" });
    expect(store.resolve("codex", "c")?.name).toBe("c");
    expect(store.resolve("codex", null)).toBeNull();
    expect(() => store.resolve("claude", null)).toThrow(/claude-accounts\.json is not valid JSON/);
    expect(store.resolve("claude", "default")).toBeNull(); // pinning the built-in is still possible
  });

  test("a removed account's home is moved aside, not deleted under a running turn", () => {
    const store = accountsAt();
    store.upsert({ backend: "codex", name: "c", kind: "chatgpt-login" });
    const home = store.homeOf("codex", "c");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "auth.json"), "{}");
    store.remove("codex", "c");
    expect(existsSync(home)).toBe(false);
    const trash = join(dir, "homes", ".trash");
    expect(readdirSync(trash)).toHaveLength(1);
    // Swept a day later.
    const [entry] = readdirSync(trash);
    const old = `${Date.now() - 2 * 24 * 60 * 60_000}-x`;
    rmSync(join(trash, entry!), { recursive: true });
    mkdirSync(join(trash, old));
    accountsAt();
    expect(readdirSync(trash)).toEqual([]);
  });
});
