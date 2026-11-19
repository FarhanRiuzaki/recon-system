import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { AUTH_STATE, INBOX } from "./global-setup";
import { csrfOf, demoIds, signIn } from "./helpers";

/**
 * The source wizard, versions and approval (Task 7; Figma page 02, Build notes 02) on the demo seed, in FICO, so the
 * Treasury sources other specs count stay as seeded: the global-setup Superadmin is made a source admin of FICO for
 * this file (it makes the sources and submits their versions), the demo `admin` user a config checker for the
 * approvals; both memberships are removed again. The file source reads INBOX (the E2E API's INBOX_ROOTS); the database
 * source reads a table in `<e2e database>_src` on the same server. Desktop only.
 */
test.use({ storageState: AUTH_STATE });
test.describe.configure({ mode: "serial" });

const sid = (n: number) => `TSTSID0000000${String(n).padStart(2, "0")}`;
const line = (n: number, id = sid(n)) => ["ACT", "KSEI", `TSTSRE${String(n).padStart(4, "0")}`, "TSTCUST001", "IND", "01", "20201015", "A", "Y", "IDR", "", "TSTBRK01", id, "N"].join("|");
/** docs/recon/ksei-sample-data.md, day D: 10 good lines, one with 13 columns, one with an empty SID. */
const KSEI = [...Array.from({ length: 10 }, (_, i) => line(i + 1)), line(11).split("|").slice(0, 13).join("|"), line(12, "")].join("\n") + "\n";

const SRC_TABLE = "public.bifast_txn";
/** `<e2e database>_src` with a BI-FAST-like table (created once; the E2E database name ends in _e2e). */
function sourceDatabase(): URL {
  const e2e = new URL(process.env.E2E_DB!);
  if (!e2e.pathname.endsWith("_e2e")) throw new Error("E2E_DB must be the E2E database.");
  const src = new URL(e2e.href);
  src.pathname += "_src";
  const script = `
    const admin = new Bun.SQL(process.env.E2E_DB);
    const [{ n }] = await admin\`select count(*)::int as n from pg_database where datname = \${process.env.SRC_NAME}\`;
    if (!n) await admin.unsafe('create database "' + process.env.SRC_NAME + '"');
    await admin.close();
    const db = new Bun.SQL(process.env.SRC_DB);
    await db.unsafe(\`drop table if exists bifast_txn;
      create table bifast_txn (id bigint primary key, updated_at timestamptz not null, ref text not null, amount numeric(18,2) not null, note text);
      insert into bifast_txn values (1, '2026-11-02 01:00:00+00', 'BF001', 100.5, null), (2, '2026-11-02 02:00:00+00', 'BF002', 7, 'x');\`);
    await db.close();`;
  execFileSync("bun", ["-e", script], { env: { ...process.env, SRC_DB: src.href, SRC_NAME: src.pathname.slice(1) }, stdio: "inherit" });
  return src;
}

const next = (page: Page, name: RegExp | string) => page.getByRole("button", { name, exact: typeof name === "string" });
/** A BlockedButton's reason is its description. */
const blockedWith = async (page: Page, name: string, reason: string) => {
  const b = page.getByRole("button", { name, exact: true });
  await expect(b).toHaveAttribute("aria-disabled", "true");
  await expect(b).toHaveAccessibleDescription(reason);
};

let fileVersion = "", fileSource = "", dbVersion = "", dbSource = "";

/** `user` as a member of FICO with `roles` through the members API (the Superadmin holds space.manage); null removes them. */
async function member(browser: Browser, baseURL: string | undefined, user: "superadmin" | "admin", roles: string[] | null) {
  const ids = await demoIds(baseURL);
  const ctx = await browser.newContext({ baseURL, storageState: AUTH_STATE });
  const page = await ctx.newPage();
  await page.goto("/");
  const headers = { "x-csrf-token": await csrfOf(page) };
  const url = `/api/spaces/${ids.fico}/members/${ids[user]}`;
  const r = roles ? await page.request.put(url, { headers, data: { roles } }) : await page.request.delete(url, { headers });
  await ctx.close();
  if (roles) expect(r.status()).toBe(200);
}
test.beforeAll(async ({ browser, baseURL }) => { await member(browser, baseURL, "superadmin", ["source_admin"]); });
test.afterAll(async ({ browser, baseURL }) => {
  await member(browser, baseURL, "admin", null);
  await member(browser, baseURL, "superadmin", null);
});
/** Codes are unique per space: a run's own suffix lets the spec run again on a database it already used (E2E_REUSE). */
const RUN = Date.now().toString(36);

