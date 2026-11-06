import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { type Codeoid, createSessionInUi, expect, focusSession, messages, openUi, send, test, waitIdle } from "../harness";

// A resumed session holds its metadata only, and loads its scrollback and
// history the first time it is opened (`session.lazyLoad`, on by default).

/** Long enough that a few turns overflow the attach tail set below. */
const FILLER = "lorem ipsum dolor sit amet ".repeat(5).trim();
const TURNS = 8;

/** The sidebar row's text, less its relative "created …" line. */
async function rowText(page: Page, name: string): Promise<string> {
  const row = page.getByRole("listitem").filter({ has: page.getByText(name, { exact: true }) });
  return (await row.innerText()).replace(/created .*$/m, "").trim();
}

/** Sessions whose history the daemon has loaded since `from` in its log. */
function loadsSince(codeoid: Codeoid, from: number): string[] {
  return codeoid.log
    .slice(from)
    .split("\n")
    .filter((l) => l.includes("history loaded:"));
}

/** `codeoid ls`, one block per session, sorted (a resume lists newest first), less what attaching changes. */
async function ls(codeoid: Codeoid): Promise<string[]> {
  return (await codeoid.cliOk("ls"))
    .replace(/clients: \d+/g, "clients: _")
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b && !b.startsWith("Sessions:"))
    .sort();
}

/** Scroll the transcript (virtualized: only what is in view is rendered). */
async function scrollTranscript(page: Page, to: "top" | "bottom"): Promise<void> {
  await page.getByRole("main").evaluate((el, end) => {
    type Box = { scrollHeight: number; clientHeight: number; scrollTop: number };
    for (const n of [el, ...el.querySelectorAll("*")] as unknown as Box[]) {
      if (n.scrollHeight > n.clientHeight) n.scrollTop = end === "top" ? 0 : n.scrollHeight;
    }
  }, to);
}

/** Page back to the session's first message, then show it. */
async function pageToTop(page: Page): Promise<void> {
  const sentinel = page.getByTestId("older-history-sentinel");
  for (let i = 0; i < 40 && (await sentinel.count()) > 0; i++) {
    const more = sentinel.getByRole("button");
    // Scrolling it into view may load the page first: the button goes away.
    if ((await more.count()) > 0) await more.click({ timeout: 1_000 }).catch(() => {});
    await page.waitForTimeout(100);
  }
  await expect(sentinel).toHaveCount(0);
  await scrollTranscript(page, "top");
}

test("resumed sessions list before they load, and load their whole history when opened, across restarts", async ({ page, browser, codeoid }) => {
  test.setTimeout(180_000);
  // Memory on (embeddings off: nothing to download), so each turn's usage is
  // recorded and restored with the session, as on a default install; and a
  // small attach tail, so opening the session pages its history.
  const configPath = join(codeoid.configDir, "codeoid", "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as { session: Record<string, unknown> };
  writeFileSync(
    configPath,
    JSON.stringify({ ...config, memory: { enabled: true, embeddings: { enabled: false } }, session: { ...config.session, attachTailBytes: 2048 } }),
  );
  await codeoid.restart();
  await openUi(page, codeoid);
  await createSessionInUi(page, "long", codeoid.workdir);
  for (let i = 1; i <= TURNS; i++) {
    await send(page, `turn ${i} ${FILLER}`);
    await expect(messages(page).filter({ hasText: `scripted: turn ${i} ` })).toHaveCount(1);
    await waitIdle(page);
  }
  await codeoid.cliOk("new", "other", codeoid.workdir);
  // The sidebar lists another client's new session on its next list.
  await page.reload();
  await expect(page.getByText("live", { exact: true })).toBeVisible();
  await focusSession(page, "other");
  await send(page, "hello other");
  await expect(messages(page).filter({ hasText: "scripted: hello other" })).toHaveCount(1);
  await waitIdle(page);
  const rows = { long: await rowText(page, "long"), other: await rowText(page, "other") };
  expect(rows.long).toContain(`${TURNS}t`);
  const listed = await ls(codeoid);
  const idOf = (name: string) => /id: ([0-9a-f-]{36})/.exec(listed.find((b) => b.startsWith(`${name} `))!)![1]!;
  const ids: Record<string, string> = { long: idOf("long"), other: idOf("other") };
  const longId = ids.long!;
  const loadsOf = (name: string, from: number) => loadsSince(codeoid, from).filter((l) => l.includes(ids[name]!.slice(0, 8)));


  // This page re-attaches its focused session when it reconnects: park it.
  await page.goto("about:blank");

  for (const round of [1, 2]) {
    const from = codeoid.log.length;
    await codeoid.restart();

    // A fresh browser: nothing focused, so nothing is opened.
    const ctx = await browser.newContext();
    const fresh = await ctx.newPage();
    const sent: string[] = [];
    fresh.on("websocket", (ws) => ws.on("framesent", (f) => sent.push(String(f.payload))));
    await openUi(fresh, codeoid);
    await expect(fresh.getByRole("listitem").filter({ has: fresh.getByText("long", { exact: true }) })).toBeVisible();
    // The list says what it said before the restart. The UI opens the newest
    // session by itself; the other one, listed but not opened, isn't loaded.
    expect(await rowText(fresh, "long")).toBe(rows.long);
    expect(await rowText(fresh, "other")).toBe(rows.other);
    expect(await ls(codeoid)).toEqual(listed);
    const opened = (await fresh.getByRole("heading", { level: 2 }).innerText()).trim();
    const notOpened = opened === "long" ? "other" : "long";
    expect(loadsOf(notOpened, from)).toEqual([]);

    // Opening one loads it (and only it): the newest turns at once, the rest paged.
    await focusSession(fresh, "long");
    await expect(messages(fresh).filter({ hasText: `scripted: turn ${TURNS} ` })).toHaveCount(1);
    await pageToTop(fresh);
    await expect(messages(fresh).filter({ hasText: "scripted: turn 1 " })).toBeVisible();
    // The first turns came by paging: the attach sent only the newest.
    expect(sent.some((f) => f.includes('"scrollback.page"') && f.includes(longId))).toBe(true);
    // Loaded once, when opened.
    expect(loadsOf("long", from)).toHaveLength(1);

    // It takes a new prompt and answers it.
    await scrollTranscript(fresh, "bottom");
    await send(fresh, `after restart ${round}`);
    await scrollTranscript(fresh, "bottom");
    await expect(messages(fresh).filter({ hasText: `scripted: after restart ${round}` })).toHaveCount(1);
    await waitIdle(fresh);
    rows.long = await rowText(fresh, "long");
    expect(rows.long).toContain(`${TURNS + round}t`);
    await ctx.close();
  }

  // The first browser signs in again and finds the whole history.
  await openUi(page, codeoid);
  await focusSession(page, "long");
  await expect(messages(page).filter({ hasText: "scripted: after restart 2" })).toHaveCount(1);
  await expect(messages(page).filter({ hasText: "scripted: after restart 1" })).toHaveCount(1);
  await pageToTop(page);
  await expect(messages(page).filter({ hasText: "scripted: turn 1 " })).toBeVisible();
});
