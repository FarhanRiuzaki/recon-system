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
    await db.unsafe(\`drop view if exists bifast_view; drop table if exists bifast_txn;
      create table bifast_txn (id bigint primary key, updated_at timestamptz not null, ref text not null, amount numeric(18,2) not null, note text);
      create view bifast_view as select id, ref from bifast_txn;
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
  // REC-F2b: Next is off with no sentence until the folder is checked
  await expect(next(page, "Next: fields & mapping")).toBeDisabled();

  await page.getByRole("textbox", { name: "Name", exact: true }).fill("KSEI ACT e2e");
  // the code follows the name until Edit
  await expect(page.getByText("Code: ksei-act-e2e")).toBeVisible();
  await page.getByRole("button", { name: "Edit code", exact: true }).click();
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(`ksei-act-${RUN}`);
  await page.getByRole("radio", { name: /File inbox/ }).check();
  // REC-F2b: the folder first (Enter checks it), then its pattern; leaving the pattern checks again
  await page.getByRole("textbox", { name: "Folder", exact: true }).fill(folder);
  await page.getByRole("textbox", { name: "Folder", exact: true }).press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Folder readable" })).toHaveText(/^Folder readable · 3 files · newest /);
  await page.getByRole("textbox", { name: "File name pattern", exact: true }).fill("act*.txt");
  await page.getByRole("textbox", { name: "File name pattern", exact: true }).press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Folder readable" })).toHaveText(/^Folder readable · 2 files match act\*\.txt · newest act2026110[23]\.txt$/);
  // a pass counts only for the values checked
  await page.getByRole("textbox", { name: "Folder", exact: true }).fill(`${folder}/`);
  await expect(next(page, "Next: fields & mapping")).toBeDisabled();
  await page.getByRole("textbox", { name: "Folder", exact: true }).fill(folder);
  // the test stored nothing: the source is made at Next
  expect((await (await page.request.get(`/api/spaces/${ids.fico}/sources?q=ksei-act-${RUN}`)).json() as { total: number }).total).toBe(0);
  await next(page, "Next: fields & mapping").click();

  await expect(page).toHaveURL(/step=2$/);
  await expect(page.getByRole("heading", { level: 2, name: /Fields & mapping/ })).toBeFocused();
  await page.getByRole("textbox", { name: "Sample", exact: true }).fill(KSEI);
  await page.getByRole("textbox", { name: "File name", exact: true }).fill("act20261102.txt");
  await page.getByRole("button", { name: "Read the sample" }).click();
  const columns = page.getByRole("table", { name: "Columns" });
  await expect(columns.locator("tbody tr")).toHaveCount(14);
  // eight digits that are real dates (20201015) are detected as a date read as yyyyMMdd, the format filled in
  await expect(columns.getByRole("combobox", { name: "Type of col_07", exact: true })).toHaveValue("date");
  await expect(columns.getByRole("textbox", { name: "Date format of col_07", exact: true })).toHaveValue("yyyyMMdd");
  await expect(page.getByRole("status").filter({ hasText: "rows read" })).toHaveText(/12 rows read: 11 become records, 1 go to quarantine/);
  // col_13 is the SID: never empty, the match key, stored as the account
  await columns.getByRole("checkbox", { name: "col_13 may be empty" }).click();
  await columns.getByRole("checkbox", { name: "col_13 is part of the match key" }).click();
  await page.getByRole("combobox", { name: "Account", exact: true }).selectOption("f:col_13");
  // a headerless file names its columns col_NN: col_13 is stored as attrs.sid (a name must be an identifier)
  const sidName = columns.getByRole("textbox", { name: "Stored name of col_13", exact: true });
  await expect(sidName).toHaveValue("col_13");
  await sidName.fill("SID");
  await expect(columns.getByRole("alert").filter({ hasText: "Use a-z, 0-9 and _, starting with a letter" })).toBeVisible();
  await sidName.fill("col_03");
  await expect(columns.getByText("Another column is stored as col_03. Use a different name.")).toBeVisible();
  await sidName.fill("sid");
  await expect(page.getByRole("status").filter({ hasText: "rows read" })).toHaveText(/12 rows read: 10 become records, 2 go to quarantine/);
  await expect(page.getByText("Row 11 · Expected 14 columns, got 13")).toBeVisible();
  await expect(page.getByRole("table", { name: "Preview records" }).getByRole("row").nth(1)).toContainText("sid=TSTSID000000001");
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
  // the maker can't decide on its own version: one line and the blocked Approve (Figma 98:9467), no comment field
  await expect(page.getByText("A config checker other than you approves or rejects this version.")).toBeVisible();
  await blockedWith(page, "Approve version 1", "You submitted this version. Another config checker approves it.");
  await expect(page.getByRole("textbox", { name: "Comment", exact: true })).toHaveCount(0);
});

test("a PostgreSQL watermark source: a failed test, then a pass without a database; pick the database and the table from the lists; a taken code; the suggested watermark and id, nullable ones refused; preview a pull on demand, submit", async ({ page, baseURL }) => {
  const ids = await demoIds(baseURL);
  const src = sourceDatabase();
  await page.goto(`/spaces/${ids.fico}/sources/new?step=1`);
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("BI-FAST core e2e");
  // the file source's code: taken, which shows on Code at Next, before anything is made
  await page.getByRole("button", { name: "Edit code", exact: true }).click();
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(`ksei-act-${RUN}`);
  await page.getByRole("radio", { name: /^Database/ }).check();
  // REC-F2b: a pasted connection string fills the fields (never sent); a database that isn't there is said on Database
  await page.getByRole("button", { name: "Paste a connection string", exact: true }).click();
  await page.getByRole("textbox", { name: "Connection string", exact: true }).fill(`postgresql://${src.username}@${src.hostname}:${src.port || "5432"}/recon_no_such_db`);
  await page.getByRole("textbox", { name: "Connection string", exact: true }).press("Enter");
  await expect(page.getByRole("textbox", { name: "Host", exact: true })).toHaveValue(src.hostname);
  await expect(page.getByRole("textbox", { name: "Username", exact: true })).toHaveValue(decodeURIComponent(src.username));
  // the local cluster trusts its users, so any password passes; the API still needs one. Enter in a field connects
  await page.getByLabel("Password", { exact: true }).fill(decodeURIComponent(src.password) || "trusted-cluster");
  await page.getByLabel("Password", { exact: true }).press("Enter");
  await expect(page.getByText("Database recon_no_such_db wasn't found. Check the name.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Database", exact: true })).toBeFocused();
  await expect(next(page, "Next: fields & mapping")).toBeDisabled();
  // REC-F2a: no database typed, the connect runs on `postgres`; Server folds into one line and Database is a list
  await page.getByRole("textbox", { name: "Database", exact: true }).fill("");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: /^PostgreSQL [\d.]+ · / })).toContainText(`${decodeURIComponent(src.username)}@${src.hostname}:${src.port || "5432"} · TLS`);
  const database = page.getByRole("button", { name: /^Database: / });
  await database.click();
  await page.getByPlaceholder("Search databases").fill(src.pathname.slice(1));
  await page.getByRole("option", { name: src.pathname.slice(1), exact: true }).click();
  // a database chosen is connected at once, so its tables list and Next counts the pass
  await expect(database).toHaveAccessibleName(`Database: ${src.pathname.slice(1)}`);

  // the table: the tables and views this login can SELECT, under their schema, each with its kind and column count
  const table = page.getByRole("button", { name: /^Table: / });
  await table.click();
  await expect(page.getByRole("group", { name: "public" })).toBeVisible();
  await expect(page.getByRole("option", { name: /^bifast_view/ })).toContainText("view · 2 columns");
  // a server search, debounced: no match says so
  await page.getByPlaceholder("Search tables").fill("nothing_like_it");
  await expect(page.getByText('No table matches "nothing_like_it".')).toBeVisible();
  await page.getByPlaceholder("Search tables").fill("txn");
  const txn = page.getByRole("option", { name: /^bifast_txn/ });
  await expect(txn).toContainText("table · 5 columns");
  await txn.click();
  await expect(table).toHaveAccessibleName(`Table: ${SRC_TABLE}`);
  await expect(page.getByText("5 columns read.")).toBeVisible();
  await next(page, "Next: fields & mapping").click();
  const code = page.getByRole("textbox", { name: "Code", exact: true });
  await expect(code).toBeFocused();
  await expect(page.getByText("Another source in this space already has this code. Use a different one.")).toBeVisible();
  await code.fill(`bifast-${RUN}`);
  await next(page, "Next: fields & mapping").click();

  // step 2: the columns read through the stored connection; the watermark and id come suggested (NOT NULL; the id a
  // primary key), and the picker still refuses a column that can be empty
  const wm = page.getByRole("combobox", { name: "Watermark column", exact: true });
  await expect(wm).toHaveValue("updated_at");
  await expect(page.getByText("Suggested", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Id column", exact: true })).toHaveValue("id");
  await expect(page.getByText("Suggested", { exact: true })).toHaveCount(2);
  await expect(wm.locator("option", { hasText: "note" })).toBeDisabled();
  await expect(wm.locator("option", { hasText: "note" })).toHaveText("note — can be empty");

  const columns = page.getByRole("table", { name: "Columns" });
  await expect(columns.locator("tbody tr")).toHaveCount(5);
  await expect(columns.getByRole("combobox", { name: "Type of amount", exact: true })).toHaveValue("decimal");
  await expect(columns.getByRole("combobox", { name: "Places of amount", exact: true })).toHaveValue("2");
  await page.getByRole("combobox", { name: "Business date", exact: true }).selectOption("f:updated_at");
  await page.getByRole("combobox", { name: "Amount", exact: true }).selectOption("f:amount");
  await page.getByRole("combobox", { name: "Reference", exact: true }).selectOption("f:ref");
  await columns.getByRole("checkbox", { name: "ref is part of the match key" }).click();
  // a database source previews on demand (it pulls from the bank's database); 100.5 becomes the whole number 10050
  const records = page.getByRole("table", { name: "Preview records" });
  await expect(records).toHaveCount(0);
  await page.getByRole("button", { name: "Preview rows", exact: true }).click();
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
    // sent back: no decision any more; the comment, and Edit version 1 (a checker may not edit: blocked with the reason)
    await expect(c.getByText("Sent back by Admin User: Name col_03 sre before it goes live.")).toBeVisible();
    await expect(c.getByText("Draft · sent back by Admin User", { exact: true })).toBeVisible();
    await expect(c.getByRole("button", { name: "Approve version 1", exact: true })).toHaveCount(0);
    await blockedWith(c, "Edit version 1", "Only a source admin or a config maker of this space changes a source.");

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
  // one sentence per event, never a hash
  for (const what of ["Admin User approved version 1.", "Super Admin submitted version 1.", "Super Admin edited version 1.", "Super Admin started version 1.", "Super Admin set the connection.", "Super Admin created the source."]) {
    await expect(activity.getByRole("row").filter({ hasText: what }).first()).toBeVisible();
  }
  await expect(activity).not.toContainText(/[0-9a-f]{64}/);
  // the credential is never recorded
  await expect(activity).not.toContainText(new URL(process.env.E2E_DB!).password || "never-empty-sentinel");
  // Edit source opens the wizard over a new draft
  await page.getByRole("button", { name: "Edit source", exact: true }).click();
  await expect(page).toHaveURL(/\/versions\/new\?step=2$/);
  await expect(page.getByRole("heading", { level: 1, name: "Edit BI-FAST core e2e" })).toBeVisible();
  // a saved draft reads its table's columns again through the stored connection
  await page.getByRole("button", { name: "Read the columns again", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "columns read" })).toHaveText("5 columns read: id, updated_at, ref, amount, note.");
});

