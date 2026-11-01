/**
 * opencode backend: codeoid's credentials reach opencode through its config,
 * from files (credentials.ts); its data dirs are codeoid's (resolve.ts); the
 * gate refuses the credential files and opencode's database (secret-paths.ts).
 * Offline — the server-level checks against fake-opencode are in
 * provider-opencode.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CodeoidConfig, loadConfig, QWEN_BASE_URL_PRESETS } from "../config.js";
import {
  clearOpencodeCredentials,
  clearStaleOpencodeCredentials,
  fileReference,
  markOpencodeCredentialsInUse,
  OPENAI_COMPATIBLE_PACKAGE,
  OPENCODE_CREDENTIALS_STALE_MS,
  OpencodeCredentialError,
  type OpencodeCredentialInputs,
  opencodeCredentialInputs,
  planOpencodeCredentials,
  writeOpencodeCredentials,
} from "../daemon/providers/opencode/credentials.js";
import { buildOpencodeEnv, opencodeConfig, opencodeServerDirs, opencodeServerShell, opencodeShellEnv, serverEnv } from "../daemon/providers/opencode/policy.js";
import { AccountStore } from "../daemon/accounts.js";
import {
  OPENCODE_CREDENTIALS_PROCESS_DIR,
  OPENCODE_PID_NAMESPACE,
  opencodeCredentialsDir,
  opencodeCredentialsRoot,
  opencodeDataDir,
  opencodeLocationsFile,
  opencodeSecretLocations,
  recordOpencodeDbPath,
} from "../daemon/providers/opencode/resolve.js";
import { registerSecretPaths, secretPathVerdict } from "../daemon/secret-paths.js";
import { createDefaultProviderRegistry } from "../daemon/providers/registry.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";

const DIR = "/srv/codeoid/opencode/codeoid-credentials/4242-0123456789ab";
const NO_OAUTH = "/nonexistent/.qwen/oauth_creds.json";
const ref = (name: string) => `{file:${DIR}/${name}}`;

describe("which of codeoid's credentials reach which opencode provider", () => {
  it("Anthropic, OpenAI and Google keys go to opencode's built-in providers, as file references", () => {
    const plan = planOpencodeCredentials({ env: { ANTHROPIC_API_KEY: "a-key", OPENAI_API_KEY: "o-key", GOOGLE_API_KEY: "g-key" } }, DIR);
    expect(plan.providers).toEqual({
      anthropic: { settings: { apiKey: ref("anthropic.key") } },
      openai: { settings: { apiKey: ref("openai.key") } },
      google: { settings: { apiKey: ref("google.key") } },
    });
    expect(Object.fromEntries(plan.secrets)).toEqual({ "anthropic.key": "a-key", "openai.key": "o-key", "google.key": "g-key" });
    // The config text names files only.
    expect(JSON.stringify(plan.providers)).not.toMatch(/[aog]-key/);
  });

  it("takes GEMINI_API_KEY for Google when GOOGLE_API_KEY isn't set, and ignores empty keys", () => {
    const plan = planOpencodeCredentials({ env: { GEMINI_API_KEY: "gm", ANTHROPIC_API_KEY: "  " } }, DIR);
    expect(Object.keys(plan.providers)).toEqual(["google"]);
    expect(plan.secrets.get("google.key")).toBe("gm");
  });

  it("codeoid's Qwen backend on its key becomes an OpenAI-compatible `qwen` provider, and the key isn't handed to `openai`", () => {
    const plan = planOpencodeCredentials(
      {
        env: { OPENAI_API_KEY: "sk-sp-plan" },
        qwen: { enabled: true, authType: "openai", baseUrl: "bailian-plan-intl", model: "qwen3.8-max" },
        qwenModels: [
          { id: "glm-5.2", name: "GLM 5.2", contextWindow: 200_000 },
          { id: "qwen3.8-max", name: "dup" },
        ],
        qwenOauthCredsPath: NO_OAUTH,
      },
      DIR,
    );
    expect(plan.providers.openai).toBeUndefined();
    expect(plan.providers.qwen).toEqual({
      name: "Qwen (codeoid)",
      package: OPENAI_COMPATIBLE_PACKAGE,
      settings: { baseURL: QWEN_BASE_URL_PRESETS["bailian-plan-intl"], apiKey: ref("qwen.key") },
      models: {
        "qwen3.8-max": { name: "qwen3.8-max", capabilities: { tools: true } },
        "glm-5.2": { name: "GLM 5.2", capabilities: { tools: true }, limit: { context: 200_000 } },
      },
    });
    expect(Object.fromEntries(plan.secrets)).toEqual({ "qwen.key": "sk-sp-plan" });
  });

  it("an auto-detected key path counts; a qwen.ai sign-in, a disabled backend, or OpenAI's own host leave the key to `openai`", () => {
    const oauth = join(mkdtempSync(join(tmpdir(), "codeoid-qwen-")), "oauth_creds.json");
    writeFileSync(oauth, "{}");
    const base = { env: { OPENAI_API_KEY: "k" }, qwenOauthCredsPath: NO_OAUTH };
    const qwen = { baseUrl: "dashscope-intl", model: "qwen-max" };
    expect(Object.keys(planOpencodeCredentials({ ...base, qwen }, DIR).providers)).toEqual(["qwen"]);
    expect(Object.keys(planOpencodeCredentials({ ...base, qwen, qwenOauthCredsPath: oauth }, DIR).providers)).toEqual(["openai"]);
    expect(Object.keys(planOpencodeCredentials({ ...base, qwen: { ...qwen, enabled: false } }, DIR).providers)).toEqual(["openai"]);
    expect(Object.keys(planOpencodeCredentials({ ...base, qwen: { ...qwen, authType: "qwen-oauth" } }, DIR).providers)).toEqual(["openai"]);
    expect(Object.keys(planOpencodeCredentials({ ...base, qwen: { ...qwen, baseUrl: "https://api.openai.com/v1" } }, DIR).providers)).toEqual(["openai"]);
    // No base URL at all: the key is OpenAI's.
    expect(Object.keys(planOpencodeCredentials({ ...base, qwen: { model: "qwen-max" } }, DIR).providers)).toEqual(["openai"]);
    // OPENAI_BASE_URL is the Qwen backend's endpoint when its own isn't set.
    expect(Object.keys(planOpencodeCredentials({ env: { OPENAI_API_KEY: "k", OPENAI_BASE_URL: "https://gw.example/v1" }, qwen: { model: "m" }, qwenOauthCredsPath: NO_OAUTH }, DIR).providers)).toEqual(["qwen"]);
  });

  it("a Qwen key with no model codeoid knows still isn't OpenAI's: nothing is handed over, and it says why", () => {
    const plan = planOpencodeCredentials({ env: { OPENAI_API_KEY: "k" }, qwen: { authType: "openai", baseUrl: "dashscope-intl" } }, DIR);
    expect(plan.providers).toEqual({});
    expect(plan.secrets.size).toBe(0);
    expect(plan.skipped.join()).toContain("providers.qwen.model");
  });

  it("codeoid's OpenAI-compatible endpoints become `oai-<name>` providers, key and header values as files", () => {
    const plan = planOpencodeCredentials(
      {
        env: {},
        endpoints: [
          {
            name: "lab",
            displayName: "Lab GPU",
            baseUrl: "http://10.0.0.5:8000/v1",
            apiKey: "lab-key",
            headers: { "X-Org": "org-secret" },
            models: [{ id: "llama-70b", name: "Llama", contextWindow: 32_000, maxTokens: 4_096 }],
            contextWindow: 8_000,
          },
          { name: "bare", baseUrl: "http://127.0.0.1:9/v1", models: [], defaultModel: "m1" },
          { name: "nomodel", baseUrl: "http://127.0.0.1:10/v1", apiKey: "x", models: [] },
        ],
      },
      DIR,
    );
    expect(plan.providers["oai-lab"]).toEqual({
      name: "Lab GPU",
      package: OPENAI_COMPATIBLE_PACKAGE,
      settings: { baseURL: "http://10.0.0.5:8000/v1", apiKey: ref("oai-lab.key") },
      headers: { "X-Org": ref("oai-lab.header-0") },
      models: { "llama-70b": { name: "Llama", capabilities: { tools: true }, limit: { context: 32_000, output: 4_096 } } },
    });
    expect(plan.providers["oai-bare"]).toEqual({
      name: "bare",
      package: OPENAI_COMPATIBLE_PACKAGE,
      settings: { baseURL: "http://127.0.0.1:9/v1" },
      models: { m1: { name: "m1", capabilities: { tools: true } } },
    });
    expect(plan.providers["oai-nomodel"]).toBeUndefined();
    expect(Object.fromEntries(plan.secrets)).toEqual({ "oai-lab.key": "lab-key", "oai-lab.header-0": "org-secret" });
  });

  it("a value codeoid would put in the config that holds a substitution of its own is refused, with its key", () => {
    const plan = planOpencodeCredentials(
      {
        env: { OPENAI_API_KEY: "k" },
        qwen: { authType: "openai", baseUrl: "dashscope-intl", model: "{file:~/.ssh/id_ed25519}" },
        endpoints: [{ name: "evil", baseUrl: "https://evil.example/v1", apiKey: "e", models: [{ id: "m", name: "{env:OPENCODE_PASSWORD}" }] }],
      },
      DIR,
    );
    expect(plan.providers).toEqual({});
    expect(plan.secrets.size).toBe(0);
    expect(plan.skipped).toHaveLength(2);
  });

  it("refuses a credentials dir a `{file:}` reference can't name faithfully", () => {
    expect(fileReference("/a/b", "k")).toBe("{file:/a/b/k}");
    for (const bad of ["/a}b", '/a"b', "/a\\b", "/a\nb", "relative/dir"]) {
      expect(() => fileReference(bad, "k")).toThrow(OpencodeCredentialError);
    }
  });

  it("reads codeoid's config, the Qwen catalog and the endpoints, surviving one that throws", () => {
    const config = { providers: { qwen: { enabled: true, authType: "openai", baseUrl: "dashscope-intl", model: "qwen-max" } } } as unknown as CodeoidConfig;
    const inputs = opencodeCredentialInputs(config, { OPENAI_API_KEY: "k" }, {
      qwenCatalog: () => [{ value: "default", displayName: "Default" }, { value: "qwen-plus", displayName: "Qwen Plus", contextWindow: 1000 }],
      endpoints: () => {
        throw new Error("unreadable");
      },
    });
    expect(inputs.qwen?.model).toBe("qwen-max");
    expect(inputs.qwenModels).toEqual([{ id: "qwen-plus", name: "Qwen Plus", contextWindow: 1000 }]);
    expect(inputs.endpoints).toEqual([]);
  });
});

describe("a key goes where codeoid's own backends send it", () => {
  it("with a gateway in ANTHROPIC_BASE_URL / OPENAI_BASE_URL, the provider's baseURL is the gateway, not the vendor's API", () => {
    const plan = planOpencodeCredentials(
      {
        env: {
          ANTHROPIC_API_KEY: "gw-a",
          ANTHROPIC_BASE_URL: "https://claude-proxy.corp.example/",
          OPENAI_API_KEY: "gw-o",
          OPENAI_BASE_URL: "https://llm-gw.corp.example/v1",
        },
        qwen: { enabled: false },
      },
      DIR,
    );
    // opencode 2.2.5 posts to `<baseURL>/messages` and `<baseURL>/responses` (seen on the wire).
    expect(plan.providers).toEqual({
      anthropic: { settings: { apiKey: ref("anthropic.key"), baseURL: "https://claude-proxy.corp.example/v1" } },
      openai: { settings: { apiKey: ref("openai.key"), baseURL: "https://llm-gw.corp.example/v1" } },
    });
  });

  it("GEMINI_API_KEY goes to GOOGLE_GEMINI_BASE_URL (the Gemini CLI's); GOOGLE_API_KEY is the Gemini backend's, sent to Google", () => {
    const env = { GEMINI_API_KEY: "gm", GOOGLE_GEMINI_BASE_URL: "http://10.0.0.9:8080" };
    expect(planOpencodeCredentials({ env }, DIR).providers.google).toEqual({ settings: { apiKey: ref("google.key"), baseURL: "http://10.0.0.9:8080/v1beta" } });
    expect(planOpencodeCredentials({ env: { ...env, GOOGLE_API_KEY: "g" } }, DIR).providers.google).toEqual({ settings: { apiKey: ref("google.key") } });
  });

  it("the vendor's own host needs no baseURL; a variable that isn't an http(s) URL, or holds a substitution, withholds the key", () => {
    expect(planOpencodeCredentials({ env: { ANTHROPIC_API_KEY: "a", ANTHROPIC_BASE_URL: "https://api.anthropic.com" } }, DIR).providers.anthropic).toEqual({
      settings: { apiKey: ref("anthropic.key") },
    });
    for (const bad of ["not a url", "file:///etc/passwd", "https://gw.example/{env:OPENCODE_PASSWORD}"]) {
      const plan = planOpencodeCredentials({ env: { ANTHROPIC_API_KEY: "a", ANTHROPIC_BASE_URL: bad } }, DIR);
      expect(plan.providers).toEqual({});
      expect(plan.secrets.size).toBe(0);
      expect(plan.skipped).toHaveLength(1);
    }
  });

  it("a gateway or Qwen endpoint carrying a credential, a query string or a fragment withholds the key: the URL never reaches the server's environment", () => {
    const secrets = ["GW-PASSWORD-1", "GW-QUERY-2", "GW-FRAG-3", "GW-USER-4", "QWEN-PASSWORD-5", "QWEN-QUERY-6"];
    const cases: Array<[string, OpencodeCredentialInputs]> = [
      ["anthropic", { env: { ANTHROPIC_API_KEY: "a", ANTHROPIC_BASE_URL: "https://user:GW-PASSWORD-1@gw.corp.example/" } }],
      ["openai", { env: { OPENAI_API_KEY: "o", OPENAI_BASE_URL: "https://gw.corp.example/v1?api_key=GW-QUERY-2" }, qwen: { enabled: false } }],
      ["google", { env: { GEMINI_API_KEY: "g", GOOGLE_GEMINI_BASE_URL: "https://gw.corp.example/#GW-FRAG-3" } }],
      ["anthropic", { env: { ANTHROPIC_API_KEY: "a", ANTHROPIC_BASE_URL: "https://GW-USER-4@gw.corp.example/" } }],
      ["qwen", { env: {}, qwen: { enabled: true, model: "qwen-max" }, qwenAccount: { token: "q", baseUrl: "https://u:QWEN-PASSWORD-5@dash.example/v1" }, qwenOauthCredsPath: NO_OAUTH }],
      ["qwen", { env: { OPENAI_API_KEY: "q" }, qwen: { enabled: true, authType: "openai", baseUrl: "https://dash.example/v1?key=QWEN-QUERY-6", model: "qwen-max" }, qwenOauthCredsPath: NO_OAUTH }],
    ];
    for (const [id, inputs] of cases) {
      const plan = planOpencodeCredentials(inputs, DIR);
      expect([id, id in plan.providers, plan.secrets.size]).toEqual([id, false, 0]);
      expect(plan.skipped.join()).toMatch(new RegExp(`^${id}: .*carries a credential`));
      const content = serverEnv({ password: "pw", dbPath: "/x.db", configDir: "/c", dataDir: "/d", config: opencodeConfig({}, plan.providers, {}) }).OPENCODE_CONFIG_CONTENT ?? "";
      for (const s of secrets) expect(content).not.toContain(s);
    }
  });

  it("OPENAI_BASE_URL alone doesn't make OPENAI_API_KEY Qwen's (providers.qwen is always there): it stays OpenAI's, with its gateway", () => {
    const env = { OPENAI_API_KEY: "sk-gateway-user", OPENAI_BASE_URL: "https://llm-gw.corp.example/v1" };
    const plan = planOpencodeCredentials({ env, qwen: { enabled: true }, qwenOauthCredsPath: NO_OAUTH }, DIR);
    expect(plan.providers).toEqual({ openai: { settings: { apiKey: ref("openai.key"), baseURL: "https://llm-gw.corp.example/v1" } } });
    expect(plan.skipped).toEqual([]);
    // Qwen set up for a key (a cached catalog counts) still claims it.
    expect(Object.keys(planOpencodeCredentials({ env, qwen: { enabled: true }, qwenModels: [{ id: "qwen-plus" }], qwenOauthCredsPath: NO_OAUTH }, DIR).providers)).toEqual(["qwen"]);
    expect(Object.keys(planOpencodeCredentials({ env, qwen: { enabled: true, authType: "openai" }, qwenOauthCredsPath: NO_OAUTH }, DIR).providers)).toEqual([]);
  });

  it("on the Qwen backend's default account, `qwen` gets the account's key and endpoint, and OPENAI_API_KEY stays OpenAI's", () => {
    const plan = planOpencodeCredentials(
      {
        env: { OPENAI_API_KEY: "sk-proj-openai" },
        qwen: { enabled: true, baseUrl: "bailian-plan-intl", model: "qwen3.8-max" },
        qwenAccount: { token: "sk-acct-qwen", baseUrl: "dashscope-intl" },
        qwenOauthCredsPath: NO_OAUTH,
      },
      DIR,
    );
    expect(plan.providers.qwen?.settings).toEqual({ baseURL: QWEN_BASE_URL_PRESETS["dashscope-intl"], apiKey: ref("qwen.key") });
    expect(plan.providers.openai).toEqual({ settings: { apiKey: ref("openai.key") } });
    expect(Object.fromEntries(plan.secrets)).toEqual({ "qwen.key": "sk-acct-qwen", "openai.key": "sk-proj-openai" });
  });

  it("a Qwen default account that can't be used hands Qwen nothing — never the daemon's key instead", () => {
    const plan = planOpencodeCredentials(
      {
        env: { OPENAI_API_KEY: "sk-proj-openai" },
        qwen: { enabled: true, authType: "openai", baseUrl: "dashscope-intl", model: "qwen-max" },
        qwenAccount: { unusable: "the qwen account \"gone\" no longer exists" },
        qwenOauthCredsPath: NO_OAUTH,
      },
      DIR,
    );
    expect(plan.providers.qwen).toBeUndefined();
    expect(Object.fromEntries(plan.secrets)).toEqual({ "openai.key": "sk-proj-openai" });
    expect(plan.skipped.join()).toContain("no longer exists");
  });

  it("reads the Qwen backend's default account from the account store, and one that throws as unusable", () => {
    const dir = mkdtempSync(join(tmpdir(), "codeoid-oc-acct-"));
    try {
      const accounts = new AccountStore({ path: join(dir, "accounts.json"), homesRoot: join(dir, "homes"), legacyClaudePath: null });
      expect(opencodeCredentialInputs(undefined, {}, { qwenAccount: () => accounts.resolve("qwen", null) }).qwenAccount).toBeNull();
      accounts.upsert({ backend: "qwen", name: "work", kind: "api-key", token: "sk-acct", baseUrl: "dashscope-intl" });
      accounts.setDefault("qwen", "work");
      expect(opencodeCredentialInputs(undefined, {}, { qwenAccount: () => accounts.resolve("qwen", null) }).qwenAccount).toEqual({ token: "sk-acct", baseUrl: "dashscope-intl" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const unusable = opencodeCredentialInputs(undefined, {}, {
      qwenAccount: () => {
        throw new Error('the qwen account "gone" no longer exists');
      },
    }).qwenAccount;
    expect(unusable).toEqual({ unusable: 'the qwen account "gone" no longer exists' });
  });
});

describe("the default model codeoid sets", () => {
  it("is used only as a `provider/model` id: one holding a substitution is dropped from the config", () => {
    expect(opencodeConfig({}, {}, {}, { model: "openrouter/anthropic/claude-x" }).model).toBe("openrouter/anthropic/claude-x");
    for (const bad of ["leak/{file:/home/u/.ssh/id_ed25519}", "x/{env:OPENCODE_PASSWORD}", "{file:/etc/hostname}", "a/b c", 'a/b"c']) {
      expect(opencodeConfig({}, {}, {}, { model: bad }).model).toBeUndefined();
      // The user's own default stands, as with none set.
      expect(opencodeConfig({}, {}, { model: "anthropic/x" }, { model: bad }).model).toBe("anthropic/x");
    }
  });
});

describe("the credential files", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "codeoid-oc-creds-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** A daemon process's dir in a credentials root, as `OPENCODE_CREDENTIALS_PROCESS_DIR` names it (this pid namespace by default). */
  const processDir = (pid: number, nonce = "0123456789ab", namespace = OPENCODE_PID_NAMESPACE) => `${namespace}-${pid}-${nonce}`;
  /** The pid of a process that has exited. */
  const deadPid = () => Bun.spawnSync([process.execPath, "-e", ""]).pid;

  it("are 0600 in a 0700 dir (its root 0700 too), and one codeoid no longer has is removed", () => {
    const dir = join(root, "codeoid-credentials", processDir(process.pid));
    writeOpencodeCredentials(dir, new Map([["anthropic.key", "a"], ["openai.key", "o"]]));
    for (const d of [dir, join(root, "codeoid-credentials")]) expect(statSync(d).mode & 0o777).toBe(0o700);
    for (const f of ["anthropic.key", "openai.key"]) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, "anthropic.key"), "utf8")).toBe("a");
    writeOpencodeCredentials(dir, new Map([["openai.key", "o2"]]));
    expect(existsSync(join(dir, "anthropic.key"))).toBe(false);
    expect(readFileSync(join(dir, "openai.key"), "utf8")).toBe("o2");
    // Only names codeoid writes.
    expect(() => writeOpencodeCredentials(dir, new Map([["../escape.key", "x"]]))).toThrow(OpencodeCredentialError);
  });

  it("live in this daemon's own dir of a `codeoid-credentials` root beside the database, never the database dir's `config/credentials`", () => {
    expect(opencodeCredentialsRoot("/x/opencode/opencode.db")).toBe("/x/opencode/codeoid-credentials");
    expect(opencodeCredentialsDir("/x/opencode/opencode.db")).toBe(join("/x/opencode/codeoid-credentials", OPENCODE_CREDENTIALS_PROCESS_DIR));
    expect(OPENCODE_CREDENTIALS_PROCESS_DIR).toMatch(new RegExp(`^${OPENCODE_PID_NAMESPACE}-${process.pid}-[0-9a-f]{12}$`));
    expect(OPENCODE_PID_NAMESPACE).toMatch(/^[0-9a-f]{12}$/);
    const config = { dbPath: join(root, "codeoid.db"), providers: { opencode: { enabled: true, command: "opencode", dbPath: join(root, "moved", "opencode.db") } } } as unknown as CodeoidConfig;
    const { dirs, files } = opencodeSecretLocations(config);
    expect(files).toEqual([join(root, "moved", "opencode.db"), join(root, "opencode", "opencode.db")]);
    expect(dirs).toEqual([join(root, "moved", "codeoid-credentials"), join(root, "opencode", "codeoid-credentials")]);
  });

  it("cover every location a server of this config ran with, after the database moves on, recorded once each beside codeoid's database", () => {
    const config = (dbPath: string) => ({ dbPath: join(root, "codeoid.db"), providers: { opencode: { enabled: true, command: "opencode", dbPath } } }) as unknown as CodeoidConfig;
    const file = opencodeLocationsFile(config(join(root, "A", "opencode.db")));
    expect(file).toBe(join(root, "opencode-locations.jsonl"));
    const odd = join(root, "x\ny", "opencode.db");
    for (const db of [join(root, "A", "opencode.db"), odd, join(root, "A", "opencode.db")]) recordOpencodeDbPath(file, db);
    writeFileSync(file, `${readFileSync(file, "utf8")}"rel/opencode.db"\n{"torn`);
    recordOpencodeDbPath(file, join(root, "B", "opencode.db"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const { files, dirs } = opencodeSecretLocations(config(join(root, "C", "opencode.db")));
    expect(files).toEqual([join(root, "C", "opencode.db"), join(root, "opencode", "opencode.db"), join(root, "A", "opencode.db"), odd, join(root, "B", "opencode.db")]);
    expect(dirs).toContain(join(root, "x\ny", "codeoid-credentials"));
  });

  it("at a daemon's start, a gone daemon's are cleared, at every location; a running daemon's, and this one's, stay", () => {
    const config = { dbPath: join(root, "codeoid.db"), providers: { opencode: { enabled: true, command: "opencode", dbPath: join(root, "moved", "opencode.db") } } } as unknown as CodeoidConfig;
    const { dirs } = opencodeSecretLocations(config);
    const [moved, fallback] = dirs as [string, string];
    const gone = join(fallback, processDir(deadPid()));
    // Another daemon that runs: here, this test's own process under another name.
    const running = join(fallback, processDir(process.ppid));
    // A daemon that had this pid before this one.
    const earlier = join(moved, processDir(4242, "fedcba987654"));
    const self = processDir(4242, "0123456789ab");
    const mine = join(moved, self);
    for (const d of [gone, running, earlier, mine]) writeOpencodeCredentials(d, new Map([["anthropic.key", "k"]]));
    clearStaleOpencodeCredentials([...dirs, join(root, "missing", "codeoid-credentials")], { self });
    expect([existsSync(gone), existsSync(earlier)]).toEqual([false, false]);
    expect(readdirSync(running)).toEqual(["anthropic.key"]);
    expect(readdirSync(mine)).toEqual(["anthropic.key"]);
    // Liveness is the process's, not a guess from the name.
    clearStaleOpencodeCredentials([fallback], { self, alive: () => false });
    expect(existsSync(running)).toBe(false);
  });

  it("a daemon in another pid namespace or on another host keeps its dir while it marks it, whatever its pid; unmarked for a day, it's gone", () => {
    const creds = join(root, "codeoid-credentials");
    const self = processDir(1, "000000000000");
    // A container's daemon: pid 1 like this one, and a pid not running here.
    const samePid = join(creds, processDir(1, "aaaaaaaaaaaa", "0f0f0f0f0f0f"));
    const unseenPid = join(creds, processDir(deadPid(), "bbbbbbbbbbbb", "0f0f0f0f0f0f"));
    // One from a build that didn't name its namespace.
    const unnamed = join(creds, `${deadPid()}-cccccccccccc`);
    for (const d of [samePid, unseenPid, unnamed]) writeOpencodeCredentials(d, new Map([["anthropic.key", "k"]]));
    const now = Date.now();
    clearStaleOpencodeCredentials([creds], { self, alive: () => false, now });
    for (const d of [samePid, unseenPid, unnamed]) expect(readdirSync(d)).toEqual(["anthropic.key"]);
    // Last marked just inside the window: kept; past it: gone.
    const at = (ms: number) => (now - ms) / 1000;
    utimesSync(samePid, at(OPENCODE_CREDENTIALS_STALE_MS - 60_000), at(OPENCODE_CREDENTIALS_STALE_MS - 60_000));
    for (const d of [unseenPid, unnamed]) utimesSync(d, at(OPENCODE_CREDENTIALS_STALE_MS + 60_000), at(OPENCODE_CREDENTIALS_STALE_MS + 60_000));
    clearStaleOpencodeCredentials([creds], { self, alive: () => true, now });
    expect(readdirSync(samePid)).toEqual(["anthropic.key"]);
    expect([existsSync(unseenPid), existsSync(unnamed)]).toEqual([false, false]);
  });

  it("are marked in use while this daemon holds them, and no longer once cleared", () => {
    const mine = join(root, "codeoid-credentials", processDir(process.pid, "dddddddddddd"));
    writeOpencodeCredentials(mine, new Map([["anthropic.key", "k"]]));
    const old = (Date.now() - 2 * OPENCODE_CREDENTIALS_STALE_MS) / 1000;
    utimesSync(mine, old, old);
    const now = Date.now();
    markOpencodeCredentialsInUse(now);
    expect(Math.abs(statSync(mine).mtimeMs - now)).toBeLessThan(2000);
    // As another namespace's daemon sees it: in use, kept.
    clearStaleOpencodeCredentials([join(root, "codeoid-credentials")], { self: processDir(1, "000000000000", "0f0f0f0f0f0f"), now });
    expect(readdirSync(mine)).toEqual(["anthropic.key"]);
    clearOpencodeCredentials([mine]);
    markOpencodeCredentialsInUse();
    expect(existsSync(mine)).toBe(false);
  });

  // The real thing: the start-time clear run as pid 1 of a new pid namespace,
  // where this process's pid doesn't exist (a container sharing the config).
  const unshare = Bun.which("unshare");
  const canUnshare = unshare !== null && Bun.spawnSync([unshare, "-U", "-r", "-p", "-f", "--mount-proc", "true"]).exitCode === 0;
  it.skipIf(!canUnshare)("a daemon starting in another pid namespace leaves this running daemon's dir", () => {
    const dbPath = join(root, "opencode", "opencode.db");
    const live = opencodeCredentialsDir(dbPath);
    writeOpencodeCredentials(live, new Map([["anthropic.key", "sk-ant-live"]]));
    const script = join(root, "second-daemon.ts");
    const credentials = join(import.meta.dir, "..", "daemon", "providers", "opencode", "credentials.ts");
    writeFileSync(
      script,
      `import { clearStaleOpencodeCredentials } from ${JSON.stringify(credentials)};\nclearStaleOpencodeCredentials([${JSON.stringify(opencodeCredentialsRoot(dbPath))}]);\nconsole.log(process.pid);\n`,
    );
    const r = Bun.spawnSync([unshare as string, "-U", "-r", "-p", "-f", "--mount-proc", process.execPath, script]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString().trim()).toBe("1");
    expect(readFileSync(join(live, "anthropic.key"), "utf8")).toBe("sk-ant-live");
  });

  it("are the only files removed: a user's files beside them, or in a dir that isn't a daemon's, stay; nothing is recursed into or followed", () => {
    const creds = join(root, "codeoid-credentials");
    const gone = join(creds, processDir(deadPid()));
    writeOpencodeCredentials(gone, new Map([["anthropic.key", "k"], ["oai-lab.header-0", "h"]]));
    mkdirSync(join(gone, "anthropic.key.d"));
    writeFileSync(join(gone, "production.key"), "keep");
    mkdirSync(join(gone, "prod"));
    writeFileSync(join(gone, "prod", "openai.key"), "keep");
    mkdirSync(join(creds, "notes"));
    writeFileSync(join(creds, "notes", "anthropic.key"), "keep");
    writeFileSync(join(creds, "openai.key"), "keep");
    clearStaleOpencodeCredentials([creds], { self: processDir(1, "000000000000") });
    expect(readdirSync(gone).sort()).toEqual(["anthropic.key.d", "prod", "production.key"]);
    expect(readFileSync(join(gone, "prod", "openai.key"), "utf8")).toBe("keep");
    expect(readFileSync(join(creds, "notes", "anthropic.key"), "utf8")).toBe("keep");
    expect(readFileSync(join(creds, "openai.key"), "utf8")).toBe("keep");
    writeOpencodeCredentials(gone, new Map([["qwen.key", "q"]]));
    expect(readdirSync(gone).sort()).toEqual(["anthropic.key.d", "prod", "production.key", "qwen.key"]);

    // A symlinked root, or a symlinked daemon dir, is never followed.
    const precious = join(root, "precious");
    mkdirSync(precious);
    writeFileSync(join(precious, "openai.key"), "keep");
    const linkedRoot = join(root, "linked", "codeoid-credentials");
    mkdirSync(join(root, "linked"));
    symlinkSync(precious, linkedRoot);
    clearStaleOpencodeCredentials([linkedRoot], { alive: () => false });
    expect(() => writeOpencodeCredentials(join(linkedRoot, processDir(process.pid)), new Map([["openai.key", "o"]]))).toThrow(OpencodeCredentialError);
    const linkedDir = join(creds, processDir(deadPid()));
    symlinkSync(precious, linkedDir);
    clearStaleOpencodeCredentials([creds], { alive: () => false });
    clearOpencodeCredentials([linkedDir]);
    expect(() => writeOpencodeCredentials(linkedDir, new Map([["openai.key", "o"]]))).toThrow(OpencodeCredentialError);
    expect(readdirSync(precious)).toEqual(["openai.key"]);
  });

  it("a database kept in a project leaves the project's own config/credentials alone, at start and to the gate", () => {
    const project = join(root, "rails-app");
    const own = join(project, "config", "credentials");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "production.key"), "rails-master-key");
    writeFileSync(join(own, "openai.key"), "theirs");
    const config = { dbPath: join(root, "codeoid.db"), providers: { opencode: { enabled: false, command: "opencode", dbPath: join(project, "opencode.db") } } } as unknown as CodeoidConfig;
    const locations = opencodeSecretLocations(config);
    clearStaleOpencodeCredentials(locations.dirs, { alive: () => false });
    expect(readdirSync(own).sort()).toEqual(["openai.key", "production.key"]);
    const undo = registerSecretPaths(locations);
    try {
      expect(secretPathVerdict("Read", { file_path: join(own, "production.key") }, { workdir: project, configDir: join(root, "cfg") })).toBeNull();
    } finally {
      undo();
    }
  });

  it("a second `codeoid start` whose port is taken leaves the running daemon's key files", async () => {
    const cfgHome = join(root, "cfg");
    const dbPath = join(cfgHome, "codeoid", "opencode", "opencode.db");
    // The running daemon is this process: its server's key files.
    const live = opencodeCredentialsDir(dbPath);
    writeOpencodeCredentials(live, new Map([["anthropic.key", "sk-ant-live"]]));
    const taken = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("first daemon") });
    try {
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "cli.ts"), "start", "--local", "--no-telegram", "--no-web", "--port", String(taken.port)], {
        env: { PATH: process.env.PATH ?? "", HOME: join(root, "home"), XDG_CONFIG_HOME: cfgHome, CODEOID_TRANSCRIPT_DIR: join(root, "t") },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await proc.exited).toBe(1);
      expect(readFileSync(join(live, "anthropic.key"), "utf8")).toBe("sk-ant-live");
    } finally {
      taken.stop(true);
    }
  }, 60_000);
});

