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

/** Demo seed: `viewer` belongs to Treasury (Operator, Config maker) and CTOP (Viewer), not FICO; `google` to no space. */
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
  await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
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
    await expect(page.getByText("Created E2E operations.")).toBeVisible();
    await expect(page.getByText("People who can work in the E2E operations space and what each of them may do. A person can hold several roles.")).toBeVisible();
    // A new space has no member yet: its creator holds space.manage, not a role in it.
    await expect(page.getByText("No members yet")).toBeVisible();
  } finally {
    await ctx.close();
    // Restores only when the setup got as far as the copies; runs however far the test got.
    e2eSql(`do $$ begin if to_regclass('e2e_spaces_kept') is not null and to_regclass('e2e_members_kept') is not null then
      delete from spaces; insert into spaces select * from e2e_spaces_kept; insert into space_members select * from e2e_members_kept;
      drop table e2e_spaces_kept; drop table e2e_members_kept; end if; end $$;`);
  }
});

test("a member sees who is in the space and what each role may do; a viewer only reads; a non-member gets a 404 that names no space", async ({ page, browser, baseURL }) => {
  const ids = await spaceIds(browser, baseURL);
  await signIn(page, "viewer");
  await expect(page).toHaveURL("/");
  await page.goto(`/spaces/${ids.treasury}/members`);
  await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
  await expect(page).toHaveTitle(/^Treasury\b/);
  await expect(page.getByText("People who can work in the Treasury space and what each of them may do. A person can hold several roles.")).toBeVisible();

  const table = page.getByRole("table", { name: "Members" });
  await expect(table.getByRole("columnheader")).toHaveText(["Member", "Roles in this space", "Status", "Username", "Last sign-in", "Actions"]);
  const me = table.getByRole("row").filter({ hasText: "Viewer User" });
  await expect(me.getByRole("cell").nth(1).locator('[data-slot="category-chip"]')).toHaveText(["Config maker", "Operator"]); // one chip per role, SPACE_ROLES order
  await expect(me.getByRole("cell").nth(2)).toContainText("Active");
  await expect(me.getByRole("cell").nth(3)).toContainText("viewer");
  await expect(table.locator("tbody").getByRole("row")).toHaveCount(4); // the seed's Treasury members

  // A viewer (no space admin role, no space.manage): no Add member; the row menu holds only View activity (audit.view).
  await expect(page.getByRole("button", { name: "Add member" })).toHaveCount(0);
  await me.getByRole("button", { name: "Actions for Viewer User" }).click();
  await expect(page.getByRole("menuitem")).toHaveText(["View activity"]);
  await page.getByRole("menuitem", { name: "View activity" }).click();
  await expect(page).toHaveURL(/\/audit\/activity\?range=90d&actorId=[0-9a-f-]{36}$/);
  await page.goBack();

  const matrix = page.getByRole("table", { name: "What each role can do" });
  await expect(matrix.getByRole("columnheader")).toHaveText(["Action", "Space admin", "Source admin", "Config maker", "Config checker", "Operator", "Reviewer", "Viewer"]);
  await expect(matrix.getByRole("row", { name: /^Force match outside tolerance/ }).getByRole("cell")).toHaveText(
    ["—Not allowed", "—Not allowed", "—Not allowed", "—Not allowed", "Does", "Approves", "—Not allowed"]);
  await expect(page.locator("#content").getByText("Source admin is granted and removed only by an app admin, not by a space admin.")).toBeVisible();

  // FICO: not a member. A real 404 on the document load (the layout checks membership before streaming), "Page not
  // found" inside the shell, and neither the answer nor the tab names the space.
  const res = await page.goto(`/spaces/${ids.fico}/members`);
  expect(res!.status()).toBe(404);
  expect(await res!.text()).not.toContain("FICO");
  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
  await expect(page).toHaveTitle(/^Page not found\b/);
  expect(await page.content()).not.toContain("FICO");
  // An id that is no space, and one that is not a UUID: the same 404.
  for (const id of ["0199f0a0-0000-7000-8000-0000000000ff", "nope"]) {
    expect((await page.goto(`/spaces/${id}/members`))!.status(), id).toBe(404);
    await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
  }
});

/**
 * Demo seed: FICO's only space admin is a generated user (no space.manage), its other member a generated Operator +
 * Viewer. The space admin adds `viewer` with two roles, changes them, can't leave them empty, removes them; their own
 * row can't be removed and their Space admin role is locked. The test leaves FICO as the seed made it.
 */
