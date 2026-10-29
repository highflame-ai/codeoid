import { createSessionInUi, expect, focusSession, messages, openUi, send, test, waitIdle } from "../harness";

test("a second device attaching mid-turn sees the history replayed and the rest of the turn live", async ({ page, codeoid, browser }) => {
  const gate = codeoid.gate("handoff");
  codeoid.setScript([
    {
      match: "^long job",
      // Held until the test releases it, so the second device provably attaches mid-turn.
      steps: [{ text: "Step one is done." }, { waitFor: gate }, { text: "Step two is done." }],
    },
  ]);
  await openUi(page, codeoid);
  await createSessionInUi(page, "handoff", codeoid.workdir);
  await send(page, "first message");
  await expect(messages(page).filter({ hasText: "scripted: first message" })).toHaveCount(1);

  await send(page, "long job");
  await expect(messages(page).filter({ hasText: "Step one is done." })).toHaveCount(1);

  // Another device, mid-turn.
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  try {
    const other = await context.newPage();
    await openUi(other, codeoid);
    await focusSession(other, "handoff");
    for (const text of ["first message", "scripted: first message", "long job", "Step one is done."]) {
      await expect(messages(other).filter({ hasText: text }).first()).toBeVisible();
    }
    // Still running there, and the rest hasn't happened yet.
    await expect(other.getByRole("button", { name: /interrupt/ })).toBeEnabled();
    await expect(messages(other).filter({ hasText: "Step two is done." })).toHaveCount(0);

    codeoid.release(gate);
    await expect(messages(other).filter({ hasText: "Step two is done." })).toHaveCount(1);
    await waitIdle(other);

    // Exactly what the first device shows, message for message.
    await waitIdle(page);
    expect(await messages(other).allInnerTexts()).toEqual(await messages(page).allInnerTexts());
  } finally {
    await context.close();
  }
});
