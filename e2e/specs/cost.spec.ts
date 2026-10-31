import { createSessionInUi, expect, messages, openUi, send, test, waitIdle } from "../harness";

test("a backend that reports no cost: its turns are priced and shown as an estimate; a model with no price, as unknown (#430)", async ({ page, codeoid }) => {
  codeoid.setScript([
    // No costUsd: the session prices 1M input + 500k output at the harness's $1/$2 per million.
    { match: "^priced", steps: [{ text: "Priced." }, { usage: { inputTokens: 1_000_000, outputTokens: 500_000 } }] },
    { match: "^unpriced", steps: [{ text: "Unpriced." }, { usage: { inputTokens: 1000, outputTokens: 10, model: "a-model-nobody-prices" } }] },
  ]);
  await openUi(page, codeoid);
  const cost = () => page.getByRole("main").getByText("Cost", { exact: true }).locator("..");

  await createSessionInUi(page, "estimate", codeoid.workdir);
  await send(page, "priced");
  await expect(messages(page).filter({ hasText: "Priced." })).toHaveCount(1);
  await waitIdle(page);
  await expect(cost()).toContainText("~$2.00");

  await createSessionInUi(page, "unknown", codeoid.workdir);
  await send(page, "unpriced");
  await expect(messages(page).filter({ hasText: "Unpriced." })).toHaveCount(1);
  await waitIdle(page);
  await expect(cost()).toContainText("$?");
  await expect(cost()).not.toContainText("$0");
});

test("a routine with a spend cap stops on a turn it can't price, instead of running uncapped (#430)", async ({ codeoid }) => {
  codeoid.setScript([{ match: "unpriced", steps: [{ text: "Working." }, { usage: { inputTokens: 1000, outputTokens: 10, model: "a-model-nobody-prices" } }] }]);
  await codeoid.cliOk("routine", "add", "capped", "--workdir", codeoid.workdir, "--every", "1h", "--prompt", "unpriced work", "--max-cost", "1");
  const r = await codeoid.cli("routine", "run", "capped", "--wait");
  expect(r.output).toContain("failed");
  expect(r.output).toContain("isn't known");

  // The same work with no cap runs to the end.
  await codeoid.cliOk("routine", "add", "uncapped", "--workdir", codeoid.workdir, "--every", "1h", "--prompt", "unpriced work");
  const ok = await codeoid.cli("routine", "run", "uncapped", "--wait");
  expect(ok.output).toContain("succeeded");
});
