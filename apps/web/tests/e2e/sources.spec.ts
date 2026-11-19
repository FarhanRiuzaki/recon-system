import { expect, type Page, test } from "@playwright/test";
import { AUTH_STATE } from "./global-setup";
import { demoIds, signIn } from "./helpers";

/**
 * Sources list and detail (Figma page 02, Build notes 02 "Plan 2 state coverage") on the demo seed
 * (apps/api/src/db/seed/demo-sources.ts): the global-setup Superadmin is a source admin of Treasury, `viewer` an
 * operator there and a viewer of CTOP, which reads "BI settlement file" through a share. Desktop project only.
 */
const sourceRow = (page: Page, name: string) => page.getByRole("table", { name: "Sources" }).getByRole("row").filter({ hasText: name });

test.describe("as a source admin of Treasury", () => {
  test.use({ storageState: AUTH_STATE });

test("Sources in the navigation opens the space's sources: health, completeness and quarantine as the API judged them", async ({ page, baseURL }) => {
  const ids = await demoIds(baseURL);
  await page.goto("/");
  await page.getByRole("navigation", { name: "Menu" }).getByRole("link", { name: "Sources" }).click();
  await expect(page).toHaveURL(`/spaces/${ids.treasury}/sources`);
  await expect(page.getByRole("heading", { level: 1, name: "Sources" })).toBeVisible();
  await expect(page).toHaveTitle(/^Sources · Treasury\b/);
  await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("listitem")).toHaveText(["Sources"]);
  const table = page.getByRole("table", { name: "Sources" });
  await expect(table.getByRole("columnheader")).toHaveText(["Source", "Kind", "State", "Complete through", "Records today", "Quarantined today"]);
  await expect(table.locator("tbody").getByRole("row")).toHaveCount(9);
  await expect(sourceRow(page, "BI settlement file").getByRole("cell").nth(2)).toContainText("Healthy");
  await expect(sourceRow(page, "BI settlement file").getByRole("cell").nth(5)).toHaveText(/\D1$/); // after the phone card's hidden label
  await expect(sourceRow(page, "BI-RTGS statement").getByRole("cell").nth(2)).toContainText("Degraded");
  await expect(sourceRow(page, "BI-RTGS statement").getByRole("cell").nth(3)).toContainText(/No ingested file for \d{1,2} \w{3}$/);
  await expect(sourceRow(page, "Core bank · BI-FAST outgoing").getByRole("cell").nth(3)).toContainText(/min behind/);
  await expect(sourceRow(page, "GL nostro USD").getByRole("cell").nth(2)).toContainText("Paused");
  // search goes to the URL
  await page.getByRole("button", { name: "Expand filters", exact: true }).click();
  await page.getByRole("dialog", { name: "Filters", exact: true }).getByLabel("Search sources", { exact: true }).fill("core bank");
  await expect(page).toHaveURL(/q=core\+bank/);
  await expect(table.locator("tbody").getByRole("row")).toHaveCount(4);
});

test("file inbox (a, e): a resend is Rejected by its sha256, a file's version 2 says what it added; the quarantine pages on the server", async ({ page, baseURL }) => {
  const ids = await demoIds(baseURL);
  await page.goto(`/spaces/${ids.treasury}/sources`);
  await sourceRow(page, "BI settlement file").getByRole("link", { name: "BI settlement file" }).click();
  await expect(page).toHaveURL(`/spaces/${ids.treasury}/sources/${ids.biSettlement}`);
  await expect(page.getByRole("heading", { level: 1, name: "BI settlement file" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("listitem")).toHaveText(["Sources", /BI settlement file$/]);
  const files = page.getByRole("table", { name: "Files" });
  await expect(files.getByRole("row").filter({ hasText: "Rejected" })).toContainText(/Same file already ingested\. Its sha256 \(9f2c…a71e\) matches the file from .+; nothing changed\./);
  const v2 = files.getByRole("row").filter({ hasText: "version 2 of" });
  await expect(v2).toContainText("2 new records, 10 already stored");
  await expect(v2.getByRole("cell").nth(3)).toHaveText(/\D2$/); // Records = what this file added (Figma 95:8429)
  // the Result line wraps in its column: nothing runs past the card
  expect(await files.locator("xpath=ancestor::div[@data-slot='table-container']").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(page.getByRole("button", { name: "Check the folder now", exact: true })).toBeVisible();

  await page.getByRole("link", { name: /^Quarantine/ }).click();
  await expect(page).toHaveURL(/tab=quarantine/);
  const q = page.getByRole("table", { name: "Quarantine" });
  await expect(q.locator("tbody").getByRole("row")).toHaveCount(15);
  await expect(q).toContainText("Expected 3 columns, found 2");
  await expect(q.getByRole("columnheader")).toHaveText(["Row", "File", "Reason, per column", "Raw line", "Business date"]);
  await expect(q.locator("tbody").getByRole("row").first()).toContainText(/bisettle\d{8}\.txt · version 1/);
  await expect(page.getByText("Quarantined rows never become breaks and can't be released by hand.", { exact: false })).toBeVisible();
  await page.getByRole("navigation", { name: "Quarantine pages" }).getByRole("button", { name: "Page 2", exact: true }).click();
  await expect(page).toHaveURL(/tab=quarantine.*page=2|page=2.*tab=quarantine/);
  await expect(q.locator("tbody").getByRole("row")).toHaveCount(6);
});

test("snapshots: a failed re-pull keeps the active one (b); no active snapshot says when the next pull runs (31:7924); paused shows what changed (c)", async ({ page, baseURL }) => {
  const ids = await demoIds(baseURL);
  await page.goto(`/spaces/${ids.treasury}/sources/${ids.coreRtgs}`);
  const kept = page.getByText(/^Showing the active snapshot for .+; the re-pull at .+ failed\. .+ Nothing was replaced\.$/);
  await expect(kept).toBeVisible();
  expect((await kept.innerText()).match(/Nothing was replaced/g)).toHaveLength(1);
  await expect(page.getByText(/· Daily at 06:00 WIB$/)).toBeVisible(); // the schedule in words, not a cron
  // the Actions column is on screen at 1440 without scrolling the table
  const action = page.getByRole("button", { name: /^Pull \d{1,2} \w{3} again$/ }).first();
  await expect(action).toBeInViewport();
  const snaps = page.getByRole("table", { name: "Snapshots" });
  for (const s of ["Active", "Failed", "Superseded"]) await expect(snaps.getByText(s, { exact: true }).first()).toBeVisible();

  await page.goto(`/spaces/${ids.treasury}/sources/${ids.coreSknbi}`);
  const notice = page.getByText(/^No active snapshot for /);
  await expect(notice).toContainText(/The next scheduled pull is at .+ WIB\. Pull now to retry sooner\./);
  await expect(notice).not.toContainText(/retry (every|in) /); // phase 1 has no automatic retry interval

  await page.goto(`/spaces/${ids.treasury}/sources/${ids.glNostro}`);
  await expect(page.locator("p").filter({ hasText: /^Paused\. / })).toBeVisible();
  const drift = page.getByRole("table", { name: /Columns that no longer fit/ });
  await expect(drift.getByRole("row").filter({ hasText: "ref" }).first()).toContainText("Missing");
  // Task 7: no draft yet, so the button makes one from version 1 and opens the wizard at step 2 (source-wizard.spec covers the press)
  await expect(page.getByRole("button", { name: "Create a source version" })).not.toHaveAttribute("aria-disabled", "true");
  await expect(page.getByRole("button", { name: /^Pull / }).first()).toHaveAttribute("aria-disabled", "true");
});
});

test("Pull now: a source admin queues a run (pending, then a toast); an operator sees why it's off", async ({ page, browser, baseURL }) => {
  const ids = await demoIds(baseURL);
  const ctx = await browser.newContext({ storageState: AUTH_STATE, baseURL });
  const su = await ctx.newPage();
  try {
    await su.goto(`/spaces/${ids.treasury}/sources/${ids.bifastIn}`);
    await expect(su.getByText("The credential is stored encrypted and never shown")).toBeVisible();
    await expect(su.getByText("core-db.demo.invalid")).toHaveCount(0);
    await su.getByRole("button", { name: "Pull now", exact: true }).click();
    await expect(su.getByText(/^(Pull queued\. The source updates when it finishes\.|A pull was already waiting; it takes this one in\.)$/)).toBeVisible();
  } finally {
    await ctx.close();
  }
  await signIn(page, "viewer");
  await expect(page).toHaveURL("/");
  await page.goto(`/spaces/${ids.treasury}/sources/${ids.bifastIn}`);
  const pull = page.getByRole("button", { name: "Pull now", exact: true });
  await expect(pull).toHaveAttribute("aria-disabled", "true");
  await expect(pull).toHaveAccessibleDescription("Only a source admin of this space starts a pull.");
});

test("a source shared from another space is read-only there (h); a space.view holder who is no member gets a 404", async ({ page, browser, baseURL }) => {
  const ids = await demoIds(baseURL);
  const v = page;
  {
    await signIn(v, "viewer");
    await expect(v).toHaveURL("/");
    await v.goto(`/spaces/${ids.ctop}/sources`);
    const row = v.getByRole("table", { name: "Sources" }).locator("tbody").getByRole("row");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Shared from Treasury");
    await expect(row).toContainText("Read-only here · owned by Treasury");
    // ?tab=quarantine on a shared source shows the Overview, all of it rendered by the server: no /api read after load
    const reads: string[] = [];
    v.on("request", (r) => { if (new URL(r.url()).pathname.startsWith("/api/")) reads.push(new URL(r.url()).pathname); });
    await v.goto(`/spaces/${ids.ctop}/sources/${ids.biSettlement}?tab=quarantine`);
    await expect(v.getByRole("table", { name: "Files" }).getByRole("row").nth(1)).toBeVisible();
    await v.waitForLoadState("networkidle");
    expect(reads).toEqual([]);
    await v.goto(`/spaces/${ids.ctop}/sources`);
    await row.getByRole("link", { name: "BI settlement file" }).click();
    await expect(v.getByRole("heading", { level: 1, name: "BI settlement file" })).toBeVisible();
    await expect(v.getByLabel(/^Sources, page/)).toHaveCount(0); // the list's held copy has gone
    await expect(v.locator('[data-slot="category-chip"]').filter({ hasText: "Shared from Treasury" })).toBeVisible();
    await expect(v.getByText("Treasury owns this source.", { exact: false })).toBeVisible();
    await expect(v.getByRole("table", { name: "Files" }).getByRole("row").nth(1)).toBeVisible();
    await expect(v.getByRole("button", { name: /^Pull / })).toHaveCount(0);
    await expect(v.getByRole("link", { name: /^Quarantine/ })).toHaveCount(0);
  }
  // the Superadmin sees every space (space.view) but holds no role in CTOP: its sources are a member's data
  const ctx = await browser.newContext({ storageState: AUTH_STATE, baseURL });
  try {
    const res = await (await ctx.newPage()).goto(`/spaces/${ids.ctop}/sources`);
    expect(res?.status()).toBe(404);
  } finally {
    await ctx.close();
  }
});