test("a file inbox source, KSEI-like: test the folder, read a sample, type the columns with a live preview, submit", async ({ page, baseURL }) => {
  const ids = await demoIds(baseURL);
  const folder = path.join(INBOX, "ksei");
  mkdirSync(folder, { recursive: true });
  for (const f of ["act20261102.txt", "act20261103.txt", "summary.pdf"]) writeFileSync(path.join(folder, f), KSEI);

  await page.goto(`/spaces/${ids.fico}/sources`);
  await page.getByRole("link", { name: "New source", exact: true }).click();
  await expect(page).toHaveURL(/\/sources\/new\?step=1$/);
  await expect(page.getByRole("heading", { level: 1, name: "New source" })).toBeVisible();
  await blockedWith(page, "Next: fields & mapping", "Test the folder first; files are picked up from it.");

  await page.getByRole("textbox", { name: "Name", exact: true }).fill("KSEI ACT e2e");
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(`ksei-act-${RUN}`);
  await page.getByRole("radio", { name: /File inbox/ }).check();
  await page.getByRole("textbox", { name: "Folder", exact: true }).fill(folder);
  await page.getByRole("textbox", { name: "File name pattern", exact: true }).fill("act*.txt");
  await page.getByRole("button", { name: "Test the folder" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Folder readable" })).toHaveText("Folder readable · 2 files match act*.txt");
  // a pass counts only for the values tested
  await page.getByRole("textbox", { name: "Folder", exact: true }).fill(`${folder}/`);
  await blockedWith(page, "Next: fields & mapping", "The connection changed since the last test. Test it again.");
  await page.getByRole("textbox", { name: "Folder", exact: true }).fill(folder);
  await next(page, "Next: fields & mapping").click();

  await expect(page).toHaveURL(/step=2$/);
  await expect(page.getByRole("heading", { level: 2, name: /Fields & mapping/ })).toBeFocused();
  await page.getByRole("textbox", { name: "Sample", exact: true }).fill(KSEI);
  await page.getByRole("textbox", { name: "File name", exact: true }).fill("act20261102.txt");
  await page.getByRole("button", { name: "Read the sample" }).click();
  const columns = page.getByRole("table", { name: "Columns" });
  await expect(columns.locator("tbody tr")).toHaveCount(14);
  // the preview guesses col_07 (20201015) as a whole number; the user corrects it to a date read as yyyyMMdd
  await expect(columns.getByRole("combobox", { name: "Type of col_07", exact: true })).toHaveValue("integer");
  await columns.getByRole("combobox", { name: "Type of col_07", exact: true }).selectOption("date");
  await columns.getByRole("textbox", { name: "Date format of col_07", exact: true }).fill("yyyyMMdd");
  await expect(page.getByRole("status").filter({ hasText: "rows read" })).toHaveText(/12 rows read: 11 become records, 1 go to quarantine/);
  // col_13 is the SID: never empty, the match key, stored as the account
  await columns.getByRole("checkbox", { name: "col_13 may be empty" }).click();
  await columns.getByRole("checkbox", { name: "col_13 is part of the match key" }).click();
  await page.getByRole("combobox", { name: "Account", exact: true }).selectOption("f:col_13");
  await expect(page.getByRole("status").filter({ hasText: "rows read" })).toHaveText(/12 rows read: 10 become records, 2 go to quarantine/);
  await expect(page.getByText("Row 11 · Expected 14 columns, got 13")).toBeVisible();
  await expect(page.getByText(/Row 12 · col_13 is required/)).toBeVisible();
  // a refused field is named on the field: a time zone the runtime doesn't know
  await columns.getByRole("combobox", { name: "Type of col_04", exact: true }).selectOption("datetime");
  await columns.getByRole("textbox", { name: "Time zone of col_04", exact: true }).fill("Mars/Olympus");
  await expect(columns.getByRole("alert").filter({ hasText: "Unknown time zone" })).toBeVisible();
  await columns.getByRole("combobox", { name: "Type of col_04", exact: true }).selectOption("string");
  await expect(page.getByRole("status").filter({ hasText: "rows read" })).toHaveText(/10 become records/);

  await next(page, "Next: review").click();
  await expect(page).toHaveURL(/step=3$/);
  const checks = page.getByRole("table", { name: "Ready to submit" });
  await expect(checks.getByRole("row").filter({ hasText: "Match key" })).toContainText("Ready");
  await expect(checks.getByRole("row").filter({ hasText: "Preview" })).toContainText(/Check.*rows 11, 12 would be quarantined/);
  await next(page, "Submit for approval").click();
  await expect(page).toHaveURL(/\/versions\/[0-9a-f-]{36}$/);
  fileVersion = page.url().split("/").at(-1)!;
  fileSource = page.url().split("/sources/")[1]!.split("/")[0]!;
  await expect(page.getByRole("heading", { level: 1, name: "KSEI ACT e2e · version 1" })).toBeVisible();
  // the maker can't decide on its own version
  await blockedWith(page, "Approve version 1", "You submitted this version. Another config checker approves it.");
  await blockedWith(page, "Reject", "You submitted this version. Another config checker rejects it.");
});

test("a PostgreSQL watermark source: a failed test, then a pass; read the table, refuse nullable watermark columns, preview a pull, submit", async ({ page, baseURL }) => {
  const ids = await demoIds(baseURL);
  const src = sourceDatabase();
  await page.goto(`/spaces/${ids.fico}/sources/new?step=1`);
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("BI-FAST core e2e");
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(`bifast-${RUN}`);
  await page.getByRole("radio", { name: /^Database/ }).check();
  await page.getByRole("textbox", { name: "Host", exact: true }).fill(src.hostname);
  await page.getByRole("textbox", { name: "Port", exact: true }).fill(src.port || "5432");
  // a database that isn't there: the API's sentence with the driver's code, and Next stays blocked
  await page.getByRole("textbox", { name: "Database", exact: true }).fill("recon_no_such_db");
  await page.getByRole("textbox", { name: "Username", exact: true }).fill(decodeURIComponent(src.username));
  // the local cluster trusts its users, so any password passes; the API still needs one
  await page.getByLabel("Password", { exact: true }).fill(decodeURIComponent(src.password) || "trusted-cluster");
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByRole("status").filter({ hasText: "database" })).toHaveText("The database was not found (3D000). Check the database name.");
  await blockedWith(page, "Next: fields & mapping", "Test the connection first; step 2 reads the columns through it.");
  await page.getByRole("textbox", { name: "Database", exact: true }).fill(src.pathname.slice(1));
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Connected." })).toHaveText("Connected.");

  await page.getByRole("textbox", { name: "Table", exact: true }).fill(SRC_TABLE);
  await page.getByRole("button", { name: "Read the columns" }).click();
  const wm = page.getByRole("combobox", { name: "Watermark column", exact: true });
  await expect(wm.locator("option", { hasText: "note" })).toBeDisabled();
  await expect(wm.locator("option", { hasText: "note" })).toHaveText("note — This column can be empty; rows with no value would never be pulled.");
  await wm.selectOption("updated_at");
  await page.getByRole("combobox", { name: "Id column", exact: true }).selectOption("id");
  await next(page, "Next: fields & mapping").click();

  const columns = page.getByRole("table", { name: "Columns" });
  await expect(columns.locator("tbody tr")).toHaveCount(5);
  await expect(columns.getByRole("combobox", { name: "Type of amount", exact: true })).toHaveValue("decimal");
  await expect(columns.getByRole("combobox", { name: "Places of amount", exact: true })).toHaveValue("2");
  await page.getByRole("combobox", { name: "Business date", exact: true }).selectOption("f:updated_at");
  await page.getByRole("combobox", { name: "Amount", exact: true }).selectOption("f:amount");
  await page.getByRole("combobox", { name: "Reference", exact: true }).selectOption("f:ref");
  await columns.getByRole("checkbox", { name: "ref is part of the match key" }).click();
  // 100.5 is stored as the whole number 10050: decimals never pass through a float
  const records = page.getByRole("table", { name: "Preview records" });
  await expect(records.getByRole("row").filter({ hasText: "BF001" })).toContainText("10050");
  await expect(records.getByRole("row").filter({ hasText: "BF002" })).toContainText("700");
  await next(page, "Next: review").click();
  await next(page, "Submit for approval").click();
  await expect(page).toHaveURL(/\/versions\/[0-9a-f-]{36}$/);
  dbVersion = page.url().split("/").at(-1)!;
  dbSource = page.url().split("/sources/")[1]!.split("/")[0]!;
  await expect(page.getByRole("table", { name: "Changes" })).toContainText("Decimal, 2 places");
});

/** `admin` as a config checker of FICO for `fn` (removed again in afterAll), in a browser of its own. */
async function asChecker(browser: Browser, baseURL: string | undefined, fn: (checker: Page) => Promise<void>) {
  await member(browser, baseURL, "admin", ["config_checker"]);
  const ctx = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } }); // not the Superadmin's session
  try {
    const checker = await ctx.newPage();
    await signIn(checker, "admin");
    await expect(checker).not.toHaveURL(/\/login/);
    await fn(checker);
  } finally {
    await ctx.close();
  }
}

