import { beforeAll, describe, expect, test } from "bun:test";
import { loadShellParser } from "../shell/parse.js";
import { findSecrets, isPlaceholder } from "./detect.js";
import { isCredentialFile } from "./files.js";
import { Fingerprinter } from "./fingerprint.js";
import { KnownSecrets } from "./known.js";
import { NOT_CHECKED, Scrubber, StreamScrubber, TOO_LARGE } from "./scrub.js";
import { toolVerdict } from "./verdict.js";

// Made-up credentials of the right shape, split so this file holds no contiguous token a push scanner takes for real.
const GHP = "ghp_" + "Zx9Qw3Er5Ty7Ui1Op2As4Df6Gh8Jk0Lz3Xc5V";
const SLACK = "xoxb-" + "1234567890123-1234567890123-" + "abcdefghijABCDEFGHIJ1234";
const AWS_ID = "AKIA" + "IOSFODNN7EXAMPLE";
const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" + ".eyJzdWIiOiIxMjM0NTY3ODkwIn0" + ".dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
const PEM = "-----BEGIN OPENSSH PRIVATE " + "KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----";

const fp = new Fingerprinter(Buffer.alloc(32, 7));
const kinds = (text: string) => (findSecrets(text) ?? []).map((s) => `${s.kind}:${text.slice(s.start, s.end)}`);

describe("detect", () => {
  test.each([
    [`token ${GHP} done`, [`github-token:${GHP}`]],
    [`SLACK=${SLACK}`, [`slack-token:${SLACK}`]],
    [`key ${AWS_ID}`, [`aws-key-id:${AWS_ID}`]],
    [`auth=${JWT}`, [`jwt:${JWT}`]],
    ["export GITHUB_TOKEN=4f1c0e7d9b2a", ["credential:4f1c0e7d9b2a"]],
    ["DATABASE_URL=postgres://app:s3cr3t-pw@db.internal:5432/app", ["password:s3cr3t-pw"]],
    ['curl -H "Authorization: Bearer 8f2d0c1e9b7a4f6e8d2c" x', ["bearer-token:8f2d0c1e9b7a4f6e8d2c"]],
    ["curl -u admin:hunter2 https://example.com", ["password:hunter2"]],
    ["host=db user=app password=hunter22 dbname=app", ["password:hunter22"]],
    ["docker login -u me --password hunter2xyz r.io", ["password:hunter2xyz"]],
    ['{"client_secret": "a8f3kq0z7x1m", "client_id": "app"}', ["credential:a8f3kq0z7x1m"]],
    ["database:\n  password: hunter2\n  host: db", ["credential:hunter2"]],
  ])("finds %s", (text, expected) => {
    expect(kinds(text)).toEqual(expected);
  });

  test.each([
    "    token: String,",
    "OPENAI_API_KEY=${OPENAI_API_KEY}",
    "commit 3f9a2c1b4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a",
    "max_tokens: 4096",
    "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    '{"password": "<password>"}',
    "TOKEN=‹credential:gh-saucam›",
    "the --password flag",
    "see https://example.com/docs?page=2",
    "uuid 3e4f2b1a-9c8d-4e7f-a6b5-1c2d3e4f5a6b",
  ])("leaves %s", (text) => {
    expect(kinds(text)).toEqual([]);
  });

  test("a private key's body, its armour kept", () => {
    const [s] = findSecrets(PEM)!;
    expect(PEM.slice(0, s!.start)).toEndWith("PRIVATE KEY-----");
    expect(PEM.slice(s!.end)).toStartWith("-----END");
  });

  test("placeholders", () => {
    for (const p of ["$TOKEN", "${{ secrets.X }}", "<password>", "changeme", "xxxx", "‹secret:jwt:12345678›"]) expect(isPlaceholder(p)).toBe(true);
    expect(isPlaceholder("hunter2xyz")).toBe(false);
  });
});

