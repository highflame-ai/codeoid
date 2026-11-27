import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialProblems, credentialsSchema, secretStoreSchema } from "./schema.js";
import { createSecretStore, credentialEnvName, DirSecretStore, EnvFileSecretStore } from "./store.js";

describe("credential declarations", () => {
  test("kinds and their fields", () => {
    expect(credentialsSchema.safeParse([{ id: "gh-a", kind: "bearer" }, { id: "hf", kind: "header", header: "X-Highflame-APIKey" }, { id: "tok", kind: "env" }, { id: "slack-a", kind: "oauth", server: "slack" }]).success).toBe(true);
    expect(credentialsSchema.safeParse([{ id: "h", kind: "header" }]).success).toBe(false);
    expect(credentialsSchema.safeParse([{ id: "x", kind: "bearer", value: "inline" }]).success).toBe(false);
    expect(credentialsSchema.safeParse([{ id: "Bad", kind: "env" }]).success).toBe(false);
  });

  test("references across the config: declared once, of a kind that fits", () => {
    const ws = (env: Record<string, { secret: string }>, mcpServers: unknown[] = []) => ({ workstreams: { items: [{ id: "w", env, mcpServers: mcpServers as never }] } });
    const msgs = (cfg: Parameters<typeof credentialProblems>[0]) => credentialProblems(cfg).map((p) => p.message).join("\n");
    expect(msgs({ credentials: [{ id: "a", kind: "env" }, { id: "a", kind: "env" }], ...ws({}) })).toMatch(/duplicate credential id "a"/);
    expect(msgs({ credentials: [], ...ws({ GH_TOKEN: { secret: "nope" } }) })).toMatch(/undeclared credential "nope"/);
    expect(msgs({ credentials: [{ id: "b", kind: "bearer" }], ...ws({ GH_TOKEN: { secret: "b" } }) })).toMatch(/is a bearer credential, not env/);
    expect(msgs({ credentials: [{ id: "e", kind: "env" }], ...ws({}, [{ server: "github", credential: "e" }]) })).toMatch(/is an env credential/);
    expect(msgs({ credentials: [{ id: "o", kind: "oauth", server: "slack" }], ...ws({}, [{ server: "github", credential: "o" }]) })).toMatch(/is for server "slack"/);
    expect(credentialProblems({ credentials: [{ id: "o", kind: "oauth", server: "slack" }, { id: "e", kind: "env" }], ...ws({ T: { secret: "e" } }, ["web", { server: "+slack", credential: "o" }]) })).toEqual([]);
  });

  test("the store defaults to env-file", () => {
    expect(secretStoreSchema.parse(undefined)).toEqual({ kind: "env-file" });
  });
});

describe("EnvFileSecretStore", () => {
  test("reads CODEOID_CRED_<ID>, which no agent subprocess ever inherits", () => {
    expect(credentialEnvName("gh-saucam")).toBe("CODEOID_CRED_GH_SAUCAM");
    const s = new EnvFileSecretStore({ CODEOID_CRED_GH_SAUCAM: "ghp_x", CODEOID_CRED_EMPTY: "" });
    expect(s.get("gh-saucam")).toBe("ghp_x");
    expect(s.get("empty")).toBeUndefined();
    expect(s.status("gh-saucam")).toEqual({ set: true, source: "CODEOID_CRED_GH_SAUCAM" });
    expect(s.status("nope")).toEqual({ set: false });
    expect(s.writable).toBe(true);
  });
});

describe("DirSecretStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codeoid-secrets-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("one file per id, trailing newline dropped, read-only", () => {
    writeFileSync(join(dir, "gh-a"), "tok-a\n");
    const s = new DirSecretStore(dir);
    expect(s.get("gh-a")).toBe("tok-a");
    expect(s.get("missing")).toBeUndefined();
    expect(s.get("../etc")).toBeUndefined();
    expect(s.writable).toBe(false);
  });

  test("follows a Kubernetes-style key link; a FIFO never blocks", () => {
    mkdirSync(join(dir, "..data"));
    writeFileSync(join(dir, "..data", "slack"), "xoxb");
    symlinkSync(join(dir, "..data", "slack"), join(dir, "slack"));
    execFileSync("mkfifo", [join(dir, "fifo")]);
    const s = new DirSecretStore(dir);
    expect(s.get("slack")).toBe("xoxb");
    const t = Date.now();
    expect(s.get("fifo")).toBeUndefined();
    expect(Date.now() - t).toBeLessThan(1000);
  });

  test("createSecretStore picks by config", () => {
    expect(createSecretStore({ kind: "dir", path: dir }).kind).toBe("dir");
    expect(createSecretStore(undefined, {}).kind).toBe("env-file");
  });
});