test("a source admin's sent-back version opens in the wizard; a draft source nobody submitted can be deleted", async ({ page, baseURL }) => {
  test.skip(!fileVersion, "needs the file version sent back above");
  const ids = await demoIds(baseURL);
  await page.goto(`/spaces/${ids.fico}/sources/${fileSource}?tab=versions`);
  const row = page.getByRole("table", { name: "Versions" }).getByRole("row").filter({ hasText: "Version 1" });
  await expect(row).toContainText("Sent back");
  await expect(row).toContainText("Sent back by Admin User");
  await page.goto(`/spaces/${ids.fico}/sources/${fileSource}/versions/${fileVersion}`);
  await page.getByRole("link", { name: "Edit version 1", exact: true }).click();
  await expect(page).toHaveURL(/\/versions\/new\?step=1$/);
  await expect(page.getByRole("heading", { level: 1, name: "Edit KSEI ACT e2e" })).toBeVisible();
  // it was submitted once, so it has a history: no Delete draft source
  await expect(page.getByRole("button", { name: "Delete draft source" })).toHaveCount(0);

  // a new source made at Next and never submitted: deleted from the wizard
  const folder = path.join(INBOX, "ksei");
  await page.goto(`/spaces/${ids.fico}/sources/new?step=1`);
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Throwaway e2e");
  await page.getByRole("button", { name: "Edit code", exact: true }).click();
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(`throwaway-${RUN}`);
  // a new source opens on Database, the common case
  await page.getByRole("radio", { name: /File inbox/ }).check();
  await page.getByRole("textbox", { name: "Folder", exact: true }).fill(folder);
  await page.getByRole("button", { name: "Check folder" }).click();
  await page.getByRole("textbox", { name: "File name pattern", exact: true }).fill("act*.txt");
  await page.getByRole("textbox", { name: "File name pattern", exact: true }).press("Enter");
  await expect(next(page, "Next: fields & mapping")).toBeEnabled();
  await next(page, "Next: fields & mapping").click();
  await expect(page).toHaveURL(/step=2$/);
  await page.getByRole("button", { name: "Delete draft source", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete this draft source?" });
  await expect(dialog).toContainText("Throwaway e2e was never submitted, so nothing was pulled or ingested. Its connection and draft settings are removed. This can't be undone.");
  await dialog.getByRole("button", { name: "Delete draft source", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/spaces/${ids.fico}/sources$`));
  await expect(page.getByText("Deleted the draft source Throwaway e2e.")).toBeVisible();
  expect((await (await page.request.get(`/api/spaces/${ids.fico}/sources?q=throwaway-${RUN}`)).json() as { total: number }).total).toBe(0);
});
