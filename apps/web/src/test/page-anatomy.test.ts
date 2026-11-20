import { describe, expect, it } from "vitest";
import { importsIn, importsOf, read, repoRel, scan, strip, WEB_SRC } from "./scan";

/**
 * The page anatomy (ui-standard §1a), checked through the shared components every page type uses: a route's
 * page.tsx delegates to a feature screen, so each check follows the static import graph from page.tsx into its
 * feature folder (the screen and the files of that folder it imports, transitively), not page.tsx alone.
 */
type F = { r: string; src: string; imp: string[] };
const WEB = "apps/web/src/";
const MAIN = `${WEB}app/(main)/`;
const files: F[] = scan([WEB_SRC], /\.(ts|tsx)$/).map((f) => ({ r: repoRel(f), src: read(f), imp: importsOf(f) }));
const f = (r: string, src: string): F => ({ r, src, imp: importsIn(src) });

const featureOf = (r: string) => (r.startsWith(`${WEB}features/`) ? r.split("/")[4] ?? null : null);
/** "@/features/x/y" or "./y" from `from` → the file it names (.tsx, .ts), or null. */
function resolve(byPath: Map<string, F>, from: string, spec: string): F | null {
  let base: string;
  if (spec.startsWith("@/")) base = WEB + spec.slice(2);
  else if (spec.startsWith(".")) {
    const parts = from.split("/").slice(0, -1);
    for (const p of spec.split("/")) { if (p === "..") parts.pop(); else if (p !== ".") parts.push(p); }
    base = parts.join("/");
  } else return null;
  return byPath.get(`${base}.tsx`) ?? byPath.get(`${base}.ts`) ?? byPath.get(base) ?? null;
}
/** The route of a page.tsx under (main): "/spaces/[spaceId]/sources". */
const routeOf = (r: string) => r.slice(MAIN.length - 1, -"/page.tsx".length) || "/";
const pages = (fs: F[]) => fs.filter(({ r }) => r.startsWith(MAIN) && r.endsWith("/page.tsx"));

/** The feature files a page reaches: the screens page.tsx imports and, transitively, the files of their feature folder. */
function screenFiles(fs: F[], page: F): F[] {
  const byPath = new Map(fs.map((x) => [x.r, x]));
  const seen = new Map<string, F>();
  const queue = page.imp.filter((s) => s.startsWith("@/features/")).map((s) => resolve(byPath, page.r, s)).filter((x): x is F => !!x);
  while (queue.length) {
    const x = queue.shift()!;
    if (seen.has(x.r)) continue;
    seen.set(x.r, x);
    for (const s of x.imp) {
      const t = resolve(byPath, x.r, s);
      if (t && featureOf(t.r) === featureOf(x.r)) queue.push(t);
    }
  }
  return [...seen.values()];
}
const renders = (xs: F[], tag: string) => xs.some(({ src }) => new RegExp(`<${tag}\\b`).test(strip(src)));

/** Pages that render no screen of their own, with the reason. */
const NO_SCREEN: Record<string, string> = {
  "/recons": "an entry: redirects to the recons of the remembered space (or /spaces)",
  "/sources": "an entry: redirects to the sources of the remembered space (or /spaces)",
  "/spaces": "an entry: redirects to a space's members; with no space at all, the shell's \"No space yet\" card (Figma Shell · No space yet)",
};
/** Pages not on the anatomy yet, with the reason; a stale entry fails. */
const PENDING: Record<string, string> = {};
/** A form page (ui-standard §1a "Form"): create, edit, a wizard, the profile. An autosaving editor is not a page of its own. */
const isForm = (route: string) => /\/(new|edit)$/.test(route) || route === "/me";
const isVersion = (route: string) => /\/versions\/\[\w+\]$/.test(route);

/** Every page renders PageHeader; a form page FormFooter; a version page VersionLayout (and never the builder). */
function anatomyViolations(fs: F[], noScreen = NO_SCREEN, pending = PENDING): string[] {
  return pages(fs).flatMap((p) => {
    const route = routeOf(p.r);
    if (route in noScreen || route in pending) return [];
    const xs = screenFiles(fs, p);
    const out: string[] = [];
    if (!renders(xs, "PageHeader")) out.push(`${route}: its screen renders no PageHeader`);
    if (isForm(route) && !renders(xs, "FormFooter")) out.push(`${route}: a form page without FormFooter (primary, Back, Cancel)`);
    if (isVersion(route) && !renders(xs, "VersionLayout")) out.push(`${route}: a version page without VersionLayout`);
    if (isVersion(route) && renders(xs, "Builder")) out.push(`${route}: a version page renders the builder (values as text, no disabled inputs)`);
    if (xs.some(({ src }) => /<PageHeader\b/.test(src) && /<ActionMenu\s+label="More actions"/.test(src))) out.push(`${route}: a page-made ⋯ menu; pass destructive actions in PageHeader more`);
    return out;
  });
}
const staleEntries = (fs: F[], list: Record<string, string>) => {
  const routes = new Set(pages(fs).map((p) => routeOf(p.r)));
  return Object.keys(list).filter((r) => !routes.has(r));
};

