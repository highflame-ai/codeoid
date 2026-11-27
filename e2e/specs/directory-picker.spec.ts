import { realpathSync } from "node:fs";
import { dirname } from "node:path";

import { expect, openUi, test } from "../harness";

test("pick a workdir outside home in the folder browser, by typing its path", async ({ page, codeoid }) => {
  // The harness's workdir is a sibling of its home — out of reach of the old HOME-only browser.
  const workdir = realpathSync(codeoid.workdir);
  await openUi(page, codeoid);
  await page.getByRole("button", { name: /new session/ }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("picked");
  await page.getByRole("button", { name: "Browse…" }).click();

  const picker = page.getByRole("dialog", { name: "Choose a folder" });
  await expect(picker.getByRole("navigation", { name: "Path" })).toHaveText(/^~/);

  // A path in the filter box browses its parent live and narrows to the last segment.
  const filter = picker.getByRole("textbox", { name: "Filter folders, or type a path" });
  await filter.fill(`${dirname(workdir)}/wo`);
  const row = picker.getByRole("option").filter({ hasText: "work" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("git");

  await filter.press("Tab");
  await expect(filter).toHaveValue(`${workdir}/`);
  await expect(picker.getByRole("navigation", { name: "Path" })).toContainText("work");
  await filter.press("Control+Enter");

  await expect(picker).toBeHidden();
  await expect(page.getByRole("textbox", { name: /^Workdir/ })).toHaveValue(workdir);
  await page.getByRole("button", { name: "create", exact: true }).click();
  await expect(page.getByRole("heading", { name: "picked", level: 2 })).toBeVisible();
  expect(await codeoid.cliOk("ls")).toContain("picked");
});
