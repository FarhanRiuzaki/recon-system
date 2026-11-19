import { execFileSync } from "node:child_process";
import { expect, type Page, test } from "@playwright/test";
import { AUTH_STATE } from "./global-setup";
import { signIn } from "./helpers";

/**
 * Runs `sql` on the E2E database (playwright.config.ts `E2E_DB`), as helpers.ts `ageReauth` does; refused unless its
 * name ends in `_e2e`. One transaction per call. Used to empty the spaces table for a test and put the demo spaces
 * back after it.
 */
function e2eSql(sql: string) {
  const db = URL.parse(process.env.E2E_DB ?? "");
  if (!db?.pathname.endsWith("_e2e")) throw new Error("e2eSql runs only against the E2E database (E2E_DB, name ending in _e2e).");
  execFileSync("bun", ["-e", "const db = new Bun.SQL(process.env.E2E_DB); await db.begin((tx) => tx.unsafe(process.env.E2E_SQL)); await db.close();"],
    { env: { ...process.env, E2E_SQL: sql }, stdio: "inherit" });
}

/** The demo spaces' ids by code, read as the global-setup Superadmin (space.view lists every space). */
async function spaceIds(browser: import("@playwright/test").Browser, baseURL: string | undefined): Promise<Record<string, string>> {
  const su = await browser.newContext({ storageState: AUTH_STATE, baseURL });
  const r = await su.request.get("/api/spaces?pageSize=100");
  expect(r.status()).toBe(200);
  const out = Object.fromEntries(((await r.json()) as { items: { id: string; code: string }[] }).items.map((s) => [s.code, s.id]));
  await su.close();
  return out;
}
const membersOf = (id: string) => new RegExp(`/spaces/${id}/members$`);
const trigger = (page: Page) => page.getByRole("complementary", { name: "Main navigation" }).getByRole("button", { name: /, switch space$/ });

/**
 * Demo seed: `viewer` belongs to Treasury and CTOP (not FICO), `google` to no space. The members page itself is Plan 1b
 * Task 4, so these check the URL the switcher and /spaces open, not that page's content.
 */
test("a member of two spaces switches by mouse and keyboard; /spaces skips a remembered space they can't open", async ({ page, browser, baseURL }) => {
  const ids = await spaceIds(browser, baseURL);
  await signIn(page, "viewer");
  await expect(page).toHaveURL("/");

  // No remembered space: the first by name (CTOP), with the viewer's roles there.
  const button = trigger(page);
  await expect(button).toHaveAccessibleName("CTOP, switch space");
  await expect(button).toHaveAttribute("aria-haspopup", "menu");
  await button.click();
  const menu = page.getByRole("menu");
  await expect(menu.getByText("Switch space")).toBeVisible();
  await expect(menu.getByRole("menuitemradio")).toHaveCount(2);
  await expect(menu.getByRole("menuitemradio", { name: /CTOP/ })).toHaveAttribute("aria-checked", "true");
  await expect(menu.getByRole("menuitemradio", { name: /Treasury/ })).toContainText("Config maker, Operator");
  await expect(menu.getByText("The space you pick opens next time you sign in. Ask a space admin to join another space.")).toBeVisible();
  await expect(menu.getByRole("textbox", { name: "Find a space" })).toHaveCount(0); // under 5 spaces: no search
  await menu.getByRole("menuitemradio", { name: /Treasury/ }).click();
  await expect(page).toHaveURL(membersOf(ids.treasury!));
  // Until the members route exists (Task 4) that URL is the app's 404, outside the shell: come back to a shell page,
  // where the switcher now shows the remembered space.
  await page.goto("/");
  await expect(button).toHaveAccessibleName("Treasury, switch space");

  // Keyboard: Enter opens on the first item, arrows move, Enter switches; Escape closes and focus returns to the trigger.
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitemradio").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(button).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitemradio", { name: /CTOP/ })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitemradio", { name: /Treasury/ })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("menuitemradio", { name: /CTOP/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(membersOf(ids.ctop!)); // the same page (members) in the other space

  // The switch was remembered: /spaces opens CTOP again.
  await page.goto("/spaces");
  await expect(page).toHaveURL(membersOf(ids.ctop!));

  // A remembered space the viewer can't open (FICO, or one that no longer exists) → their first space instead.
  for (const stale of [ids.fico!, "0199f0a0-0000-7000-8000-0000000000ff"]) {
    await page.context().addCookies([{ name: "sk_prefs", value: encodeURIComponent(`sidebar=expanded&space=${stale}`), url: baseURL! }]);
    await page.goto("/spaces");
    await expect(page).toHaveURL(membersOf(ids.ctop!));
  }
});