test("a space admin adds a member, changes their roles and removes them; the last space admin is kept", async ({ page, browser, baseURL }) => {
  const ids = await spaceIds(browser, baseURL);
  const su = await browser.newContext({ storageState: AUTH_STATE, baseURL });
  const r = await su.request.get(`/api/spaces/${ids.fico}/members?pageSize=100`);
  const members = ((await r.json()) as { items: { name: string; username: string; roles: string[] }[] }).items;
  await su.close();
  const admin = members.find((m) => m.roles.includes("space_admin"))!;
  const other = members.find((m) => m !== admin)!;

  await signIn(page, admin.username);
  await expect(page).toHaveURL("/");
  await page.goto(`/spaces/${ids.fico}/members`);
  const table = page.getByRole("table", { name: "Members" });
  const row = (name: string) => table.getByRole("row").filter({ hasText: name });
  const chips = (name: string) => row(name).getByRole("cell").nth(1).locator('[data-slot="category-chip"]');

  // Add member: the person and at least one role; members are marked and can't be picked; Source admin is an app admin's.
  await page.getByRole("button", { name: "Add member" }).click();
  let dialog = page.getByRole("dialog", { name: "Add a member to FICO" });
  await expect(dialog.getByText("People sign in with their bank directory account. Only people who have signed in once can be found.")).toBeVisible();
  const add = dialog.getByRole("button", { name: "Add member" });
  await expect(add).toBeDisabled();
  const sourceAdmin = dialog.getByRole("checkbox", { name: "Source admin" });
  await expect(sourceAdmin).toHaveAttribute("aria-readonly", "true");
  await expect(sourceAdmin).toHaveAccessibleDescription("Only an app admin can grant or remove Source admin.");
  await expect(dialog.locator("label").getByText("Only an app admin can grant or remove Source admin.")).toBeVisible();
  const person = dialog.getByRole("combobox", { name: "Person" });
  await person.fill(other.name);
  await expect(dialog.getByRole("option").filter({ hasText: `${other.username} (already a member)` }).first()).toHaveAttribute("aria-disabled", "true");
  await person.fill("Viewer User");
  await dialog.getByRole("option").filter({ hasText: "Viewer User" }).click();
  await expect(add).toBeDisabled(); // no role yet
  await dialog.getByRole("checkbox", { name: "Operator", exact: true }).click();
  await dialog.getByRole("checkbox", { name: "Reviewer", exact: true }).click();
  await add.click();
  await expect(page.getByText("Added Viewer User to FICO.")).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add member" })).toBeFocused();
  await expect(chips("Viewer User")).toHaveText(["Operator", "Reviewer"]);

  // Change roles: Save roles waits for a change; an empty set says how to remove instead.
  await row("Viewer User").getByRole("button", { name: "Actions for Viewer User" }).click();
  await expect(page.getByRole("menuitem")).toHaveText(["View activity", "Change roles", "Remove from space"]);
  await page.getByRole("menuitem", { name: "Change roles" }).click();
  dialog = page.getByRole("dialog", { name: "Change roles for Viewer User" });
  await expect(dialog.getByText("Roles apply to the FICO space only.")).toBeVisible();
  const save = dialog.getByRole("button", { name: "Save roles" });
  await expect(save).toBeDisabled();
  await dialog.getByRole("checkbox", { name: "Operator", exact: true }).click();
  await dialog.getByRole("checkbox", { name: "Reviewer", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Pick at least one role. To take Viewer User out of this space, use Remove from space.");
  await expect(save).toBeDisabled();
  await dialog.getByRole("checkbox", { name: "Viewer", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await save.click();
  await expect(page.getByText("Changed the roles of Viewer User.")).toBeVisible();
  await expect(chips("Viewer User")).toHaveText(["Viewer"]);

  // Remove from space: destructive confirm, no break or approval lines in this phase.
  await row("Viewer User").getByRole("button", { name: "Actions for Viewer User" }).click();
  await page.getByRole("menuitem", { name: "Remove from space" }).click();
  dialog = page.getByRole("dialog", { name: "Remove Viewer User from FICO?" });
  await expect(dialog.getByText("Viewer User loses access to FICO right away. Viewer User's past actions stay in the activity log.")).toBeVisible();
  await expect(dialog.getByText("Impact")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Remove from space" }).click();
  await expect(page.getByText("Removed Viewer User from FICO.")).toBeVisible();
  await expect(row("Viewer User")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeFocused(); // its row is gone

  // The only space admin: Remove from space is off with the reason; Space admin is locked in Change roles.
  const mine = row(admin.name).getByRole("button", { name: `Actions for ${admin.name}` });
  await mine.click();
  const blocked = page.getByRole("menuitem", { name: /Remove from space/ });
  await expect(blocked).toHaveAttribute("aria-disabled", "true");
  await expect(blocked).toContainText("A space needs at least one space admin.");
  await page.getByRole("menuitem", { name: "Change roles" }).click();
  dialog = page.getByRole("dialog", { name: `Change roles for ${admin.name}` });
  await expect(dialog.getByRole("checkbox", { name: "Space admin" })).toHaveAttribute("aria-readonly", "true");
  await expect(dialog.getByRole("checkbox", { name: "Space admin" })).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByText(`Space admin can't be removed: ${admin.name} is the only space admin, and a space needs at least one. Make someone else a space admin first.`)).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(mine).toBeFocused(); // focus back on the row's menu button
});
