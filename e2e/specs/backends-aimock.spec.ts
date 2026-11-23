import { existsSync } from "node:fs";
import { join } from "node:path";
import { BACKENDS, requestWith, script, startAimock } from "../aimock";
import { Codeoid, createSessionInUi, expect, messages, openUi, send, test, waitIdle } from "../harness";

// Release gate tier 2 (docs/release-gate.md): each backend's real harness in a
// real daemon, its model played by aimock. What the user sees, and what reached
// the "provider" (aimock's journal), are both checked.
for (const backend of BACKENDS) {
  test(`${backend.id} against aimock: a reply, an approved and a denied tool call, and a restart that keeps the conversation`, async ({ page }, testInfo) => {
    const missing = backend.missing();
    // CI names the backends it installed (CODEOID_E2E_REQUIRE_BACKENDS): one of them missing fails, never skips.
    if (missing && (process.env.CODEOID_E2E_REQUIRE_BACKENDS ?? "").split(",").includes(backend.id)) throw new Error(`${backend.id} is required here, but ${missing}`);
    test.skip(missing !== null, missing ?? "");
    test.setTimeout(180_000);
    let codeoid: Codeoid | null = null;
    const { mock, url } = await startAimock();
    try {
      codeoid = await Codeoid.create([], { provider: backend.id, env: backend.env(url), home: (home) => backend.home?.(home, url) });
      // The write fixtures name absolute paths in the workdir, known once the daemon exists.
      const work = codeoid.workdir;
      script(mock, [
        { match: { userMessage: "say hello" }, response: { content: "Hello from aimock." } },
        { match: { userMessage: "write it", hasToolResult: false }, response: { toolCalls: [backend.writeFile(join(work, "approved.txt"), "approved", work)] } },
        { match: { userMessage: "write it", hasToolResult: true }, response: { content: "All done." } },
        { match: { userMessage: "skip it", hasToolResult: false }, response: { toolCalls: [backend.writeFile(join(work, "denied.txt"), "denied", work)] } },
        { match: { userMessage: "skip it", hasToolResult: true }, response: { content: "Understood, skipped." } },
        { match: { userMessage: "after the restart" }, response: { content: "Still here." } },
      ]);

      await openUi(page, codeoid);
      await createSessionInUi(page, `${backend.id}-journeys`, work);

      // 1. A reply.
      await send(page, "say hello");
      await expect(messages(page).filter({ hasText: "Hello from aimock." })).toHaveCount(1);
      await waitIdle(page);

      // 2. A tool call that needs approval: approved, it runs.
      await send(page, "write it");
      await expect(page.getByText("Approval needed")).toBeVisible();
      await page.getByRole("button", { name: "approve", exact: true }).click();
      await expect(messages(page).filter({ hasText: "All done." })).toHaveCount(1);
      await waitIdle(page);
      expect(codeoid.readFile("approved.txt")).toBe("approved");

      // 3. Denied, it doesn't, and the model hears so.
      await send(page, "skip it");
      await expect(page.getByText("Approval needed")).toBeVisible();
      await page.getByRole("button", { name: "deny", exact: true }).click();
      await expect(messages(page).filter({ hasText: "Understood, skipped." })).toHaveCount(1);
      await waitIdle(page);
      expect(existsSync(join(work, "denied.txt"))).toBe(false);

      // 4. A restart: the session comes back, and its backend is handed the whole conversation.
      await codeoid.restart();
      await openUi(page, codeoid);
      await page.getByText(`${backend.id}-journeys`, { exact: true }).first().click();
      await expect(messages(page).filter({ hasText: "Hello from aimock." })).toHaveCount(1);
      await send(page, "after the restart");
      await expect(messages(page).filter({ hasText: "Still here." })).toHaveCount(1);
      await waitIdle(page);
      const resumed = requestWith(mock, "after the restart");
      expect(resumed).toContain("say hello");
      expect(resumed).toContain("Hello from aimock.");

      // Every request went to this backend's own API.
      const paths = mock.getRequests().map((r) => r.path);
      expect(paths.length).toBeGreaterThan(0);
      expect(paths.filter((p) => !backend.wirePath.test(p) && !p.startsWith("/v1/models"))).toEqual([]);
    } finally {
      if (codeoid) {
        if (testInfo.status !== testInfo.expectedStatus) await testInfo.attach("daemon.log", { body: codeoid.log, contentType: "text/plain" });
        await codeoid.dispose();
      }
      await mock.stop();
    }
  });
}
