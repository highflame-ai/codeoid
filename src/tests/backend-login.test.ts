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
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BackendLoginBroker,
  BackendLoginError,
  CLAUDE_LOGIN_FLOW,
  CODEX_LOGIN_FLOW,
  type LoginFlow,
  redact,
} from "../daemon/auth/backend-login.js";
import type { LoginBackend } from "../protocol/types.js";

const URL_ = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz";
const GOOD_CODE = "good-code#xyz";
const TOKEN = "sk-ant-oat01-AAAABBBBCCCCDDDDEEEEFFFFGGGG";

let dir: string;
let fakeCmd: string;
/** Prints a non-https "URL" and exits — for the href guard. */
let evilCmd: string;
let pidFile: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "codeoid-logintest-"));
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

  evilCmd = join(dir, "evil-login.sh");
  writeFileSync(evilCmd, "#!/usr/bin/env bash\necho 'open javascript:alert(1) to sign in'\n", "utf8");
  chmodSync(evilCmd, 0o755);
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

  test("a non-https match is not offered as a link", async () => {
    // The URL becomes an `href` in every client, so the broker refuses anything
    // that is not https rather than trusting each flow's regex to stay tight.
    const pattern = /javascript:[A-Za-z0-9_.()]+/g;
    // The pattern DOES match what the command prints — so the only reason this
    // is not handed to a client is the https rule, not a failed match.
    expect("javascript:alert(1)".match(pattern)).toBeTruthy();

    const broker = newBroker({
      claude: {
        ...CLAUDE_LOGIN_FLOW,
        resolve: () => ({ file: evilCmd, args: [] }),
        urlPattern: pattern,
      },
    });
    const err = await broker.start("claude").catch((e) => e);
    expect(err).toBeInstanceOf(BackendLoginError);
    expect(String(err.message)).toContain("sign-in link");
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

  test("cancelling mid-exchange says so, rather than blaming the command", async () => {
    // `#dispose` wakes waiters by marking the attempt exited and then drops the
    // transcript, so a submit racing a cancel would otherwise judge the
    // exchange against an empty window and report a command failure for what
    // the user just did on purpose.
    const broker = newBroker();
    const login = await broker.start("claude");
    const pending = broker.submit(login.loginId, "wrong-code");
    broker.cancel(login.loginId);
    const out = await pending;
    expect(out.ok).toBe(false);
    expect(out.error).toContain("cancelled");
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

describe("isolated login (a named Claude account)", () => {
  test("runs against a throwaway config dir with no inherited credential, and removes it afterwards", async () => {
    const seen = join(dir, "isolated-seen");
    const cmd = join(dir, "isolated-login.sh");
    writeFileSync(
      cmd,
      `#!/usr/bin/env bash
printf '%s|%s\\n' "\${CLAUDE_CONFIG_DIR:-unset}" "\${ANTHROPIC_API_KEY:-none}" > "${seen}"
printf '%s\\n' "${URL_}"
read -r code
echo "Your token: ${TOKEN}"
`,
      "utf8",
    );
    chmodSync(cmd, 0o755);
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "daemon-key-must-not-leak";
    try {
      const broker = newBroker(fakeFlow({ resolve: () => ({ file: cmd, args: [] }) }));
      const login = await broker.start("claude", { isolated: true });
      const [configDir, apiKey] = readFileSync(seen, "utf8").trim().split("|");
      expect(configDir).toContain("codeoid-login-"); // never ~/.claude
      expect(apiKey).toBe("none");
      expect(existsSync(configDir!)).toBe(true);

      const outcome = await broker.submit(login.loginId, "any-code");
      expect(outcome.secret).toEqual({ key: "CLAUDE_CODE_OAUTH_TOKEN", value: TOKEN });
      // Marked, so the daemon never writes it where its own login lives.
      expect(outcome.isolated).toBe(true);
      expect(existsSync(configDir!)).toBe(false); // cleaned up with the attempt
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  test("a stale isolated dir a crashed daemon left behind is swept; a fresh one is not", () => {
    const stale = mkdtempSync(join(tmpdir(), "codeoid-claude-login-"));
    const fresh = mkdtempSync(join(tmpdir(), "codeoid-claude-login-"));
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(stale, old, old);
    newBroker();
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    rmSync(fresh, { recursive: true, force: true });
  });
});

describe("file-credential logins (Codex device code)", () => {
  const script = (name: string, body: string) => {
    const file = join(dir, name);
    writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, "utf8");
    chmodSync(file, 0o755);
    return file;
  };

  test("a Codex device login shows the link and code, finishes on its own, and hands back auth.json", async () => {
    const seen = join(dir, "codex-seen");
    const cmd = script(
      "codex-device.sh",
      `printf '%s|%s\\n' "\${CODEX_HOME:-unset}" "\${OPENAI_API_KEY:-none}" > "${seen}"
echo "1. Open this link in your browser and sign in to your account"
echo "   https://auth.openai.com/codex/device"
echo "2. Enter this one-time code (expires in 15 minutes)"
echo "   8UP4-KHOLU"
sleep 1
printf '{"auth_mode":"chatgpt","tokens":{"access_token":"at-secret"}}' > "$CODEX_HOME/auth.json"
echo "Successfully logged in"`,
    );
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "daemon-key-must-not-leak";
    try {
      const broker = newBroker({ codex: { ...CODEX_LOGIN_FLOW, resolve: () => ({ file: cmd, args: [] }) } });
      // Codex sign-in is for a named account only.
      await expect(broker.start("codex")).rejects.toThrow(/named account/);
      const login = await broker.start("codex", { isolated: true });
      expect(login).toMatchObject({ mode: "device", userCode: "8UP4-KHOLU", verificationUrl: "https://auth.openai.com/codex/device" });
      const [home, key] = readFileSync(seen, "utf8").trim().split("|");
      expect(home).toContain("codeoid-login-");
      expect(key).toBe("none");
      const outcome = await broker.wait(login.loginId);
      expect(outcome.ok).toBe(true);
      expect(outcome.isolated).toBe(true);
      expect(outcome.files?.["auth.json"]).toContain("at-secret");
      expect(existsSync(home!)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
    }
  });

  test("a Codex device login that exits without a credential fails", async () => {
    const cmd = script(
      "codex-fail.sh",
      `echo "   https://auth.openai.com/codex/device"
echo "   ABCD-EFGHI"
sleep 0.5
echo "Error logging in: device code expired"
exit 1`,
    );
    const broker = newBroker({ codex: { ...CODEX_LOGIN_FLOW, resolve: () => ({ file: cmd, args: [] }) } });
    const login = await broker.start("codex", { isolated: true });
    const outcome = await broker.wait(login.loginId);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/Error logging in/);
  });
});

describe("script(1)'s stdin is an ordinary pipe — not a socket, not a named pipe", () => {
  test.skipIf(process.platform !== "linux")("a script that refuses anything else (BSD script on macOS) still prints the link and takes the code", async () => {
    // Stand-in for macOS's BSD script: its failure on any stdin but an
    // ordinary pipe, otherwise the real script. Bun hands a child a
    // socketpair for "pipe" stdio, which broke sign-in on macOS (#411); recent
    // macOS refuses a named pipe the same way, which broke #411's fix. On
    // Linux an ordinary pipe reads as "pipe:[…]" in /proc; a FIFO as its path.
    const realScript = Bun.which("script");
    expect(realScript).toBeTruthy();
    const bin = join(dir, "bsd-like-bin");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "script"),
      `#!/bin/sh\ncase "$(readlink /proc/$$/fd/0)" in pipe:*) ;; *) echo "script: tcgetattr/ioctl: Operation not supported on socket" >&2; exit 1;; esac\nexec "${realScript}" "$@"\n`,
      "utf8",
    );
    chmodSync(join(bin, "script"), 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath}`;
    try {
      const broker = newBroker();
      const login = await broker.start("claude");
      expect(login.verificationUrl).toBe(URL_);
      const outcome = await broker.submit(login.loginId, GOOD_CODE);
      expect(outcome).toMatchObject({ ok: true, secret: { key: "CLAUDE_CODE_OAUTH_TOKEN", value: TOKEN } });
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

describe("a real code and a real token — long ones", () => {
  // Stand-in modelled on the real CLI's terminal UI: raw keystrokes, where a
  // chunk arriving at once is a paste and an Enter inside it is text (the
  // code never submits), and output wrapped at the terminal's width — 80
  // columns when the pty reports none. Real codes are ~130 characters and
  // real tokens ~108, so both are long enough to hit each.
  const LONG_CODE = `${"c".repeat(124)}#state`;
  const LONG_TOKEN = `sk-ant-oat01-${"T".repeat(95)}`;
  let tuiCmd: string;

  beforeAll(() => {
    tuiCmd = join(dir, "fake-tui-login.ts");
    writeFileSync(
      tuiCmd,
      `#!/usr/bin/env bun
const width = process.stdout.columns || 80;
const wrap = (text: string) => (text.match(new RegExp(\`.{1,\${width}}\`, "g")) ?? []).join("\\n");
process.stdout.write(\`Browser didn't open? Use the url below to sign in\\n\${wrap("${URL_}")}\\nPaste code here if prompted > \`);
process.stdin.setRawMode?.(true);
let field = "";
process.stdin.on("data", (chunk: Buffer) => {
  const text = chunk.toString("utf8");
  if (text === "\\r") {
    if (field === "${LONG_CODE}") {
      process.stdout.write("\\n" + wrap("Success! Your OAuth token: ${LONG_TOKEN}") + "\\n");
      process.exit(0);
    }
    process.stdout.write("\\nOAuth error: Request failed with status code 400\\n");
    field = "";
    return;
  }
  // One chunk of several characters is a paste: an Enter in it is text.
  field += text;
});
`,
      "utf8",
    );
    chmodSync(tuiCmd, 0o755);
  });

  test("a long code is typed, then Enter pressed apart — it submits, and the whole token is kept", async () => {
    const broker = newBroker(fakeFlow({ resolve: () => ({ file: tuiCmd, args: [] }) }));
    const login = await broker.start("claude");
    expect(login.verificationUrl).toBe(URL_);
    const outcome = await broker.submit(login.loginId, LONG_CODE);
    // Unwrapped: at 80 columns the token would be captured cut short.
    expect(outcome).toMatchObject({ ok: true, secret: { key: "CLAUDE_CODE_OAUTH_TOKEN", value: LONG_TOKEN } });
  }, 20_000);
});