describe("the injected config: codeoid's providers and model over the user's", () => {
  it("a provider codeoid configures replaces the user's of that id; the user's others stand", () => {
    const config = opencodeConfig(
      {},
      { anthropic: { settings: { apiKey: "{file:/c/anthropic.key}" } } },
      {
        model: "openrouter/x",
        providers: { anthropic: { settings: { apiKey: "theirs" }, models: { custom: {} } }, openrouter: { settings: { apiKey: "{file:~/.or}" } } },
        provider: { anthropic: { options: { apiKey: "legacy" } }, ollama: { name: "Ollama" } },
      },
    );
    expect(config.providers).toEqual({ anthropic: { settings: { apiKey: "{file:/c/anthropic.key}" } }, openrouter: { settings: { apiKey: "{file:~/.or}" } } });
    expect(config.provider).toEqual({ ollama: { name: "Ollama" } });
    expect(config.model).toBe("openrouter/x");
    expect(opencodeConfig({}, {}, { model: "openrouter/x" }, { model: "qwen/qwen3.8-max" }).model).toBe("qwen/qwen3.8-max");
    expect(opencodeConfig({}, { anthropic: {} }, { provider: { anthropic: {} } }).provider).toBeUndefined();
  });
});

describe("opencode's data dirs", () => {
  it("default beside codeoid's transcript dir, with their own override", () => {
    expect(opencodeDataDir({ transcriptDir: "/data/codeoid/transcripts" } as CodeoidConfig)).toBe("/data/codeoid/opencode");
    expect(
      opencodeDataDir({ transcriptDir: "/t/x", providers: { opencode: { enabled: true, command: "opencode", dataDir: "/elsewhere/oc" } } } as unknown as CodeoidConfig),
    ).toBe("/elsewhere/oc");
    expect(opencodeServerDirs("/d")).toEqual({ XDG_DATA_HOME: "/d/data", XDG_STATE_HOME: "/d/state", XDG_CACHE_HOME: "/d/cache", TMPDIR: "/d/tmp" });
  });

  it("the server's temp files are codeoid's too; a session's shell keeps the user's TMPDIR", () => {
    // opencode's tmp is `$TMPDIR/opencode`, made at every start.
    const env = { ...buildOpencodeEnv({ TMPDIR: "/tmp", HOME: "/h" }), ...serverEnv({ password: "pw", dbPath: "/x.db", configDir: "/c", dataDir: "/d", config: {} }) };
    expect(env.TMPDIR).toBe("/d/tmp");
    expect(opencodeShellEnv({ TMPDIR: "/tmp", HOME: "/h" }).TMPDIR).toBe("/tmp");
  });

  it("the server runs lines with bash whatever the user's login shell; a session's shell keeps the user's $SHELL (round-16 audit)", () => {
    // opencode takes the server's $SHELL for any shell but fish and nu; codeoid judges lines as bash.
    const user = { SHELL: "/usr/bin/pwsh", PATH: process.env.PATH, HOME: "/h" };
    const env = { ...buildOpencodeEnv(user), ...serverEnv({ password: "pw", dbPath: "/x.db", configDir: "/c", dataDir: "/d", config: {}, shell: opencodeServerShell(user.PATH) }) };
    expect(env.SHELL).toBe(Bun.which("bash", { PATH: user.PATH ?? "" })!);
    expect(env.SHELL).toEndWith("/bash");
    // Without a shell given, the daemon's PATH's bash.
    expect(serverEnv({ password: "pw", dbPath: "/x.db", configDir: "/c", dataDir: "/d", config: {} }).SHELL).toBe(env.SHELL!);
    // No bash on the server's PATH: opencode's own fallback.
    expect(opencodeServerShell("/nonexistent")).toBe("/bin/sh");
    expect(opencodeShellEnv(user).SHELL).toBe("/usr/bin/pwsh");
  });

  it("the server's shell is never a relative path: a relative PATH entry names another file in each directory a line runs in (round-17 audit)", () => {
    const root = mkdtempSync(join(tmpdir(), "oc-shell-"));
    mkdirSync(join(root, "bin"));
    for (const f of [join(root, "bin", "bash"), join(root, "bash")]) {
      writeFileSync(f, "#!/bin/sh\nexit 0\n");
      chmodSync(f, 0o755);
    }
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const system = opencodeServerShell(process.env.PATH);
      for (const path of [`bin:${process.env.PATH}`, `.:${process.env.PATH}`, `:${process.env.PATH}`]) expect(opencodeServerShell(path)).toBe(system);
      expect(opencodeServerShell("bin")).toBe("/bin/sh");
      expect(opencodeServerShell(".")).toBe("/bin/sh");
      // An absolute entry is taken as it is.
      expect(opencodeServerShell(`${join(root, "bin")}:${process.env.PATH}`)).toBe(join(root, "bin", "bash"));
    } finally {
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe("loadConfig resolves providers.opencode.dataDir", () => {
    const saved: Record<string, string | undefined> = {};
    const keys = ["XDG_CONFIG_HOME", "CODEOID_TRANSCRIPT_DIR"];
    let cfgHome: string;
    beforeEach(() => {
      for (const k of keys) saved[k] = process.env[k];
      cfgHome = mkdtempSync(join(tmpdir(), "codeoid-oc-cfg-"));
      process.env.XDG_CONFIG_HOME = cfgHome;
      delete process.env.CODEOID_TRANSCRIPT_DIR;
    });
    afterEach(() => {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      rmSync(cfgHome, { recursive: true, force: true });
    });

    it("beside the transcript dir by default (CODEOID_TRANSCRIPT_DIR moves it), relative to the config dir when set", () => {
      const configDir = join(cfgHome, "codeoid");
      expect(loadConfig().providers?.opencode?.dataDir).toBe(join(configDir, "opencode"));
      process.env.CODEOID_TRANSCRIPT_DIR = "/var/lib/codeoid/transcripts";
      expect(loadConfig().providers?.opencode?.dataDir).toBe("/var/lib/codeoid/opencode");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, "config.json"), JSON.stringify({ providers: { opencode: { dataDir: "oc-data", model: "qwen/qwen3.8-max" } } }));
      const loaded = loadConfig().providers?.opencode;
      expect(loaded?.dataDir).toBe(join(configDir, "oc-data"));
      expect(loaded?.model).toBe("qwen/qwen3.8-max");
    });

    it("refuses a default model that isn't a `provider/model` id opencode would read as written", () => {
      const configDir = join(cfgHome, "codeoid");
      mkdirSync(configDir, { recursive: true });
      for (const model of ["x/{file:~/.codeoid/.env}", "x/{env:OPENCODE_PASSWORD}", "no-provider"]) {
        writeFileSync(join(configDir, "config.json"), JSON.stringify({ providers: { opencode: { model } } }));
        expect(() => loadConfig()).toThrow(/provider\/model/);
      }
    });
  });
});

