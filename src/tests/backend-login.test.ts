/**
 * Backend login broker.
 *
 * These run a FAKE vendor command through the REAL pty, the real matchers, and
 * the real lifecycle. That combination is deliberate: the parts most likely to
 * be wrong here are not the state machine but the seam with a terminal —
 * whether `script(1)` is invoked correctly, whether the URL survives OSC-8
 * hyperlinks and an 80-column wrap, whether writing a line to stdin actually
 * reaches a program blocked on `read`. Mocking the process would test the half
 * that was never in doubt.
 *
 * The fake's output is modelled on a transcript captured from the real
 * `claude setup-token`: same hyperlink wrapper around the URL, the same
 * line-wrapped duplicate beside it, the same `OAuth error:` on rejection, and
 * the same habit of staying alive afterwards to offer a retry.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BackendLoginBroker,
  BackendLoginError,
  CLAUDE_LOGIN_FLOW,
  type LoginFlow,
  redact,
} from "../daemon/auth/backend-login.js";
import type { LoginBackend } from "../protocol/types.js";

const URL_ = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz";
const GOOD_CODE = "good-code#xyz";
const TOKEN = "sk-ant-oat01-AAAABBBBCCCCDDDDEEEEFFFFGGGG";

let dir: string;
let fakeCmd: string;
let pidFile: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "codeoid-login-"));
  fakeCmd = join(dir, "fake-login.sh");
  pidFile = join(dir, "pid");
  // Note the two copies of the URL: the OSC-8 hyperlink carries it whole, the
  // visible text is wrapped at 78 columns like a real terminal would. Only the
  // longest-match rule recovers a usable URL from that.
  const head = URL_.slice(0, 78);
  const tail = URL_.slice(78);
  writeFileSync(
    fakeCmd,
    `#!/usr/bin/env bash
echo $$ > "${pidFile}"
echo "Welcome to Fake CLI"
printf 'Opening browser to sign in\\xe2\\x80\\xa6\\n'
printf '\\033]8;id=abc;%s\\033\\\\%s\\033]8;;\\033\\\\\\n' "${URL_}" "${head}"
printf '%s\\n' "${tail}"
echo "Paste code here if prompted >"
read -r code
if [ "$code" = "${GOOD_CODE}" ]; then
  echo "Success! Your token: ${TOKEN}"
  exit 0
fi
# Mirrors the real command: reports the error and stays alive offering a retry,
# so the broker must not wait for an exit to call this a failure.
echo "OAuth error: Request failed with status code 400"
echo "Press Enter to retry."
sleep 120
`,
    "utf8",
  );
  chmodSync(fakeCmd, 0o755);
});

/** The real Claude matchers against a fake command — the matching is the point. */
function fakeFlow(overrides: Partial<LoginFlow> = {}): Record<string, LoginFlow> {
  return {
    claude: {
      ...CLAUDE_LOGIN_FLOW,
      resolve: () => ({ file: fakeCmd, args: [] }),
      ...overrides,
    },
  };
}

const brokers: BackendLoginBroker[] = [];
function newBroker(flows = fakeFlow()): BackendLoginBroker {
  const b = new BackendLoginBroker(flows);
  brokers.push(b);
  return b;
}

afterEach(() => {
  for (const b of brokers.splice(0)) b.dispose();
});

describe("start", () => {
  test("recovers the whole URL from hyperlinked, line-wrapped terminal output", async () => {
    const login = await newBroker().start("claude");
    // The visible copy is truncated at the wrap; only the hyperlink's is whole.
    // Asserting equality (not `contains`) is what pins longest-match.
    expect(login.verificationUrl).toBe(URL_);
    expect(login.backend).toBe("claude");
    expect(login.loginId.length).toBeGreaterThan(0);
    expect(login.expiresAt).toBeGreaterThan(Date.now());
  });

  test("an unavailable command is a clean refusal, not a spawn failure", async () => {
    const broker = newBroker(fakeFlow({ resolve: () => null }));
    const err = await broker.start("claude").catch((e) => e);
    expect(err).toBeInstanceOf(BackendLoginError);
    expect(String(err.message)).toContain("not installed");
  });

  test("an unknown backend is refused", async () => {
    const err = await newBroker()
      .start("nope" as LoginBackend)
      .catch((e) => e);
    expect(err).toBeInstanceOf(BackendLoginError);
  });

  test("a second start supersedes the first, so a reloaded page is not locked out", async () => {
    const broker = newBroker();
    const first = await broker.start("claude");
    const second = await broker.start("claude");
    expect(second.loginId).not.toBe(first.loginId);
    // The superseded attempt is gone: its id no longer submits or cancels.
    expect(broker.cancel(first.loginId)).toBe(false);
    const stale = await broker.submit(first.loginId, GOOD_CODE);
    expect(stale.ok).toBe(false);
    expect(stale.error).toContain("no longer open");
  });
});