describe("scrub", () => {
  const known = new KnownSecrets();
  known.register("test", () => [
    { label: "gh-saucam", value: "s3cr3t-value-1234" },
    { label: "short", value: "abc" },
  ]);
  const detected: string[] = [];
  const scrubber = new Scrubber({ known, fingerprint: fp, onDetected: (d) => detected.push(d.kind) });

  test("a known value becomes a credential reference, in every form it is written in", () => {
    const b64 = Buffer.from(":s3cr3t-value-1234").toString("base64").replace(/=+$/, "");
    const r = scrubber.scrub(`echo s3cr3t-value-1234; curl -H 'Authorization: Basic ${b64}'; q=${encodeURIComponent("s3cr3t-value-1234")}`);
    expect(r.text).not.toContain("s3cr3t-value-1234");
    expect(r.text).not.toContain(b64);
    expect(r.text).toContain("‹credential:gh-saucam›");
    expect(r.changed).toBe(true);
  });

  test("a value under 8 characters is never matched", () => {
    expect(scrubber.scrub("abc is a word").text).toBe("abc is a word");
  });

  test("a detected secret becomes a fingerprinted reference, the same for the same value", () => {
    const a = scrubber.scrub(`one ${GHP}`).text;
    const b = scrubber.scrub(`two ${GHP}`).text;
    const ref = a.slice(4);
    expect(ref).toMatch(/^‹secret:github-token:[0-9a-f]{8}›$/);
    expect(b).toBe(`two ${ref}`);
    expect(detected).toContain("github-token");
  });

  test("scrubbing is idempotent", () => {
    const once = scrubber.scrub(`DB_PASSWORD=hunter2xyz and ${GHP} and s3cr3t-value-1234`).text;
    expect(scrubber.scrub(once).text).toBe(once);
  });

  test("a value inside a JSON input is scrubbed, structure kept", () => {
    const r = scrubber.scrubValue({ command: `echo ${GHP}`, n: 3, list: ["s3cr3t-value-1234"] });
    expect(r.changed).toBe(true);
    expect(r.value.n).toBe(3);
    expect(JSON.stringify(r.value)).not.toContain(GHP);
  });

  test("past its budget, a text isn't stored", () => {
    const slow = new Scrubber({ known, fingerprint: fp, budgetMs: -1 });
    expect(slow.scrub("anything at all").text).toBe(NOT_CHECKED);
  });

  test("too large to check isn't stored", () => {
    expect(scrubber.scrub("x".repeat(8 * 1024 * 1024 + 1)).text).toBe(TOO_LARGE);
  });
});