test("a config checker rejects with a comment (required) and approves; the decision is a toast and focus goes to the heading", async ({ browser, baseURL }) => {
  test.skip(!fileVersion || !dbVersion, "needs the two versions submitted above");
  const ids = await demoIds(baseURL);
  await asChecker(browser, baseURL, async (c) => {
    await c.goto(`/spaces/${ids.fico}/sources/${fileSource}/versions/${fileVersion}`);
    await c.getByRole("button", { name: "Reject", exact: true }).click();
    const comment = c.getByRole("textbox", { name: "Comment", exact: true });
    await expect(comment).toBeFocused();
    await expect(c.getByText("Enter a comment to reject: say what the maker should change.")).toBeVisible();
    await comment.fill("Name col_03 sre before it goes live.");
    await c.getByRole("button", { name: "Reject", exact: true }).click();
    await expect(c.getByText(/sent back to its maker with your comment/)).toBeVisible();
    await expect(c.getByRole("heading", { level: 1 })).toBeFocused();
    await blockedWith(c, "Approve version 1", "This version is no longer waiting for approval.");
    await expect(c.getByText("Sent back by a config checker: Name col_03 sre before it goes live.")).toBeVisible();

    await c.goto(`/spaces/${ids.fico}/sources/${dbSource}/versions/${dbVersion}`);
    await c.getByRole("button", { name: "Approve version 1", exact: true }).click();
    await expect(c.getByText("Version 1 of BI-FAST core e2e approved. It is in use from the next run.")).toBeVisible();
    await expect(c.getByRole("heading", { level: 1 })).toBeFocused();
    await expect(c.getByRole("heading", { level: 1 }).locator("xpath=..")).toContainText("Published");
  });
});