test("a user without a space sees who adds them and their username, and no switcher", async ({ page }) => {
  await page.goto("/api/auth/oauth/google"); // the mock provider: no password sign-in, spares the rate limit
  await expect(page).toHaveURL("/");
  await expect(trigger(page)).toHaveCount(0);
  await page.goto("/spaces");
  await expect(page).toHaveURL(/\/spaces$/);
  await expect(page.getByRole("heading", { level: 1, name: "You're not a member of any space yet" })).toBeVisible();
  await expect(page.getByText("Send them your username:")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy username" })).toBeVisible();
  await expect(page.getByText("google", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create space" })).toHaveCount(0); // no space.manage
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
});

/**
 * A holder of space.manage sees every space (space.manage implies space.view), so "Create space" shows only while the
 * app has no space at all: the demo spaces are set aside for this test and restored after it.
 */
test("with no space in the app, a space.manage holder creates one: checks, a taken code, then the new space's members", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ storageState: AUTH_STATE, baseURL });
  const page = await ctx.newPage();
  try {
    // One transaction (e2eSql): the copies exist exactly when the table was emptied. A copy left by an earlier failed
    // run is kept (it holds the demo spaces), not overwritten with an empty table.
    e2eSql(`create table if not exists e2e_spaces_kept as select * from spaces;
      create table if not exists e2e_members_kept as select * from space_members; delete from spaces;`);
    await page.goto("/spaces");
    await expect(page.getByRole("heading", { level: 1, name: "You're not a member of any space yet" })).toBeVisible();
    e2eSql("insert into spaces (id, code, name) values (gen_random_uuid(), 'e2e-taken', 'Taken')"); // for the duplicate case

    await page.getByRole("button", { name: "Create space" }).click();
    const dialog = page.getByRole("dialog", { name: "Create space" });
    const code = dialog.getByRole("textbox", { name: "Code" });
    const name = dialog.getByRole("textbox", { name: "Name" });
    await dialog.getByRole("button", { name: "Create space" }).click();
    await expect(code).toBeFocused();
    await expect(dialog.getByText("Enter a code.")).toBeVisible();
    await expect(dialog.getByText("Enter a name.")).toBeVisible();

    await code.fill("x");
    await name.fill("   ");
    await dialog.getByRole("button", { name: "Create space" }).click();
    await expect(code).toBeFocused();
    await expect(dialog.getByText("Use 2 to 32 letters, digits or hyphens.")).toBeVisible();
    await expect(dialog.getByText("Enter a name.")).toBeVisible();

    await code.fill("E2E-Taken"); // any case: the code is unique ignoring it
    await name.fill("E2E operations");
    await dialog.getByRole("button", { name: "Create space" }).click();
    await expect(dialog.getByRole("alert").filter({ hasText: "Another space already has this code. Use a different one." })).toBeVisible();
    await expect(code).toBeFocused();

    await code.fill(" E2E-Ops ");
    await dialog.getByRole("button", { name: "Create space" }).click();
    await expect(page).toHaveURL(/\/spaces\/[0-9a-f-]{36}\/members$/);
    // The "Created …" toast lives in the shell; the members route is the root 404 until Task 4, so the API is checked.
    const made = (await (await page.request.get("/api/spaces?pageSize=100&q=e2e-ops")).json()) as { items: { code: string }[] };
    expect(made.items.map((s) => s.code)).toEqual(["e2e-ops"]);
  } finally {
    await ctx.close();
    // Restores only when the setup got as far as the copies; runs however far the test got.
    e2eSql(`do $$ begin if to_regclass('e2e_spaces_kept') is not null and to_regclass('e2e_members_kept') is not null then
      delete from spaces; insert into spaces select * from e2e_spaces_kept; insert into space_members select * from e2e_members_kept;
      drop table e2e_spaces_kept; drop table e2e_members_kept; end if; end $$;`);
  }
});