/** A form's buttons go through FormFooter: no screen lays out FormActions itself (the design system pages show it). */
const formActionsViolations = (fs: F[]) => fs.filter(({ r, src }) => r.startsWith(`${WEB}features/`) && !r.startsWith(`${WEB}features/ds/`) && /<FormActions\b/.test(strip(src)))
  .map(({ r }) => `${r}: FormActions directly; use FormFooter`);

/**
 * A destructive action (ui-standard §1a) is an item of a ⋯ menu, never a button of its own: a Button / BlockedButton
 * whose label starts with a destructive verb is reported, unless listed here with its reason.
 */
const DESTRUCTIVE_BUTTON_ALLOWED: Record<string, string> = {
  [`${WEB}features/users/users-page.tsx`]: "the bulk bar's Deactivate and Delete act on the selection and confirm with the count (ui-standard §4 Select all)",
  [`${WEB}features/me/security-panel.tsx`]: "Turn off two-factor authentication: the off switch of the user's own setting, inside its panel; it confirms",
};
const DESTRUCTIVE_LABEL = />\s*(?:\{[^{}]*\}\s*)*(?:Delete|Deactivate|Revoke|Reset|Retire|Remove|End session|Turn off|Disconnect)\b[^<]*<\/(?:Button|BlockedButton)>/;
const destructiveButtons = (fs: F[]) => fs.filter(({ r, src }) => r.startsWith(`${WEB}features/`) && !r.startsWith(`${WEB}features/ds/`) && DESTRUCTIVE_LABEL.test(strip(src))).map(({ r }) => r);

/**
 * Every page under spaces/[spaceId] has its own loading.tsx, in its own shape: a shape constant from its feature's
 * shapes.ts (never a neutral or inline one), and ROUTE_SHAPES lists the page with that same constant, so a boundary
 * above it shows that shape too.
 */