describe("stream", () => {
  const known = new KnownSecrets();
  known.register("test", () => [{ label: "gh-saucam", value: "s3cr3t-value-1234" }]);
  const scrubber = new Scrubber({ known, fingerprint: fp });

  /** Feed `text` in pieces of `n` characters; return what was sent. */
  function stream(text: string, n: number): string {
    const s = new StreamScrubber(scrubber);
    let out = "";
    for (let i = 0; i < text.length; i += n) out += s.push(text.slice(i, i + n));
    return out + s.flush();
  }

  test.each([1, 2, 3, 5, 7, 13])("a secret split across pieces of %i is never sent", (n) => {
    const text = `Here is the token ${GHP} and the key s3cr3t-value-1234, Authorization: Bearer 8f2d0c1e9b7a4f6e8d2c and password: "correct horse 9".\n${PEM}\nthe end`;
    const out = stream(text, n);
    for (const secret of [GHP, "s3cr3t-value-1234", "8f2d0c1e9b7a4f6e8d2c", "correct horse 9", "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("the end");
  });

  test("plain prose streams as it comes", () => {
    const s = new StreamScrubber(scrubber);
    expect(s.push("Hello there ")).toBe("Hello there ");
    expect(s.push("wor")).toBe("");
    expect(s.push("ld ")).toBe("world ");
  });
});

describe("verdict", () => {
  beforeAll(async () => {
    await loadShellParser();
  });
  const v = (command: string) => toolVerdict("Bash", { command }, { cwd: "/w" });

  test.each([
    "gh auth token",
    "x=$(gh auth token); echo $x",
    "bash -c 'gh auth token'",
    "sudo printenv",
    "env",
    "aws --profile prod configure get aws_secret_access_key",
    "kubectl -n x get secret db -o yaml",
    "op read op://vault/item/field",
    "security find-generic-password -s x -w",
    "cat .env",
    "cat ~/.aws/credentials",
    "grep KEY config/.env.local",
    "head -5 < .env",
    "terraform output -json",
  ])("withholds the output of %s", (command) => {
    expect(v(command)).toBe("withhold-output");
  });

  test.each(["git status", "npm test", "env FOO=1 npm test", "cat .env.example", "ls -la ~/.ssh", "echo token", "gh pr list"])("keeps %s", (command) => {
    expect(v(command)).toBe("keep");
  });

  test("a write of a credential file", () => {
    expect(v("echo KEY=abc > .env")).toBe("withhold-written");
    expect(toolVerdict("Write", { file_path: "/w/.env", content: "KEY=abc" }, { cwd: "/w" })).toBe("withhold-written");
    expect(toolVerdict("Read", { file_path: "/w/.env" }, { cwd: "/w" })).toBe("withhold-output");
    expect(toolVerdict("Read", { file_path: "/w/src/a.ts" }, { cwd: "/w" })).toBe("keep");
  });

  test("the user's drop list", () => {
    expect(toolVerdict("Bash", { command: "my-vault dump --all" }, { cwd: "/w", dropCommands: ["my-vault dump"] })).toBe("drop");
  });

  test("credential files", () => {
    expect(isCredentialFile("id_ed25519", "/home/u/.ssh")).toBe(true);
    expect(isCredentialFile("id_ed25519.pub", "/home/u/.ssh")).toBe(false);
    expect(isCredentialFile("~/.kube/config", "/w")).toBe(true);
    expect(isCredentialFile("src/config.ts", "/w")).toBe(false);
  });
});

describe("stored data, scrubbed after the fact", () => {
  test("a transcript's lines are rewritten, unchanged ones kept, and the file replaced whole", async () => {
    const { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { scrubTranscripts } = await import("./scrub-stored.js");
    const dir = mkdtempSync(join(tmpdir(), "codeoid-scrub-"));
    try {
      const path = join(dir, "s1.jsonl");
      const clean = JSON.stringify({ seq: 0, message: { content: "hello" } });
      writeFileSync(path, `${clean}\n${JSON.stringify({ seq: 1, message: { content: `token ${GHP}` } })}\nnot json ${GHP}\n`, { mode: 0o600 });
      const known = new KnownSecrets();
      const scrubber = new Scrubber({ known, fingerprint: fp });
      const scrub = <T,>(v: T) => scrubber.scrubValue(v);
      expect(scrubTranscripts(dir, scrub, true)).toEqual({ files: 1, filesChanged: 1, linesChanged: 2 });
      expect(readFileSync(path, "utf8")).toContain(GHP);
      expect(scrubTranscripts(dir, scrub, false).linesChanged).toBe(2);
      const after = readFileSync(path, "utf8");
      expect(after).not.toContain(GHP);
      expect(after.split("\n")[0]).toBe(clean);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(scrubTranscripts(dir, scrub, false).linesChanged).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("memory episodes and their full bodies", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { SqliteEpisodeStore } = await import("../memory/index.js");
    const { scrubMemoryDb } = await import("./scrub-stored.js");
    const dir = mkdtempSync(join(tmpdir(), "codeoid-scrubmem-"));
    try {
      const db = join(dir, "mem.db");
      const store = new SqliteEpisodeStore(db);
      const long = `${"x".repeat(70_000)} ${GHP}`;
      const ep = store.insert({ workspaceId: "w", sessionId: "s", kind: "tool_call", summary: `ran with ${GHP}`, content: "index view", fullContent: long, filePaths: [], tokenEstimate: 1, createdAt: 1, createdBy: "u" });
      store.close();
      const scrubber = new Scrubber({ known: new KnownSecrets(), fingerprint: fp });
      expect(scrubMemoryDb(db, <T,>(v: T) => scrubber.scrubValue(v), false)).toBe(2);
      const reopened = new SqliteEpisodeStore(db);
      expect(reopened.getEpisode(ep.id)?.summary).not.toContain(GHP);
      expect(reopened.getFullContent(ep.id)).not.toContain(GHP);
      expect(reopened.ftsSearch("w", "Zx9Qw3Er5Ty7Ui1Op2As4Df6Gh8Jk0Lz3Xc5V", 5)).toEqual([]);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("vault", () => {
  test("a sealed value opens only where it was kept", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Store } = await import("../store.js");
    const { CapturedSecretVault } = await import("./vault.js");
    const dir = mkdtempSync(join(tmpdir(), "codeoid-vault-"));
    try {
      const store = new Store(join(dir, "codeoid.db"));
      const vault = new CapturedSecretVault(store, Buffer.alloc(32, 3));
      const scope = { accountId: "a", projectId: "p", workstream: "acme" };
      vault.put(scope, { kind: "github-token", fingerprint: "0123abcd", value: GHP });
      expect(vault.reveal(scope, "0123abcd")).toBe(GHP);
      expect(vault.reveal({ ...scope, workstream: "other" }, "0123abcd")).toBeUndefined();
      // Moved to another row by hand, it doesn't open there.
      const row = store.capturedSecret({ ...scope, fingerprint: "0123abcd" })!;
      store.putCapturedSecret({ ...scope, workstream: "other", fingerprint: "0123abcd", kind: row.kind, sealed: row.sealed, at: Date.now() });
      expect(vault.reveal({ ...scope, workstream: "other" }, "0123abcd")).toBeUndefined();
      // A different key opens nothing.
      expect(new CapturedSecretVault(store, Buffer.alloc(32, 4)).reveal(scope, "0123abcd")).toBeUndefined();
      expect(vault.list({ accountId: "a", projectId: "p" }).map((k) => k.workstream).sort()).toEqual(["acme", "other"]);
      expect(vault.forget(scope, "0123abcd")).toBe(true);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("learned", () => {
  test("a value found by a distinct format is matched bare from then on; one found only by its name isn't", async () => {
    const { LearnedSecrets } = await import("./known.js");
    const learned = new LearnedSecrets();
    const scrubber = new Scrubber({ known: new KnownSecrets(), learnedFor: () => learned, fingerprint: fp });
    const first = scrubber.scrub("Authorization: Bearer 8f2d0c1e9b7a4f6e8d2c\nthe token is 8f2d0c1e9b7a4f6e8d2c").text;
    expect(first).not.toContain("8f2d0c1e9b7a4f6e8d2c");
    const ref = /‹secret:bearer-token:[0-9a-f]{8}›/.exec(first)![0];
    expect(first.split(ref)).toHaveLength(3);
    expect(scrubber.scrub("later: 8f2d0c1e9b7a4f6e8d2c again").text).toBe(`later: ${ref} again`);
    // Only as a whole token: inside a longer word it is left.
    expect(scrubber.scrub("x8f2d0c1e9b7a4f6e8d2cx").text).toBe("x8f2d0c1e9b7a4f6e8d2cx");
    // A password found by its name isn't remembered: the same word is often ordinary elsewhere.
    scrubber.scrub("DB_PASSWORD=localhost-dev-pw");
    expect(scrubber.scrub("connect to localhost-dev-pw").text).toBe("connect to localhost-dev-pw");
  });

  test("scrubbing is idempotent even when a remembered value appears inside a reference", async () => {
    const { LearnedSecrets } = await import("./known.js");
    const learned = new LearnedSecrets();
    const scrubber = new Scrubber({ known: new KnownSecrets(), learnedFor: () => learned, fingerprint: fp });
    learned.learn("github-token-value", "‹secret:x:00000000›");
    const once = scrubber.scrub(`a ${GHP} b`).text;
    expect(scrubber.scrub(scrubber.scrub(once).text).text).toBe(once);
  });
});

describe("round-1 audit", () => {
  test.each([
    "    token = self.token",
    "api_key = args.api_key",
    "self.api_key = api_key",
    "apiKey: config.apiKey",
    "id_token = idToken",
    "MAX_TOKENS=100000",
    "DISABLE_AUTH=enabled",
    "AUTH=Bearer",
    'const pem = "-----BEGIN PRIVATE KEY-----"; foo(); const end = "-----END PRIVATE KEY-----"',
    "if (s.startsWith('-----BEGIN RSA PRIVATE KEY-----')) { return parse(s); }",
  ])("code isn't a secret: %s", (text) => {
    expect(kinds(text)).toEqual([]);
  });

  test("a value under a name stops at the command's next word", () => {
    expect(kinds("PGPASSWORD=postgres psql -h db")).toEqual(["credential:postgres"]);
  });

  test("a .netrc entry", () => {
    expect(kinds("machine example.com login bob password s3cr3tPassw0rd")).toEqual(["password:s3cr3tPassw0rd"]);
  });

  test("hostile input stays linear", () => {
    for (const text of ["-----BEGIN PRIVATE KEY-----".repeat(100_000), "curl ".repeat(400_000), `token: x${" ".repeat(990)}y\n`.repeat(2000)]) {
      const t0 = performance.now();
      findSecrets(text, t0 + 2_000);
      expect(performance.now() - t0).toBeLessThan(2_500);
    }
  });

  test.each(["source .env && bun test", ". ./.env; make test", "cp .env.example .env && bun run dev", "cat certs/ca.pem"])("keeps the output of %s", async (command) => {
    await loadShellParser();
    expect(toolVerdict("Bash", { command }, { cwd: "/w" })).toBe("keep");
  });

  test.each(["cat $HOME/.aws/credentials", "git show HEAD:.env", "git diff -- .env.production", "dd if=.env"])("withholds the output of %s", async (command) => {
    await loadShellParser();
    expect(toolVerdict("Bash", { command }, { cwd: "/w" })).toBe("withhold-output");
  });

  test("a stream judges a piece with what was sent of its line, and never cuts a spaced known value", () => {
    const known = new KnownSecrets();
    known.register("t", () => [{ label: "pp", value: "correct horse battery staple" }]);
    const scrubber = new Scrubber({ known, fingerprint: fp });
    const jwt = `eyJ${"a".repeat(600)}.eyJ${"b".repeat(300)}.${"c".repeat(100)}`;
    for (const [text, secret] of [
      ["AWS_ACCESS_KEY = Zx9qWvLk3mNp8RtY\n", "Zx9qWvLk3mNp8RtY"],
      ["the phrase is correct horse battery staple ok\n", "battery staple"],
      [`here ${jwt} done`, "a".repeat(100)],
      ['MY_PASSPHRASE = "hunter2-xyz-abc"\n', "hunter2-xyz-abc"],
    ] as const) {
      for (const step of [1, 3, 7]) {
        const s = new StreamScrubber(scrubber);
        let out = "";
        for (let i = 0; i < text.length; i += step) out += s.push(text.slice(i, i + step));
        out += s.flush();
        expect(out).not.toContain(secret);
      }
    }
    // Prose that only mentions the words streams.
    const s = new StreamScrubber(scrubber);
    expect(s.push("We use token-based authentication here and ")).toBe("We use token-based authentication here and ");
  });

  test("offline, a text that can't be checked is left as it is, and said", () => {
    let unchecked = 0;
    const scrubber = new Scrubber({ known: new KnownSecrets(), fingerprint: fp, budgetMs: -1, onUnchecked: () => void unchecked++ });
    expect(scrubber.scrub("keep me").text).toBe("keep me");
    expect(unchecked).toBe(1);
  });

  test("a relayed MCP result is scrubbed like a hub result", async () => {
    const { McpHub } = await import("../mcp/hub.js");
    const hub = new McpHub();
    const scrubber = new Scrubber({ known: new KnownSecrets(), fingerprint: fp });
    hub.setResultScrub((t) => scrubber.scrub(t).text);
    const r = hub.scrubRelayed("tools/call", { content: [{ type: "text", text: `t=${GHP}` }], structuredContent: { token: GHP } });
    expect(JSON.stringify(r)).not.toContain(GHP);
  });
});