test("the source's Versions and Activity tabs: server-paged, state chips, every version step", async ({ page, baseURL }) => {
  test.skip(!dbSource, "needs the database source above");
  const ids = await demoIds(baseURL);
  await page.goto(`/spaces/${ids.fico}/sources/${dbSource}`);
  await page.getByRole("link", { name: "Versions", exact: true }).click();
  await expect(page).toHaveURL(/tab=versions/);
  const versions = page.getByRole("table", { name: "Versions" });
  await expect(versions.getByRole("row").filter({ hasText: "Version 1" })).toContainText("Published");
  await page.getByRole("link", { name: "Activity", exact: true }).click();
  await expect(page).toHaveURL(/tab=activity/);
  const activity = page.getByRole("table", { name: "Activity" });
  for (const what of ["Source version approved", "Source version submitted", "Source version edited", "Source version drafted", "Source connection set", "Source created"]) {
    await expect(activity.getByRole("row").filter({ hasText: what }).first()).toBeVisible();
  }
  // the credential is never recorded
  await expect(activity).not.toContainText(new URL(process.env.E2E_DB!).password || "never-empty-sentinel");
  // Edit source opens the wizard over a new draft
  await page.getByRole("button", { name: "Edit source", exact: true }).click();
  await expect(page).toHaveURL(/\/versions\/new\?step=2$/);
  await expect(page.getByRole("heading", { level: 1, name: "Edit BI-FAST core e2e" })).toBeVisible();
});
