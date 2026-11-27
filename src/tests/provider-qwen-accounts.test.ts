/**
 * A Qwen session on a named account (accounts.ts): the query runs on the
 * account's key and its own Qwen home with none of the daemon's keys, and the
 * model catalog asks the account's endpoint with the account's key — never
 * the daemon's — without publishing that catalog as the whole backend's.
 *
 * mock.module() lives in its own file so it can't leak into other suites.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Opts = { env?: Record<string, string>; authType?: string; abortController: AbortController };
const queryCalls: Opts[] = [];

mock.module("@qwen-code/sdk", () => ({
  query: (args: { options: Opts }) => {
    queryCalls.push(args.options);
    return {
      [Symbol.asyncIterator]() {
        // Ends when aborted (teardown), like the SDK's stream.
        return {
          next: () =>
            new Promise<IteratorResult<unknown>>((done) => {
              const signal = args.options.abortController.signal;
              if (signal.aborted) done({ done: true, value: undefined });
              else signal.addEventListener("abort", () => done({ done: true, value: undefined }));
            }),
        };
      },
      interrupt: async () => {},
      close: async () => {},
      getAvailableModels: async () => [],
    };
  },
}));

import { AccountStore } from "../daemon/accounts.js";
import { QwenProvider } from "../daemon/providers/qwen/index.js";

let dir: string;
const saved: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;
const asked: Array<{ url: string; auth: string | null }> = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "codeoid-qwen-acct-"));
  for (const k of ["QWEN_HOME", "OPENAI_API_KEY", "DASHSCOPE_API_KEY", "OPENAI_ORG_ID"]) saved[k] = process.env[k];
  const qwenHome = join(dir, "qwen-default");
  mkdirSync(qwenHome);
  writeFileSync(join(qwenHome, ".env"), "DASHSCOPE_API_KEY=daemon-dashscope\n");
  process.env.QWEN_HOME = qwenHome;
  process.env.OPENAI_API_KEY = "sk-daemon-openai";
  process.env.DASHSCOPE_API_KEY = "daemon-dashscope";
  process.env.OPENAI_ORG_ID = "org-daemon";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    asked.push({ url: String(input), auth: headers.get("authorization") });
    return Response.json({ data: [{ id: "qwen3-coder-plus", object: "model" }] });
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("QwenProvider on a named account", () => {
  test("its key and home only; the catalog asks with the account's key and isn't published", async () => {
    const accounts = new AccountStore({ path: join(dir, "accounts.json"), homesRoot: join(dir, "homes"), legacyClaudePath: null });
    accounts.upsert({ backend: "qwen", name: "team", kind: "api-key", token: "sk-team", baseUrl: "https://gw.example/v1" });
    const published: unknown[] = [];
    const provider = new QwenProvider({
      sessionId: "sess-q",
      initialBackingId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "ws",
      store: { audit: () => {} } as never,
      onModels: (m) => published.push(m),
      resolveAccount: () => accounts.resolve("qwen", "team"),
    });
    const run = provider.runTurn({ history: [], userMessage: "hi", workdir: dir, canUseTool: async () => ({ behavior: "allow" as const }) });
    await Bun.sleep(100);
    const env = queryCalls[0]!.env!;
    expect(queryCalls[0]!.authType).toBe("openai");
    expect(env.OPENAI_API_KEY).toBe("sk-team");
    expect(env.OPENAI_BASE_URL).toBe("https://gw.example/v1");
    expect(env.DASHSCOPE_API_KEY).toBe(""); // blanked, and no .env in the account home to fill it back
    expect(env.OPENAI_ORG_ID).toBe("");
    expect(env.QWEN_HOME).toBe(accounts.homeOf("qwen", "team"));
    expect(existsSync(join(env.QWEN_HOME!, ".env"))).toBe(false);
    expect(existsSync(join(process.env.QWEN_HOME!, "projects"))).toBe(true); // shared, so resume works across accounts
    // The catalog: the account's endpoint, the account's key.
    await provider.listModels();
    expect(asked.length).toBeGreaterThan(0);
    for (const a of asked) {
      expect(a.url.startsWith("https://gw.example/v1")).toBe(true);
      expect(a.auth).toBe("Bearer sk-team");
    }
    expect(published).toEqual([]);
    void run;
    await provider.teardown();
  });

  test("extraEnv rides on top, but can't override a daemon key or move the Qwen home", async () => {
    const before = queryCalls.length;
    const provider = new QwenProvider({
      sessionId: "sess-q2",
      initialBackingId: "22222222-2222-4222-8222-222222222222",
      workspaceId: "ws",
      store: { audit: () => {} } as never,
      extraEnv: { LOOP_RUN_ID: "run-q", DASHSCOPE_API_KEY: "evil", QWEN_HOME: "/tmp/evil", OPENAI_ORG_ID: "org-evil" },
    });
    void provider.runTurn({ history: [], userMessage: "hi", workdir: dir, canUseTool: async () => ({ behavior: "allow" as const }) });
    await Bun.sleep(100);
    const env = queryCalls[before]!.env!;
    expect(env.LOOP_RUN_ID).toBe("run-q");
    expect(env.DASHSCOPE_API_KEY).toBe("daemon-dashscope");
    expect(env.QWEN_HOME).toBe(process.env.QWEN_HOME!);
    expect(env.OPENAI_ORG_ID).toBe("org-daemon");
    await provider.teardown();
  });
});