const LOADING_EXEMPT: Record<string, string> = {};
function loadingViolations(fs: F[], registry: string, exempt = LOADING_EXEMPT): string[] {
  const byPath = new Map(fs.map((x) => [x.r, x]));
  return pages(fs).filter((p) => p.r.startsWith(`${MAIN}spaces/[spaceId]/`)).flatMap((p) => {
    const route = routeOf(p.r);
    if (route in exempt) return [];
    const loading = byPath.get(p.r.replace(/page\.tsx$/, "loading.tsx"));
    if (!loading) return [`${route}: no loading.tsx`];
    const m = /import\s*\{\s*(\w+_SHAPE)\s*\}\s*from\s*["']@\/features\/(\w+)\/shapes["']/.exec(loading.src);
    if (!m || !new RegExp(`<RouteSkeleton\\s+sections=\\{${m[1]}\\}`).test(loading.src)) return [`${route}: loading.tsx renders no shape from its feature's shapes.ts`];
    const feature = screenFiles(fs, p).map((x) => featureOf(x.r)).find(Boolean);
    if (feature && m[2] !== feature) return [`${route}: loading.tsx takes its shape from features/${m[2]}, its screen is in features/${feature}`];
    const listed = new RegExp(`"${route.replace(/[[\]]/g, "\\$&")}":\\s*(\\w+)`).exec(registry)?.[1];
    return listed === m[1] ? [] : [`${route}: ROUTE_SHAPES (components/route-shapes.ts) lists ${listed ?? "nothing"}, its loading.tsx ${m[1]}`];
  });
}

describe("page anatomy (ui-standard §1a)", () => {
  it("every page renders PageHeader; form pages FormFooter; version pages VersionLayout; no page-made ⋯ menu", () => {
    expect(anatomyViolations(files)).toEqual([]);
  });
  it("the no-screen and pending lists name existing pages, and a pending page is still off the anatomy", () => {
    expect(staleEntries(files, NO_SCREEN)).toEqual([]);
    expect(staleEntries(files, PENDING)).toEqual([]);
    const done = Object.keys(PENDING).filter((route) => anatomyViolations(files, NO_SCREEN, Object.fromEntries(Object.entries(PENDING).filter(([r]) => r !== route))).length === 0);
    expect(done, "on the anatomy now: remove from PENDING").toEqual([]);
  });
  it("no screen lays out FormActions itself", () => {
    expect(formActionsViolations(files)).toEqual([]);
  });
  it("destructive actions are menu items, not buttons (allowlist exact)", () => {
    expect(destructiveButtons(files).filter((r) => !(r in DESTRUCTIVE_BUTTON_ALLOWED))).toEqual([]);
    expect(Object.keys(DESTRUCTIVE_BUTTON_ALLOWED).filter((r) => !destructiveButtons(files).includes(r))).toEqual([]);
  });
  it("every page under spaces/[spaceId] has a loading.tsx in its own shape, listed in ROUTE_SHAPES (no exemption)", () => {
    expect(loadingViolations(files, read(`${WEB_SRC}/components/route-shapes.ts`))).toEqual([]);
    expect(Object.keys(LOADING_EXEMPT)).toEqual([]);
  });
});

describe("page anatomy checkers (fixtures)", () => {
  const screen = (name: string, body: string) => f(`${WEB}features/things/${name}.tsx`, body);
  it("a page whose screen (or a file of its folder it imports) renders no PageHeader is reported", () => {
    const fs = [
      f(`${MAIN}things/page.tsx`, `import { ThingsPage } from "@/features/things/things-page";`),
      screen("things-page", `import { Body } from "./body"; <Body />`),
      screen("body", `<PageHeader title="Things" />`),
      f(`${MAIN}other/page.tsx`, `import { Other } from "@/features/things/other";`),
      screen("other", `<Panel />`),
      f(`${MAIN}gone/page.tsx`, `redirect("/")`),
    ];
    expect(anatomyViolations(fs, { "/gone": "redirect" }, {})).toEqual(["/other: its screen renders no PageHeader"]);
  });
  it("a form page without FormFooter, a version page without VersionLayout or with the builder, a page-made ⋯ menu", () => {
    const fs = [
      f(`${MAIN}things/new/page.tsx`, `import { NewThing } from "@/features/things/new-thing";`),
      screen("new-thing", `<PageHeader title="New thing" /><FormActions />`),
      f(`${MAIN}things/[id]/versions/[versionId]/page.tsx`, `import { V } from "@/features/things/version";`),
      screen("version", `<PageHeader title="v1" /><Builder editable={false} />`),
      f(`${MAIN}things/[id]/page.tsx`, `import { D } from "@/features/things/detail";`),
      screen("detail", `<PageHeader title="x" actions={<ActionMenu label="More actions" actions={[]} />} />`),
    ];
    expect(anatomyViolations(fs, {}, {})).toEqual([
      "/things/new: a form page without FormFooter (primary, Back, Cancel)",
      "/things/[id]/versions/[versionId]: a version page without VersionLayout",
      "/things/[id]/versions/[versionId]: a version page renders the builder (values as text, no disabled inputs)",
      "/things/[id]: a page-made ⋯ menu; pass destructive actions in PageHeader more",
    ]);
    expect(formActionsViolations(fs)).toEqual([`${WEB}features/things/new-thing.tsx: FormActions directly; use FormFooter`]);
    expect(staleEntries(fs, { "/nothing": "x" })).toEqual(["/nothing"]);
  });
  it("a destructive verb on a Button or BlockedButton is reported; a menu item and other verbs pass", () => {
    const fs = [
      screen("a", `<Button variant="ghost" onClick={() => go()}>Deactivate</Button>`),
      screen("b", `<BlockedButton reason={r}>{busy && <Spinner />}End session</BlockedButton>`),
      screen("c", `<ActionMenu actions={[{ id: "d", label: "Delete user", destructive: true }]} /><Button>Edit user</Button>`),
    ];
    expect(destructiveButtons(fs)).toEqual([`${WEB}features/things/a.tsx`, `${WEB}features/things/b.tsx`]);
  });
  it("a space page without loading.tsx, with an inline or another feature's shape, or not listed in ROUTE_SHAPES", () => {
    const page = (p: string) => f(`${MAIN}spaces/[spaceId]/${p}/page.tsx`, `import { S } from "@/features/things/s";`);
    const loading = (p: string, imp: string) => f(`${MAIN}spaces/[spaceId]/${p}/loading.tsx`, imp);
    const fs = [
      screen("s", `<PageHeader title="S" />`),
      page("a"),
      page("b"), loading("b", `const SECTIONS = []; <RouteSkeleton sections={SECTIONS} />`),
      page("c"), loading("c", `import { C_SHAPE } from "@/features/other/shapes"; <RouteSkeleton sections={C_SHAPE} />`),
      page("d"), loading("d", `import { D_SHAPE } from "@/features/things/shapes"; <RouteSkeleton sections={D_SHAPE} />`),
      page("e"), loading("e", `import { E_SHAPE } from "@/features/things/shapes"; <RouteSkeleton sections={E_SHAPE} />`),
    ];
    expect(loadingViolations(fs, `"/spaces/[spaceId]/d": OTHER_SHAPE, "/spaces/[spaceId]/e": E_SHAPE`, {})).toEqual([
      "/spaces/[spaceId]/a: no loading.tsx",
      "/spaces/[spaceId]/b: loading.tsx renders no shape from its feature's shapes.ts",
      "/spaces/[spaceId]/c: loading.tsx takes its shape from features/other, its screen is in features/things",
      "/spaces/[spaceId]/d: ROUTE_SHAPES (components/route-shapes.ts) lists OTHER_SHAPE, its loading.tsx D_SHAPE",
    ]);
  });
});
