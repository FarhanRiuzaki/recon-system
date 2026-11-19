import { expect, type Page, test } from "@playwright/test";
import { AUTH_STATE } from "./global-setup";
import { signIn } from "./helpers";

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