describe("the gate refuses opencode's credential files and database", () => {
  it("a file tool naming one is denied; a search above them asks; undone, they're ordinary files", () => {
    const root = mkdtempSync(join(tmpdir(), "codeoid-oc-gate-"));
    const db = join(root, "opencode", "opencode.db");
    const creds = opencodeCredentialsDir(db);
    mkdirSync(creds, { recursive: true });
    writeFileSync(join(creds, "qwen.key"), "k");
    const opts = { workdir: join(root, "work"), configDir: join(root, "codeoid-config") };
    const undo = registerSecretPaths(opencodeSecretLocations({ providers: { opencode: { enabled: true, command: "opencode", dbPath: db } } } as unknown as CodeoidConfig));
    try {
      expect(secretPathVerdict("Read", { file_path: join(creds, "qwen.key") }, opts)?.action).toBe("deny");
      // Another daemon's, sharing the database.
      expect(secretPathVerdict("Read", { file_path: join(opencodeCredentialsRoot(db), "4242-0123456789ab", "openai.key") }, opts)?.action).toBe("deny");
      expect(secretPathVerdict("read", { filePath: join(creds, "anything-new") }, opts)?.action).toBe("deny");
      expect(secretPathVerdict("Read", { file_path: `${db}-wal` }, opts)?.action).toBe("deny");
      expect(secretPathVerdict("Read", { file_path: db }, opts)?.action).toBe("deny");
      expect(secretPathVerdict("Grep", { pattern: "sk-", path: root }, opts)?.action).toBe("ask");
      expect(secretPathVerdict("Read", { file_path: join(root, "opencode", "data", "log.txt") }, opts)).toBeNull();
    } finally {
      undo();
      rmSync(root, { recursive: true, force: true });
    }
    expect(secretPathVerdict("Read", { file_path: join(creds, "qwen.key") }, opts)).toBeNull();
  });

  it("a registry registers them for as long as it lives: disposed (a manager that built it drained), they're dropped", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeoid-oc-gate-"));
    const db = join(root, "opencode", "opencode.db");
    const key = join(opencodeCredentialsDir(db), "qwen.key");
    const opts = { workdir: join(root, "work"), configDir: join(root, "codeoid-config") };
    const config = {
      dbPath: join(root, "codeoid.db"),
      transcriptDir: join(root, "transcripts"),
      providers: { opencode: { enabled: false, dbPath: db } },
    } as unknown as CodeoidConfig;
    try {
      const registry = createDefaultProviderRegistry(config, {});
      expect(secretPathVerdict("Read", { file_path: key }, opts)?.action).toBe("deny");
      registry.dispose();
      expect(secretPathVerdict("Read", { file_path: key }, opts)).toBeNull();
      // A manager's own registry lives until the manager drains; one handed to it stays the caller's.
      const store = new Store(join(root, "codeoid.db"));
      const manager = new SessionManager(store, new TranscriptStore(join(root, "transcripts")), undefined, undefined, undefined, { config });
      expect(secretPathVerdict("Read", { file_path: key }, opts)?.action).toBe("deny");
      await manager.drain(100);
      expect(secretPathVerdict("Read", { file_path: key }, opts)).toBeNull();
      const handed = createDefaultProviderRegistry(config, {});
      await new SessionManager(store, new TranscriptStore(join(root, "transcripts")), undefined, undefined, undefined, { config, providers: handed }).drain(100);
      expect(secretPathVerdict("Read", { file_path: key }, opts)?.action).toBe("deny");
      handed.dispose();
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