describe("submit", () => {
  test("the right code yields the credential the command printed", async () => {
    const broker = newBroker();
    const login = await broker.start("claude");
    const out = await broker.submit(login.loginId, GOOD_CODE);
    expect(out.ok).toBe(true);
    expect(out.secret).toEqual({ key: "CLAUDE_CODE_OAUTH_TOKEN", value: TOKEN });
    expect(out.error).toBeUndefined();
  });

  test("a rejected code fails without waiting for the command to exit", async () => {
    const broker = newBroker();
    const login = await broker.start("claude");
    // The fake sleeps 120s after the error. Anything near that means the broker
    // is waiting on exit rather than on the vendor's own rejection.
    const started = Date.now();
    const out = await broker.submit(login.loginId, "wrong-code");
    expect(out.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(out.secret).toBeUndefined();
    expect(out.error).toContain("OAuth error");
    expect(out.error).toContain("Start the sign-in again");
  });

  test("a credential-shaped code is not mistaken for the vendor's answer", async () => {
    // A pty echoes its input, so a token-shaped paste lands in the transcript
    // looking exactly like output. Reading it back would report a successful
    // sign-in and store the user's own typo as the credential.
    const broker = newBroker();
    const login = await broker.start("claude");
    const looksLikeAToken = "sk-ant-oat01-LEAKYLEAKYLEAKYLEAKYLEAKY";
    const out = await broker.submit(login.loginId, looksLikeAToken);
    expect(out.ok).toBe(false);
    expect(out.secret).toBeUndefined();
    // …and the echo must not come back out in the error either.
    expect(out.error ?? "").not.toContain("LEAKY");
  });

  test("the attempt is terminal — the same id cannot be submitted twice", async () => {
    const broker = newBroker();
    const login = await broker.start("claude");
    expect((await broker.submit(login.loginId, GOOD_CODE)).ok).toBe(true);
    const again = await broker.submit(login.loginId, GOOD_CODE);
    expect(again.ok).toBe(false);
    expect(again.error).toContain("no longer open");
  });

  test("an unknown login id is refused", async () => {
    const out = await newBroker().submit("not-a-login", GOOD_CODE);
    expect(out.ok).toBe(false);
  });

  test.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["embedded newline", "abc\ndef"],
    ["carriage return", "abc\rdef"],
    ["null byte", "abc\u0000def"],
    ["oversized", "x".repeat(2000)],
  ])("a code that cannot be one is refused before it reaches the pty: %s", async (_name, code) => {
    const broker = newBroker();
    const login = await broker.start("claude");
    const out = await broker.submit(login.loginId, code);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("does not look like");
    // Refused, not consumed: the attempt is still live and still usable.
    const good = await broker.submit(login.loginId, GOOD_CODE);
    expect(good.ok).toBe(true);
  });

  test("surrounding whitespace is tolerated — a pasted code often carries it", async () => {
    const broker = newBroker();
    const login = await broker.start("claude");
    const out = await broker.submit(login.loginId, `  ${GOOD_CODE}  `);
    expect(out.ok).toBe(true);
  });

  test("a command that prints no credential succeeds on its exit status", async () => {
    // Some vendors write the credential to disk and print nothing worth
    // keeping. That is success with nothing for codeoid to store, not failure.
    const broker = newBroker(fakeFlow({ extractSecret: () => null }));
    const login = await broker.start("claude");
    const out = await broker.submit(login.loginId, GOOD_CODE);
    expect(out.ok).toBe(true);
    expect(out.secret).toBeUndefined();
  });
});

describe("cancel", () => {
  test("kills the command, so an abandoned attempt is not a live pty", async () => {
    const broker = newBroker();
    const login = await broker.start("claude");
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(alive(pid)).toBe(true);

    expect(broker.cancel(login.loginId)).toBe(true);
    await waitUntil(() => !alive(pid), 5_000);
    expect(alive(pid)).toBe(false);
    expect(broker.cancel(login.loginId)).toBe(false); // idempotent
  });

  test("dispose kills every attempt", async () => {
    const broker = newBroker();
    const login = await broker.start("claude");
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    broker.dispose();
    await waitUntil(() => !alive(pid), 5_000);
    expect(alive(pid)).toBe(false);
    expect((await broker.submit(login.loginId, GOOD_CODE)).ok).toBe(false);
  });
});

describe("redact", () => {
  test.each([
    ["sk-ant-oat01-AAAABBBBCCCCDDDDEEEEFFFF"],
    ["sk-ant-api03-ZZZZYYYYXXXXWWWWVVVVUUUU"],
    ["sk-proj-0123456789abcdefghijklmnop"],
  ])("removes %s", (credential) => {
    const out = redact(`failed with ${credential} in the message`);
    expect(out).not.toContain(credential);
    expect(out).toContain("«redacted»");
  });

  test("leaves ordinary text alone", () => {
    expect(redact("OAuth error: status code 400")).toBe("OAuth error: status code 400");
  });
});

describe("the Claude flow's matchers", () => {
  test("extracts the token shape setup-token prints", () => {
    expect(CLAUDE_LOGIN_FLOW.extractSecret(`Your token: ${TOKEN}\n`)).toEqual({
      key: "CLAUDE_CODE_OAUTH_TOKEN",
      value: TOKEN,
    });
  });

  test("does not mistake an API key for a subscription token", () => {
    // Only oat01 is the subscription credential; storing an api03 key under
    // CLAUDE_CODE_OAUTH_TOKEN would authenticate as the wrong thing.
    expect(CLAUDE_LOGIN_FLOW.extractSecret("sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF")).toBeNull();
  });

  test("the URL matcher stops at terminal control bytes", () => {
    const esc = "\u001b";
    const bel = "\u0007";
    const raw = `${esc}]8;id=z;${URL_}${bel}${URL_.slice(0, 20)}${esc}]8;;${bel}`;
    const matches = [...raw.matchAll(CLAUDE_LOGIN_FLOW.urlPattern)].map((m) => m[0]);
    expect(matches).toContain(URL_);
    // No match may carry an escape into itself.
    for (const m of matches) expect(m).not.toContain(esc);
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}
