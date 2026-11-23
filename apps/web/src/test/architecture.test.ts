import path from "node:path";
import { describe, expect, it } from "vitest";
import { pagePerm } from "@/lib/shared/nav";
import { VIEW_PAGES } from "@/lib/shared/prefs";
import { BRAND } from "@starterkit/shared/brand";
import { INTENTS } from "@starterkit/ui/ds";
import { importsIn, importsOf, read, REPO, repoRel, scan, SHARED_SRC, strip, UI_SRC, WEB_SRC } from "./scan";

type F = { r: string; src: string; imp: string[] };

const WEB = "apps/web/src/";
const UI = "packages/ui/src/";
const SHARED = "packages/shared/src/";
const files: F[] = scan([WEB_SRC, UI_SRC, SHARED_SRC]).map((f) => ({ r: repoRel(f), src: read(f), imp: importsOf(f) }));
const cssFiles: F[] = scan([WEB_SRC, UI_SRC], /\.css$/).map((f) => ({ r: repoRel(f), src: read(f), imp: [] }));

/** ui/motion/lib = primitives (0) → ds (1) → charts and flow (2) → shell (3) → features (4). */
const layer = (r: string) =>
  [`${UI}ui/`, `${UI}motion/`, `${UI}lib/`].some((p) => r.startsWith(p)) ? 0 : r.startsWith(`${UI}ds/`) ? 1
    : r.startsWith(`${UI}charts/`) || r.startsWith(`${UI}flow/`) ? 2 : r.startsWith(`${WEB}components/shell/`) ? 3 : r.startsWith(`${WEB}features/`) ? 4 : null;
/** Import specifier → repo-relative path ("@/x", "@starterkit/ui/x", "./x" all resolve); other packages → null. */
const resolveSpec = (fromRel: string, spec: string): string | null =>
  spec.startsWith("@/") ? WEB + spec.slice(2)
    : spec.startsWith("@starterkit/shared/") ? SHARED + spec.slice("@starterkit/shared/".length)
    : spec.startsWith("@starterkit/ui/") ? UI + spec.slice("@starterkit/ui/".length)
    : spec.startsWith(".") ? repoRel(path.resolve(REPO, path.dirname(fromRel), spec))
    : null;
const featureOf = (r: string) => (r.startsWith(`${WEB}features/`) ? r.split("/")[4] ?? null : null);

/**
 * Intents by verb (owner 24 Nov, superseding 22 Nov's add blue / Edit ghost): a Button named "Remove …" or "Delete …"
 * (aria-label or text) is `variant="remove"` (a confirm dialog's is destructive); one named "Create …", "Add …" or
 * "New …" is `variant="create"` (green; the page's one main CTA may stay default); one labelled "Edit …" is
 * `variant="edit"` (blue). From `INTENTS`
 * (`ds/intent.ts`): a Button or BlockedButton labelled with a caution action (Reject, Turn off, Cancel request) is
 * `variant="caution"` (or destructive, a confirm dialog's), and one labelled with an intent whose icon is `required`
 * (Edit, Replace, Export, Retry …) renders an `<Icon icon={…} />` among its children, always: an icon only in an
 * expression (`{busy && <Icon … />}`) doesn't count, nor a named icon component used bare (`<EditIcon />`); icons go
 * through `<Icon icon=…>` (ui/icon.tsx). A self-closing `<Button … />` has no children. A Button asChild around a Link
 * labelled with a navigate action (View, Open, Review) is `variant="link"` with its `<Icon>` after the words. The verb
 * rules hold for a BlockedButton too.
 */
const startsWith = (words: readonly string[]) => new RegExp(`^(${words.join("|")})\\b`);
const CAUTION_LABEL = startsWith(INTENTS.caution.actions);
const CAUTION_VARIANTS: readonly string[] = INTENTS.caution.variant;
const NAV_LABEL = startsWith(INTENTS.navigate.actions);
const ICON_LABEL = startsWith(Object.values(INTENTS).filter((i) => "required" in i && i.required && i.variant !== "create").flatMap((i) => i.actions));
const CREATE_LABEL = startsWith(INTENTS.create.actions);
const REMOVE_LABEL = startsWith(INTENTS.remove.actions);
/** `s` without its `{…}` expressions (nested braces counted): what always renders, not `{busy && <Icon … />}`. */
const outsideExpressions = (s: string) => { let out = "", depth = 0; for (const c of s) { if (c === "{") depth++; else if (c === "}") depth = Math.max(0, depth - 1); else if (!depth) out += c; } return out; };
function intentViolations(fs: F[]): string[] {
  const out: string[] = [];
  for (const { r, src } of fs) {
    // an affectUI demo's Button is the vendored one, with upstream's own variants
    if (!r.endsWith(".tsx") || r.startsWith(VENDORED) || src.includes(`from "@starterkit/ui/affect/button"`)) continue;
    for (const m of src.matchAll(/<(BlockedButton|Button|button)(?=[\s>])/g)) {
      // the opening tag: braces counted (an onClick's arrow holds ">"), quoted text skipped (title="a > b")
      let i = m.index! + m[0].length, depth = 0, quote = "";
      for (; i < src.length; i++) {
        const c = src[i]!;
        if (quote) { if (c === quote) quote = ""; continue; }
        if (c === '"' || c === "'" || c === "`") { if (depth === 0 || c === "`") quote = c; continue; }
        if (c === "{") depth++; else if (c === "}") depth--; else if (c === ">" && depth === 0) break;
      }
      // a self-closing tag (`<Button … />`) has no children: what follows belongs to the next element
      const tag = src.slice(m.index!, i + 1), selfClosing = src[i - 1] === "/";
      const text = selfClosing ? "" : src.slice(i + 1, i + 200).replace(/^\s*(\{[^}]*\}\s*)?(<Icon[^>]*\/>\s*)?/, "");
      const aria = /aria-label=\{?[`"']([^`"']*)/.exec(tag)?.[1] ?? "";
      const named = REMOVE_LABEL.test(aria) || REMOVE_LABEL.test(text);
      if (m[1] === "button") {
        // a raw button that removes says so in the Remove ink (the variant's colour)
        if (named && !/text-down-ink/.test(tag)) out.push(`${r}: raw Remove / Delete button without text-down-ink`);
        continue;
      }
      const variant = /variant="([a-z]+)"/.exec(tag)?.[1] ?? "default";
      // the label: the children up to the closing tag, without their tags and expressions ("Edit<span> code</span>")
      const close = selfClosing ? -1 : src.indexOf(`</${m[1]}>`, i), inner = close < 0 ? "" : src.slice(i + 1, close);
      const label = inner.replace(/<[^>]*>/g, " ").replace(/\{[^}]*\}/g, " ").replace(/\s+/g, " ").trim();
      if (CAUTION_LABEL.test(label) && !CAUTION_VARIANTS.includes(variant)) out.push(`${r}: ${label} is variant="${variant}", not caution`);
      if (/^Edit\b/.test(label) && variant !== INTENTS.edit.variant) out.push(`${r}: ${label} is variant="${variant}", not ${INTENTS.edit.variant}`);
      if ((CREATE_LABEL.test(label) || (!label && CREATE_LABEL.test(aria))) && variant !== INTENTS.create.variant && variant !== "default")
        out.push(`${r}: ${label || aria} is variant="${variant}", not create`);
      if (named && variant !== "remove" && variant !== "destructive") out.push(`${r}: ${label || aria} is variant="${variant}", not remove`);
      if (ICON_LABEL.test(label) && !/<Icon\s[^>]*\bicon=/.test(outsideExpressions(inner))) out.push(`${r}: ${label} without its icon`);
      // a link that navigates (asChild around a Link) labelled View / Open / Review: variant link, its icon after the words
      if (/\basChild\b/.test(tag) && /^\s*<Link\b/.test(inner) && NAV_LABEL.test(label)) {
        if (variant !== "link") out.push(`${r}: ${label} link is variant="${variant}", not link`);
        if (!/\w[^<]*<Icon\s[^>]*\bicon=[^>]*\/>\s*<\/Link>\s*$/.test(outsideExpressions(inner))) out.push(`${r}: ${label} link without its trailing icon`);
      }
    }
  }
  return out;
}

function layerViolations(fs: F[]): string[] {
  return fs.flatMap(({ r, imp }) => {
    const me = layer(r);
    if (me == null) return [];
    return imp.filter((s) => { const t = resolveSpec(r, s); const l = t == null ? null : layer(`${t}/`); return l != null && l > me; })
      .map((s) => `${r} → ${s}`);
  });
}

/** packages/shared/src stays pure: no React, Next, apps/, the @/ alias; the only @starterkit import is @starterkit/ui/lib/*. */
function sharedViolations(fs: F[]): string[] {
  const bad = (s: string) => /^(react|next)(\/|$)/.test(s) || s.startsWith("@/") || /(^|\/)apps\//.test(s)
    || (s.startsWith("@starterkit/") && !s.startsWith("@starterkit/ui/lib/"));
  return fs.filter(({ r }) => r.startsWith(SHARED)).flatMap(({ r, imp }) => imp.filter(bad).map((s) => `${r} → ${s}`));
}

/** Tailwind 4: `outline-none` sets --tw-outline-style: none, which `focus-visible:outline-2` reads, so no ring shows unless `focus-visible:outline-solid` is also there (AGENTS.md §7). */
function focusRingViolations(fs: F[]): string[] {
  return fs.filter(({ r }) => r.endsWith(".tsx")).flatMap(({ r, src }) =>
    src.split("\n").flatMap((l, i) => (/\boutline-none\b/.test(l) && /focus-visible:-?outline-\d/.test(l) && !/focus-visible:outline-solid\b/.test(l) ? [`${r}:${i + 1}`] : [])));
}

/** sonner (~10 kB gz) loads on demand: `toast` from ui/toast.ts, the Toaster through next/dynamic (providers.tsx). */
function sonnerViolations(fs: F[]): string[] {
  const own = [`${UI}ui/sonner.tsx`, `${UI}ui/toast.ts`];
  return fs.filter(({ r, src, imp }) => (imp.includes("sonner") && !own.includes(r)) || /from\s+["']@starterkit\/ui\/ui\/sonner["']/.test(src)).map((f) => f.r);
}

function siblingFeatureViolations(fs: F[]): string[] {
  return fs.flatMap(({ r, imp }) => {
    const me = featureOf(r);
    if (me == null) return [];
    return imp.filter((s) => { const t = resolveSpec(r, s); const f = t == null ? null : featureOf(t); return f != null && f !== me; })
      .map((s) => `${r} → ${s}`);
  });
}

function clientImportsServer(fs: F[]): string[] {
  return fs.filter(({ r, src, imp }) => /^["']use client["']/m.test(src)
    && imp.some((s) => resolveSpec(r, s)?.startsWith(`${WEB}lib/server`))).map(({ r }) => r);
}

/**
 * Browser code reaches the backend only through same-origin `/api/*` (CSP connect-src 'self'; the backend URL is
 * server env only). Client = features/, components/, lib/client/, or any file with "use client".
 * Static limit: a `fetch(`/`api(` whose first argument is not a literal (fetch(url), fetch(BASE + "/x")) is NOT caught
 * here. The runtime guard in `lib/client/api.ts` covers `api()` calls only; a raw `fetch(` with a non-literal
 * argument is covered only by CSP connect-src 'self'. EventSource,
 * WebSocket and sendBeacon are stricter: a non-literal argument is flagged too.
 */
const isClient = ({ r, src }: F) => /^["']use client["']/m.test(src)
  || [`${WEB}features/`, `${WEB}components/`, `${WEB}lib/client/`].some((p) => r.startsWith(p));
function clientApiViolations(fs: F[]): string[] {
  return fs.filter(isClient).flatMap(({ r, src: raw }) => {
    // Comments only (string-aware strip): a "//" inside a string ("https://…") must not swallow the rest of the line.
    const src = strip(raw);
    // First argument written as a string or template literal must start with "/api/" (not http(s)://, //, a ${base}).
    const calls = [...src.matchAll(/\b(fetch|api)\s*(?:<[^<>()]*>)?\(\s*(["'`])(?=([^]{0,12}))/g)]
      .filter((m) => !m[3]!.startsWith("/api/")).map((m) => `${r}: ${m[1]}(${m[2]}${m[3]!.split(m[2]!)[0]}…) must start with "/api/"`);
    const streams = [...src.matchAll(/(new\s+(?:EventSource|WebSocket)|navigator\.sendBeacon)\s*\(\s*(["'`]?)(?=([^]{0,12}))/g)]
      .filter((m) => !(m[2] && m[3]!.startsWith("/api/"))).map((m) => `${r}: ${m[1]}( must take a literal starting with "/api/"`);
    const env = [...src.matchAll(/process\.env\.NEXT_PUBLIC_\w*(?:API|URL)\w*/g)].map((m) => `${r}: ${m[0]} exposes a backend URL to the browser`);
    return [...calls, ...streams, ...env];
  });
}

/** `import { type A, type B }`: every named import is type-only. */
const allTypes = (clause: string | undefined) => {
  const c = clause?.trim() ?? "";
  return /^\{[\s\S]*\}$/.test(c) && c.slice(1, -1).split(",").map((x) => x.trim()).filter(Boolean).every((x) => x.startsWith("type "));
};
/**
 * Browser code takes the zod contracts (and zod itself) as types only, so zod stays out of every route's first load
 * (ui-standard §5). Value lists the screens need live in zod-free lib/shared modules.
 */
function clientZodViolations(fs: F[]): string[] {
  return fs.filter(isClient).flatMap(({ r, src }) => [...strip(src).matchAll(/^\s*import\s+(type\s+)?(?:([^;"']*?)\s+from\s+)?["']([^"']+)["']/gm)]
    .filter((m) => {
      const spec = m[3]!;
      return spec === "zod" || spec.startsWith("zod/") || !!resolveSpec(r, spec)?.startsWith(`${SHARED}contracts/`);
    })
    .filter((m) => !m[1] && !allTypes(m[2]))
    .map((m) => `${r}: value import from ${m[3]}`));
}

/**
 * The web reaches the API over HTTP only (lib/server/backend.ts): nothing under apps/web/src imports the Bun runtime
 * (`bun`, `bun:*`), a database driver (`pg`) or API code (`@starterkit/api`, a path into apps/api).
 */
function runtimeViolations(fs: F[]): string[] {
  const bad = (r: string, s: string) => /^(bun|pg)$|^bun:|^pg\//.test(s) || s.startsWith("@starterkit/api")
    || /(^|\/)apps\/api(\/|$)/.test(s) || !!resolveSpec(r, s)?.startsWith("apps/api/");
  return fs.filter(({ r }) => r.startsWith(WEB)).flatMap(({ r, imp }) => imp.filter((s) => bad(r, s)).map((s) => `${r} → ${s}`));
}

/**
 * Route handlers: the catch-all that forwards to the API, and the auth routes that set the cookie. Guards, CSRF order
 * and activity entries of every other endpoint live in the API (apps/api/test/architecture/conformance.test.ts).
 */
const ROUTE_FILES = [
  "app/api/[...path]/route.ts", "app/api/auth/2fa/route.ts", "app/api/auth/forgot/route.ts", "app/api/auth/login/route.ts",
  "app/api/auth/logout/route.ts", "app/api/auth/oauth/[provider]/callback/route.ts", "app/api/auth/oauth/[provider]/mock-authorize/route.ts",
  "app/api/auth/oauth/[provider]/route.ts", "app/api/auth/reset/route.ts",
].map((r) => WEB + r);
const routeFiles = (fs: F[]) => fs.filter(({ r }) => new RegExp(`^${WEB}app/(.+/)?route\\.tsx?$`).test(r)).map(({ r }) => r).sort();

const MOTION_TOKENS = `${UI}motion/tokens.ts`;
/**
 * Vendored affectUI sources (packages/ui/src/affect/README.md, design-system.md §7.10): each file carries upstream's
 * own colours and timings, kept 1:1, so the token rules below skip this folder and nothing else.
 */
const VENDORED = `${UI}affect/`;
const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(|-\[\d+(?:\.\d+)?px\]/;
const colourLiteralViolations = (fs: F[]) => fs.filter(({ r, src }) => r.endsWith(".tsx") && !r.startsWith(VENDORED) && COLOUR_LITERAL.test(strip(src)))
  .map(({ r, src }) => `${r}: ${strip(src).match(COLOUR_LITERAL)?.[0]}`);
/** Literal timings in TS/TSX (motion values come from motion/tokens.ts or the CSS --dur-* / --ease-* tokens). */
const TS_TIMING: RegExp[] = [
  /\b(?:duration|delay)-(?:\[|\d)/, // Tailwind duration-150, delay-[40ms]
  /\bease-\[/, // ease-[cubic-bezier(…)]
  /\b(?:duration|delay)\s*:\s*\d/, // { duration: 0.2 }
  /\bease\s*:\s*\[/, // { ease: [0.2, 0, 0, 1] }
  /\bcubic-bezier\(/,
  /\bease\s*:\s*["'`]/, // { ease: "linear" }
  /\b(?:stiffness|damping|bounce)\s*:\s*\d/, // inline spring
  /\b(?:DUR|STAGGER|CHART_STAGGER)\.\w+\s*[-+]\s*\d|\d\s*[-+]\s*(?:DUR|STAGGER|CHART_STAGGER)\.\w+/, // DUR.slow + 0.32
  /\b(?:animation|transition)(?:Delay|Duration)\s*:[^,;\n]*\d/, // animationDelay: `${i * 12}ms`
  /["'`\s:]\d*\.?\d+m?s\b\s*(?:ease|linear|cubic|["'`;])/, // "200ms", "0.2s ease"
];
/** CSS: a time other than 0 or a cubic-bezier( outside a custom-property definition (`--dur-x: 150ms`). */
const CSS_TIMING = /(?<![\w.-])(?!0m?s\b)\d*\.?\d+m?s\b|\bcubic-bezier\(/;

function motionLiteralViolations(ts: F[], css: F[]): string[] {
  const inTs = ts.filter(({ r }) => r !== MOTION_TOKENS && !r.startsWith(VENDORED)).flatMap(({ r, src }) => {
    const hit = TS_TIMING.map((re) => strip(src).match(re)?.[0]).find(Boolean);
    return hit ? [`${r}: ${hit}`] : [];
  });
  const inCss = css.flatMap(({ r, src }) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n")
    .flatMap((line) => line.split(";")).map((d) => d.slice(d.lastIndexOf("{") + 1)).filter((d) => !/^\s*--[\w-]+\s*:/.test(d))
    .flatMap((d) => { const m = d.match(CSS_TIMING); return m ? [`${r}: ${m[0]}`] : []; }));
  return [...inTs, ...inCss];
}

/** Status legends live in a card header (Panel `legend`), never on a page, toolbar or inline (spec "Legend status per card"). */
const LEGEND_HOME = `${UI}ds/panel.tsx`;
function legendViolations(fs: F[]): string[] {
  return fs.filter(({ r, src }) => r !== LEGEND_HOME && /<StatusLegend\b/.test(strip(src))).map(({ r }) => `${r}: renders StatusLegend; pass Panel legend instead`);
}

/** A list screen (useTableQuery) gives its viewer saved views and the column chooser, and passes the choice to its DataTable. */
/**
 * In packages/shared only contracts/ imports zod: the other files (paging, permissions, a module's limits) are what
 * client code imports as values, so zod would ship in the first load through them.
 */
const sharedZodViolations = (fs: F[]) => fs
  .filter(({ r }) => r.startsWith(SHARED) && !r.startsWith(`${SHARED}contracts/`) && !/\.test\.tsx?$/.test(r))
  .filter(({ imp }) => imp.some((i) => i === "zod" || i.startsWith("zod/")))
  .map(({ r }) => `${r}: only packages/shared/src/contracts/ imports zod; client code imports this file as values`);

/** A list screen's call, generic or not: `useTableQuery(` and `useTableQuery<T, F>(`. */
const LIST_CALL = /\buseTableQuery\s*[<(]/;

/**
 * A useTableQuery screen that is not a list page, with why it has no saved views or column chooser. The stale-entry
 * check fails when a file listed here no longer calls useTableQuery.
 */
const COLUMNS_MENU_ALLOWED: Record<string, string> = {
  [`${WEB}features/breaks/break-page.tsx`]: "the counterpart picker inside the unmatch item page: five fixed columns to tick from, not a list to keep views of (audit B7)",
  [`${WEB}features/breaks/break-activity.tsx`]: "the unmatch item's Activity log zone: a quiet three-column trail, not a list page (audit B9)",
  [`${WEB}features/approvals/used-by.tsx`]: "the workflow page's Used by side panel: four fixed columns beside the editor, not a list to keep views of (audit W8)",
};

/**
 * A `defaultHidden` column is reachable only through ColumnsMenu (and kept only on a VIEW_PAGES page, tested below):
 * a file that defines one renders ColumnsMenu where it renders the DataTable; a columns module without a DataTable
 * is checked in every file that imports it and renders a DataTable.
 */
function defaultHiddenViolations(fs: F[]): string[] {
  const table = (src: string) => /<DataTable\b/.test(src), menu = (src: string) => /<ColumnsMenu\b/.test(src);
  return fs.filter(({ r }) => r.startsWith(WEB) && /\.tsx?$/.test(r) && !r.endsWith(".test.ts")).flatMap(({ r, src }) => {
    const code = strip(src);
    if (!/\bdefaultHidden\s*:\s*true\b/.test(code)) return [];
    if (table(code)) return menu(code) ? [] : [`${r}: a defaultHidden column without ColumnsMenu`];
    const self = r.replace(/\.tsx?$/, "");
    return fs.filter((x) => x.imp.some((s) => resolveSpec(x.r, s) === self) && table(strip(x.src)) && !menu(strip(x.src)))
      .map((x) => `${x.r}: a defaultHidden column (${r}) without ColumnsMenu`);
  });
}

function columnsMenuViolations(fs: F[], allowed: Record<string, string> = COLUMNS_MENU_ALLOWED): string[] {
  return fs.filter(({ r, src }) => r.startsWith(`${WEB}features/`) && !(r in allowed) && LIST_CALL.test(strip(src)))
    .filter(({ src }) => {
      const code = strip(src);
      return !/<SavedViewsMenu\b/.test(code) || !/<ColumnsMenu\b[^>]*hidden=/.test(code) || !/<DataTable\b[^>]*\bhidden=/.test(code);
    })
    .map(({ r }) => `${r}: a list screen renders SavedViewsMenu and ColumnsMenu and passes hidden to DataTable`);
}

/**
 * A page that renders a list screen (a features/ file calling useTableQuery, directly or through a file of the same
 * feature folder it imports) is in VIEW_PAGES, so the navigation reopens its last view and its saved views work. A
 * dynamic route is listed by its pattern (`/spaces/[spaceId]/members`, prefs.ts `viewPageOf`).
 */
function viewPageViolations(fs: F[], viewPages: readonly string[]): string[] {
  const byPath = new Map(fs.map((x) => [x.r, x]));
  const isList = (x: F | undefined) => !!x && LIST_CALL.test(strip(x.src));
  return fs.filter(({ r }) => r.startsWith(`${WEB}app/(main)/`) && r.endsWith("/page.tsx")).flatMap(({ r, imp }) => {
    const route = r.slice(`${WEB}app/(main)`.length, -"/page.tsx".length) || "/";
    const screens = imp.filter((i) => i.startsWith("@/features/")).map((i) => `${WEB}${i.slice(2)}.tsx`);
    const reached = screens.flatMap((s) => {
      const dir = s.slice(0, s.lastIndexOf("/") + 1);
      return [byPath.get(s), ...(byPath.get(s)?.imp ?? []).filter((i) => i.startsWith("./")).map((i) => byPath.get(`${dir}${i.slice(2)}.tsx`))];
    });
    return reached.some(isList) && !viewPages.includes(route) ? [`${r}: renders a list screen; add "${route}" to VIEW_PAGES (lib/shared/prefs.ts)`] : [];
  });
}

/** The product name is one constant (BRAND in packages/shared/src/brand.ts); titles, error sources and the logo read it. */
const BRAND_HOME = `${SHARED}brand.ts`;
const NAME = new RegExp(`\\b${BRAND.name}\\b`);
const brandViolations = (fs: F[]) => fs.filter(({ r, src }) => r !== BRAND_HOME && NAME.test(src)).map(({ r }) => `${r}: write BRAND.name, not the product name`);

/** Each signed-in page.tsx guards with the permission pagePerm gives its path (the layout's 404 check uses pagePerm). */
function pageGuardViolations(fs: F[]): string[] {
  return fs.filter(({ r }) => r.startsWith(`${WEB}app/(main)/`) && r.endsWith("/page.tsx")).flatMap(({ r, src }) => {
    const route = r.slice(`${WEB}app/(main)`.length, -"/page.tsx".length).replace(/\[\w+\]/g, "x") || "/";
    const arg = strip(src).match(/requirePagePermission\(\s*(null|"[^"]+")?\s*\)/)?.[1];
    const own = arg && arg !== "null" ? arg.slice(1, -1) : null;
    return own === pagePerm(route) ? [] : [`${r}: guards with ${own ?? "nothing"}, pagePerm("${route}") is ${pagePerm(route) ?? "null"}`];
  });
}

/** The app time zone is written only in packages/ui/src/lib/format.ts (packages/ui time-zone.test.ts checks the package). */
const ZONE_LITERAL = /7\s*\*\s*(?:3600|60\s*\*\s*60)|25_?200|["'`>(\s]WIB\b|\bUTC\s*\+\s*7\b|\w+WIB\b/;
const zoneViolations = (fs: F[]) => fs.filter(({ r, src }) => r.startsWith(WEB) && ZONE_LITERAL.test(strip(src))).map(({ r }) => r);

/** Password fields are PasswordInput (show/hide, Caps Lock note, paste works): no raw type="password" elsewhere. */
const PASSWORD_HOME = `${UI}ui/password-input.tsx`;
const RAW_PASSWORD = /\btype=(?:"password"|'password'|\{[^}]*["']password["'][^}]*\})/;
const passwordFieldViolations = (fs: F[]) => fs.filter(({ r, src }) => r !== PASSWORD_HOME && r.endsWith(".tsx") && RAW_PASSWORD.test(strip(src)))
  .map(({ r }) => `${r}: a raw password input; use PasswordInput`);
/** A new-password field lists its requirements while the user types (PasswordChecks + passwordChecks()). */
const newPasswordViolations = (fs: F[]) => fs.filter(({ r, src }) => r.startsWith(WEB) && /autoComplete=["']new-password["']/.test(src) && !/<PasswordChecks\b/.test(strip(src)))
  .map(({ r }) => `${r}: a new-password field without PasswordChecks`);

/**
 * Inner scroll areas use the quiet scrollbar (base.css `scroll-quiet`), or none with ScrollArea's own thumb
 * (`scroll-none`): a class string with overflow-*-auto names one of them too.
 */
const OVERFLOW_AUTO = /\boverflow(?:-[xy])?-auto\b/;
const scrollViolations = (fs: F[]) => fs.filter(({ r }) => r.endsWith(".tsx")).flatMap(({ r, src }) =>
  [...strip(src).matchAll(/"[^"\n]*"|`[^`]*`/g)].map((m) => m[0]).filter((c) => OVERFLOW_AUTO.test(c) && !/\bscroll-(?:quiet|none)\b/.test(c))
    .map((c) => `${r}: ${c.match(OVERFLOW_AUTO)![0]} without scroll-quiet`));

/**
 * A `next/dynamic` component that renders on the server must load its chunk before the page hydrates, so it is part of
 * the first load, but bundle-budget.mjs counts no dynamic chunk: every `dynamic(` call in apps/web passes `ssr: false`
 * (below-the-fold content mounts through LazyMount, prefetched data renders from the cache). An exception names the
 * file and the module it imports, with the reason.
 */
const SSR_DYNAMIC_ALLOWED: Record<string, string> = {};
/**
 * "file → module" of each `dynamic(` call without `ssr: false` (the module = the first import("…") in its arguments).
 * The call is found under the name the file imports it as (`import lazy from`, `import { default as lazy } from`), also
 * with a type argument (`dynamic<Props>(`) or a space before the parenthesis.
 */
function dynamicSsrCalls(fs: F[]): string[] {
  return fs.filter(({ r, imp }) => r.startsWith(WEB) && imp.includes("next/dynamic")).flatMap(({ r, src }) => {
    const code = strip(src);
    const name = /import\s+(?:(\w+)|\{[^}]*\bdefault\s+as\s+(\w+)[^}]*\})\s+from\s+["']next\/dynamic["']/.exec(code)?.slice(1).find(Boolean) ?? "dynamic";
    const out: string[] = [];
    for (const m of code.matchAll(new RegExp(`\\b${name}\\s*(?:<[^()]*?>)?\\s*\\(`, "g"))) {
      let depth = 0, end = m.index + m[0].length - 1;
      for (; end < code.length; end++) {
        if (code[end] === "(") depth++;
        else if (code[end] === ")" && --depth === 0) break;
      }
      const args = code.slice(m.index, end + 1);
      if (!/\bssr\s*:\s*false\b/.test(args)) out.push(`${r} → ${/import\(\s*["'`]([^"'`]+)/.exec(args)?.[1] ?? "?"}`);
    }
    return out;
  });
}
const dynamicSsrViolations = (fs: F[], allowed: Record<string, string> = SSR_DYNAMIC_ALLOWED) =>
  dynamicSsrCalls(fs).filter((c) => !(c in allowed)).map((c) => `${c}: pass ssr: false (or allowlist it with a reason)`);

describe("architecture", () => {
  it("inner scroll areas use the quiet scrollbar (scroll-quiet next to overflow-*-auto)", () => {
    expect(scrollViolations(files)).toEqual([]);
  });

  it("password fields are PasswordInput; a new-password field shows PasswordChecks", () => {
    expect(passwordFieldViolations(files)).toEqual([]);
    expect(newPasswordViolations(files)).toEqual([]);
  });

  it("apps/web writes no UTC offset or zone label (APP_UTC_OFFSET_SEC, APP_TIME_ZONE_LABEL, formatDate…)", () => {
    expect(zoneViolations(files)).toEqual([]);
  });

  it("each signed-in page guards with the permission pagePerm gives its path", () => {
    expect(pageGuardViolations(files)).toEqual([]);
  });

  it("the product name appears only in packages/shared/src/brand.ts", () => {
    expect(brandViolations(files)).toEqual([]);
  });

  it("outline-none with a focus-visible outline width also sets focus-visible:outline-solid", () => {
    expect(focusRingViolations(files)).toEqual([]);
  });

  it("layers import downward only (ui/motion → ds → charts → components/shell → features)", () => {
    expect(layerViolations(files)).toEqual([]);
  });

  it("a feature never imports a sibling feature (alias or relative path)", () => {
    expect(siblingFeatureViolations(files)).toEqual([]);
  });

  it("no Bun runtime, database driver or API code in apps/web/src", () => {
    expect(runtimeViolations(files)).toEqual([]);
  });

  it("route.ts files are exactly the catch-all and the auth routes", () => {
    expect(routeFiles(files)).toEqual([...ROUTE_FILES].sort());
  });

  it("client code never imports lib/server", () => {
    expect(clientImportsServer(files)).toEqual([]);
  });

  it("lib/shared is pure (no React, Next, lib/server or components)", () => {
    const bad = files.filter(({ r, imp }) => r.startsWith(`${WEB}lib/shared/`) && imp.some((s) => {
      const t = resolveSpec(r, s);
      return /^(react|next)(\/|$)/.test(s) || !!t?.startsWith(`${WEB}lib/server`) || !!t?.startsWith(`${WEB}components`) || !!t?.startsWith(`${WEB}features`);
    }));
    expect(bad.map((f) => f.r)).toEqual([]);
  });

  it("packages/shared is pure (no React, Next, apps/, @/; only @starterkit/ui/lib/*)", () => {
    expect(sharedViolations(files)).toEqual([]);
  });

  it("client code calls only same-origin /api/ and reads no NEXT_PUBLIC API/URL variable", () => {
    expect(clientApiViolations(files)).toEqual([]);
  });

  it("client code imports zod contracts and zod as types only", () => {
    expect(clientZodViolations(files)).toEqual([]);
  });

  it("in packages/shared only contracts/ imports zod", () => {
    expect(sharedZodViolations(files)).toEqual([]);
  });

  it("no dangerouslySetInnerHTML", () => {
    expect(files.filter(({ src }) => src.includes("dangerouslySetInnerHTML")).map((f) => f.r)).toEqual([]);
  });

  it("only the flow layer imports @xyflow/react (the canvases' parts live in the design system)", () => {
    expect(files.filter(({ r, imp }) => imp.some((i) => i.startsWith("@xyflow/react")) && !r.startsWith(`${UI}flow/`)).map((f) => f.r)).toEqual([]);
  });
  it("every button says its intent: create (green), edit (blue), remove (red), caution for a negative decision, the verb icon on Edit / Export / Retry", () => {
    expect(intentViolations(files)).toEqual([]);
  });
  it("a dialog with a footer holds its content in DialogBody (owner, 22 Nov: modals tidy and symmetric)", () => {
    // DialogBody gives every dialog the same 24 px sides and bottom, 16 px under the header; a body padded by hand drifted
    const bare = files.filter(({ r, src }) => r.endsWith(".tsx") && !r.startsWith(VENDORED) && !r.endsWith("ui/dialog.tsx")
      && /<DialogFooter\b/.test(src) && !/<DialogBody\b/.test(src)).map(({ r }) => r);
    expect(bare).toEqual([]);
  });
  it("only charts imports recharts", () => {
    expect(files.filter(({ r, imp }) => imp.includes("recharts") && !r.startsWith(`${UI}charts/`)).map((f) => f.r)).toEqual([]);
  });

  it("every next/dynamic call passes ssr: false (its chunk is outside the measured first load); the allowlist has no stale entry", () => {
    expect(dynamicSsrViolations(files)).toEqual([]);
    const calls = dynamicSsrCalls(files);
    expect(Object.keys(SSR_DYNAMIC_ALLOWED).filter((k) => !calls.includes(k))).toEqual([]);
  });

  it("sonner stays out of first loads: only ui/sonner.tsx and ui/toast.ts import it; ui/sonner only through import()", () => {
    expect(sonnerViolations(files)).toEqual([]);
    expect(sonnerViolations([
      { r: `${WEB}features/x/a.tsx`, src: `import { toast } from "sonner";`, imp: ["sonner"] },
      { r: `${WEB}features/x/b.tsx`, src: `import { Toaster } from "@starterkit/ui/ui/sonner";`, imp: ["@starterkit/ui/ui/sonner"] },
      { r: `${WEB}components/c.tsx`, src: `dynamic(() => import("@starterkit/ui/ui/sonner"))`, imp: ["@starterkit/ui/ui/sonner"] },
    ])).toEqual([`${WEB}features/x/a.tsx`, `${WEB}features/x/b.tsx`]);
  });

  it("only packages/ui/src/motion/framer.tsx imports motion", () => {
    const bad = files.filter(({ r, imp }) => imp.some((s) => s === "motion" || s.startsWith("motion/") || s.startsWith("framer-motion"))
      && r !== `${UI}motion/framer.tsx`);
    expect(bad.map((f) => f.r)).toEqual([]);
  });

  it("icons: only packages/ui/src/ui/icons.ts imports Hugeicons; no lucide-react or @hugeicons/react", () => {
    expect(files.filter(({ r, imp }) => imp.some((s) => s.startsWith("@hugeicons/core-free-icons")) && r !== `${UI}ui/icons.ts`).map((f) => f.r))
      .toEqual([]);
    expect(files.filter(({ imp }) => imp.some((s) => s === "lucide-react" || s.startsWith("lucide-react/") || s.startsWith("@hugeicons/react")))
      .map((f) => f.r)).toEqual([]);
  });

  it("animate-pop and animate-swap are never prefixed with motion-safe: (the utility has its own reduced fade)", () => {
    expect(files.filter(({ src }) => /motion-safe:animate-(pop|swap)\b/.test(src)).map((f) => f.r)).toEqual([]);
  });

  it("motion timings come from tokens: no literal duration, delay, easing or spring outside motion/tokens.ts and CSS token definitions", () => {
    expect(motionLiteralViolations(files, cssFiles)).toEqual([]);
  });

  it("every list screen has saved views and the column chooser (SavedViewsMenu, ColumnsMenu + DataTable hidden)", () => {
    expect(columnsMenuViolations(files)).toEqual([]);
    expect(Object.keys(COLUMNS_MENU_ALLOWED).filter((k) => !files.some((x) => x.r === k && LIST_CALL.test(strip(x.src))))).toEqual([]);
  });

  it("a defaultHidden column is reachable: its table renders ColumnsMenu", () => {
    expect(defaultHiddenViolations(files)).toEqual([]);
  });

  it("every page with a list screen is in VIEW_PAGES", () => {
    expect(viewPageViolations(files, VIEW_PAGES)).toEqual([]);
  });

  it("StatusLegend is rendered only by Panel (per-card legend)", () => {
    expect(legendViolations(files)).toEqual([]);
  });

  it("app motion is wired once: (main)/layout.tsx wraps the page in MotionLayer + PageTransitionRoot, (main)/template.tsx renders PageTransition", () => {
    const src = (r: string) => strip(files.find((f) => f.r === r)?.src ?? "");
    expect(src(`${WEB}app/(main)/layout.tsx`)).toMatch(/<MotionLayer>[\s\S]*<PageTransitionRoot>\{children\}<\/PageTransitionRoot>[\s\S]*<\/MotionLayer>/);
    expect(src(`${WEB}app/(main)/template.tsx`)).toMatch(/<PageTransition>\{children\}<\/PageTransition>/);
  });

  it("no literal colour or arbitrary pixel class in .tsx", () => {
    expect(colourLiteralViolations(files)).toEqual([]);
  });
});

/** The rules above are vacuous until shell, features and routes exist; these fixtures prove each checker bites. */
describe("architecture checkers (fixtures)", () => {
  const f = (r: string, src: string): F => ({ r, src, imp: [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!) });

  it("intents: a Remove / Delete button not variant remove, a Create / Add / New button neither create nor default", () => {
    expect(intentViolations([
      f(`${WEB}features/x/a.tsx`, `<Button type="button" variant="ghost" size="icon" aria-label={\`Remove \${n}\`} onClick={() => go()}><Icon icon={RemoveIcon} /></Button>`),
      f(`${WEB}features/x/b.tsx`, `<Button type="button" variant="link" onClick={() => add()}>Add a condition</Button>`),
      f(`${WEB}features/x/c.tsx`, `<Button variant="remove" size="icon" aria-label="Remove row"><Icon icon={RemoveIcon} /></Button><Button variant="create" onClick={() => a()}><Icon icon={AddIcon} />Add a row</Button><Button onClick={() => a()}>Create recon</Button><Button variant="destructive">Remove member</Button><Button variant="destructive">Delete view</Button><Button variant="secondary">Newer first</Button>`),
      f(`${WEB}features/x/d.tsx`, `<button type="button" aria-label="Remove pass 2" className="text-fg-3" onClick={() => r()}>x</button><ButtonGroup>Add a row</ButtonGroup><button type="button" className="text-fg-3">Delete</button>`),
      f(`${WEB}features/x/e.tsx`, `<Button variant="outline" title="a > b" onClick={() => a()}>Add a column</Button>`),
      f(`${WEB}features/x/f.tsx`, `<Button variant="secondary"><Icon icon={AddIcon} />New space</Button><BlockedButton variant="ghost" reason={r}>Create token</BlockedButton><Button variant="ghost" size="icon" aria-label="Add a filter"><Icon icon={AddIcon} /></Button>`),
      f(`${WEB}features/x/g.tsx`, `<Button variant="ghost" onClick={() => d()}>Delete view</Button><Button variant="secondary" size="icon" aria-label="Delete row 2"><Icon icon={RemoveIcon} /></Button>`),
    ])).toEqual([`${WEB}features/x/a.tsx: Remove \${n} is variant="ghost", not remove`, `${WEB}features/x/b.tsx: Add a condition is variant="link", not create`,
      `${WEB}features/x/d.tsx: raw Remove / Delete button without text-down-ink`, `${WEB}features/x/d.tsx: raw Remove / Delete button without text-down-ink`,
      `${WEB}features/x/e.tsx: Add a column is variant="outline", not create`,
      `${WEB}features/x/f.tsx: New space is variant="secondary", not create`, `${WEB}features/x/f.tsx: Create token is variant="ghost", not create`, `${WEB}features/x/f.tsx: Add a filter is variant="ghost", not create`,
      `${WEB}features/x/g.tsx: Delete view is variant="ghost", not remove`, `${WEB}features/x/g.tsx: Delete row 2 is variant="secondary", not remove`]);
  });
  it("intents: a negative decision not variant caution, an Edit / Replace / Export / Retry without its icon", () => {
    expect(intentViolations([
      f(`${WEB}features/x/a.tsx`, `<Button type="button" variant="secondary" onClick={() => open({ a: 1 })}>Reject</Button><BlockedButton variant="ghost" reason={r}>Cancel request</BlockedButton>`),
      f(`${WEB}features/x/b.tsx`, `<Button variant="caution" onClick={() => x()}><Icon icon={ErrorIcon} />Reject</Button><Button variant="destructive">Turn off connector</Button><Button>Turn the page</Button>`),
      f(`${WEB}features/x/c.tsx`, `<Button variant="edit" size="sm" onClick={() => go(5)}>Edit</Button><Button asChild variant="edit"><Link href={\`/u/\${id}/edit\`}>Edit user</Link></Button><Button variant="secondary" onClick={retry}>Retry</Button>`),
      f(`${WEB}features/x/d.tsx`, `<Button variant="edit" onClick={() => go()}><Icon icon={EditIcon} />Edit<span className="sr-only"> code</span></Button><Button asChild variant="edit"><Link href="/e"><Icon icon={EditIcon} />Edit user</Link></Button><Button variant="secondary"><Icon icon={ExportIcon} />Export CSV</Button><Button>Editor settings</Button>`),
    ])).toEqual([`${WEB}features/x/a.tsx: Reject is variant="secondary", not caution`, `${WEB}features/x/a.tsx: Cancel request is variant="ghost", not caution`,
      `${WEB}features/x/c.tsx: Edit without its icon`, `${WEB}features/x/c.tsx: Edit user without its icon`, `${WEB}features/x/c.tsx: Retry without its icon`]);
  });
  it("intents: a Button labelled Edit … is variant edit, as every other Edit (a BlockedButton too)", () => {
    expect(intentViolations([
      f(`${WEB}features/x/a.tsx`, `<Button asChild variant="ghost"><Link href="/p/1/edit"><Icon icon={EditIcon} />Edit project</Link></Button><BlockedButton variant="secondary" reason={r}><Icon icon={EditIcon} />Edit rule</BlockedButton>`),
      f(`${WEB}features/x/b.tsx`, `<Button asChild variant="edit"><Link href="/p/1/edit"><Icon icon={EditIcon} />Edit project</Link></Button><Button variant="secondary">Editor settings</Button><Button><Icon icon={EditIcon} />Edit</Button>`),
    ])).toEqual([`${WEB}features/x/a.tsx: Edit project is variant="ghost", not edit`, `${WEB}features/x/a.tsx: Edit rule is variant="secondary", not edit`,
      `${WEB}features/x/b.tsx: Edit is variant="default", not edit`]);
  });
  it("intents: a self-closing Button has no children (the next button's are not its own); a conditional or bare icon is no icon", () => {
    expect(intentViolations([
      f(`${WEB}features/x/a.tsx`, `<Button variant="secondary" {...props} /><Button variant="caution" onClick={() => r()}>Reject</Button><Button variant="ghost" aria-label="Close" />Add a row`),
      f(`${WEB}features/x/b.tsx`, `<Button variant="secondary" onClick={retry}>{busy && <Icon icon={RetryIcon} />}Retry</Button><Button variant="secondary">{busy ? <Spinner /> : <Icon icon={ExportIcon} />}Export CSV</Button>`),
      f(`${WEB}features/x/c.tsx`, `<Button variant="edit"><EditIcon />Edit</Button><Button variant="edit"><IconBadge />Edit user</Button><Button variant="edit"><Icon icon={EditIcon} className="size-4" />Edit rule</Button>`),
    ])).toEqual([`${WEB}features/x/b.tsx: Retry without its icon`, `${WEB}features/x/b.tsx: Export CSV without its icon`,
      `${WEB}features/x/c.tsx: Edit without its icon`, `${WEB}features/x/c.tsx: Edit user without its icon`]);
  });
  it("intents: a View / Open / Review link (Button asChild around a Link) is variant link with a trailing icon", () => {
    expect(intentViolations([
      f(`${WEB}features/x/a.tsx`, `<Button asChild size="sm"><Link href={h(r)}>Review</Link></Button><Button asChild variant="link"><Link href="/h"><Icon icon={ArrowRightIcon} />View history</Link></Button>`),
      f(`${WEB}features/x/b.tsx`, `<Button asChild variant="link" size="sm"><Link href={h(r)}>Review<Icon icon={ArrowRightIcon} /></Link></Button><Button variant="secondary" onClick={() => o()}>Open dialog</Button><Button asChild variant="secondary"><Link href="/x">Go to recon</Link></Button>`),
    ])).toEqual([`${WEB}features/x/a.tsx: Review link is variant="default", not link`, `${WEB}features/x/a.tsx: Review link without its trailing icon`,
      `${WEB}features/x/a.tsx: View history link without its trailing icon`]);
  });
  it("focus ring: outline-none + focus-visible:outline-2 without outline-solid", () => {
    expect(focusRingViolations([
      f(`${UI}ui/a.tsx`, `<b className="outline-none focus-visible:outline-2 focus-visible:outline-primary" />`),
      f(`${UI}ui/b.tsx`, `<b className="outline-none focus-visible:outline-2 focus-visible:outline-solid" />`),
    ])).toEqual([`${UI}ui/a.tsx:1`]);
  });

  it("layer: shell importing a feature, ds importing charts", () => {
    expect(layerViolations([
      f(`${WEB}components/shell/nav.tsx`, `import { X } from "@/features/users/x";`),
      f(`${UI}ds/panel.tsx`, `import { Bar } from "../charts/bar-chart";`),
      f(`${WEB}features/users/page.tsx`, `import { Panel } from "@starterkit/ui/ds"; import { Nav } from "@/components/shell/nav";`),
    ])).toEqual([`${WEB}components/shell/nav.tsx → @/features/users/x`, `${UI}ds/panel.tsx → ../charts/bar-chart`]);
  });

  it("sibling feature via alias and relative path", () => {
    expect(siblingFeatureViolations([
      f(`${WEB}features/users/a.tsx`, `import { R } from "@/features/roles/r"; import { B } from "./b";`),
      f(`${WEB}features/users/c.tsx`, `import { A } from "../audit/a";`),
    ])).toEqual([`${WEB}features/users/a.tsx → @/features/roles/r`, `${WEB}features/users/c.tsx → ../audit/a`]);
  });

  it("client code importing lib/server", () => {
    expect(clientImportsServer([
      f(`${WEB}features/users/a.tsx`, `"use client";\nimport { getSession } from "@/lib/server/session";`),
      f(`${WEB}features/users/b.tsx`, `import { getSession } from "@/lib/server/session";`),
    ])).toEqual([`${WEB}features/users/a.tsx`]);
  });

  it("client fetch/api to an absolute, protocol-relative or ${base} URL; NEXT_PUBLIC API/URL env", () => {
    const bad = clientApiViolations([
      f(`${WEB}features/users/a.tsx`, `await fetch("https://backend.example/api/users"); await api<X>("//evil.example/x"); fetch(\`${"${BASE}"}/api/users\`); fetch('http://x');`),
      f(`${WEB}lib/client/b.ts`, `const u = process.env.NEXT_PUBLIC_API_BASE_URL; const v = process.env.NEXT_PUBLIC_SITE_NAME;`),
      f(`${WEB}app/x/c.tsx`, `"use client";\nfetch("http://x");`),
    ]);
    expect(bad).toHaveLength(6);
    expect(bad.filter((b) => b.includes("NEXT_PUBLIC_API_BASE_URL"))).toHaveLength(1);
    expect(bad.filter((b) => b.includes("SITE_NAME"))).toHaveLength(0);
  });

  it("client EventSource, WebSocket, sendBeacon: absolute URL or non-literal argument", () => {
    expect(clientApiViolations([
      f(`${WEB}features/x/a.tsx`, `new EventSource("https://x.example/e"); new WebSocket(url); navigator.sendBeacon(endpoint, d); new EventSource("/api/stream");`),
    ])).toEqual([
      `${WEB}features/x/a.tsx: new EventSource( must take a literal starting with "/api/"`,
      `${WEB}features/x/a.tsx: new WebSocket( must take a literal starting with "/api/"`,
      `${WEB}features/x/a.tsx: navigator.sendBeacon( must take a literal starting with "/api/"`,
    ]);
  });

  it("client fetch/api to /api/ paths, variables, and server code pass", () => {
    expect(clientApiViolations([
      f(`${WEB}features/users/a.tsx`, `fetch("/api/users"); api<X>(\`/api/users/${"${id}"}\`); fetch(path); // fetch("http://x")`),
      f(`${WEB}lib/server/s.ts`, `fetch("https://backend.example/x"); process.env.NEXT_PUBLIC_API_URL;`),
    ])).toEqual([]);
  });

  it("client value import of a contract or zod; type-only imports and server code pass", () => {
    expect(clientZodViolations([
      f(`${WEB}features/x/a.tsx`, `import { AUTH_EVENTS } from "@starterkit/shared/contracts/audit";\nimport { type Page, ListQuery } from "@starterkit/shared/contracts/common";`),
      f(`${WEB}lib/client/b.ts`, `import { z } from "zod";\nimport "zod/v4/core";`),
      f(`${WEB}app/x/c.tsx`, `"use client";\nimport { UserDto } from "@starterkit/shared/contracts/users";`),
      f(`${WEB}features/x/ok.tsx`, `import type { Page } from "@starterkit/shared/contracts/common";\nimport { type UserDto, type X } from "@starterkit/shared/contracts/users";\nimport { AUTH_EVENTS } from "@starterkit/shared/audit";`),
      f(`${WEB}lib/server/s.ts`, `import { ListQuery } from "@starterkit/shared/contracts/common";\nimport { z } from "zod";`),
    ])).toEqual([
      `${WEB}features/x/a.tsx: value import from @starterkit/shared/contracts/audit`,
      `${WEB}features/x/a.tsx: value import from @starterkit/shared/contracts/common`,
      `${WEB}lib/client/b.ts: value import from zod`,
      `${WEB}lib/client/b.ts: value import from zod/v4/core`,
      `${WEB}app/x/c.tsx: value import from @starterkit/shared/contracts/users`,
    ]);
  });

  it("shared fixtures: React, Next, app paths, @/ and other @starterkit packages are caught; ui/lib and relative pass", () => {
    const f = (r: string, src: string): F => ({ r, src, imp: importsIn(src) });
    expect(sharedViolations([
      f(`${SHARED}a.ts`, `import { useState } from "react";\nimport { x } from "next/headers";`),
      f(`${SHARED}b.ts`, `import { y } from "@/lib/server/x";\nimport { z } from "../../../apps/web/src/y";`),
      f(`${SHARED}c.ts`, `import { w } from "@starterkit/ui/ds";\nimport { v } from "@starterkit/ui/ui/button";`),
      f(`${SHARED}ok.ts`, `import { appDate } from "@starterkit/ui/lib/format";\nimport { a } from "./contracts/audit";\nimport { z } from "zod";`),
    ])).toEqual([
      `${SHARED}a.ts → react`, `${SHARED}a.ts → next/headers`,
      `${SHARED}b.ts → @/lib/server/x`, `${SHARED}b.ts → ../../../apps/web/src/y`,
      `${SHARED}c.ts → @starterkit/ui/ds`, `${SHARED}c.ts → @starterkit/ui/ui/button`,
    ]);
  });

  it("runtime imports: bun, bun:sqlite, pg, @starterkit/api and paths into apps/api are caught; node: and packages pass", () => {
    const g = (r: string, src: string): F => ({ r, src, imp: importsIn(src) });
    expect(runtimeViolations([
      g(`${WEB}lib/server/a.ts`, `import { SQL } from "bun";\nimport { Database } from "bun:sqlite";\nimport { Pool } from "pg";`),
      g(`${WEB}lib/server/b.ts`, `import { createApp } from "@starterkit/api/app";\nimport { sql } from "../../../../api/src/db/client";`),
      g(`${WEB}lib/server/ok.ts`, `import { randomUUID } from "node:crypto";\nimport { z } from "zod";\nimport { BRAND } from "@starterkit/shared/brand";
import { INTENTS } from "@starterkit/ui/ds";\nimport x from "bunyan";`),
      g(`${UI}lib/c.ts`, `import { SQL } from "bun";`),
    ])).toEqual([
      `${WEB}lib/server/a.ts → bun`, `${WEB}lib/server/a.ts → bun:sqlite`, `${WEB}lib/server/a.ts → pg`,
      `${WEB}lib/server/b.ts → @starterkit/api/app`, `${WEB}lib/server/b.ts → ../../../../api/src/db/client`,
    ]);
  });

  it("route files: an extra route.ts under app/ (api or not) shows up in the list", () => {
    const g = (r: string): F => ({ r: WEB + r, src: "", imp: [] });
    expect(routeFiles([g("app/api/users/route.ts"), g("app/(main)/export/route.ts"), g("app/api/[...path]/route.ts"), g("app/(main)/page.tsx")]))
      .toEqual([`${WEB}app/(main)/export/route.ts`, `${WEB}app/api/[...path]/route.ts`, `${WEB}app/api/users/route.ts`]);
  });

  it("strip() removes comments but keeps strings, templates and regex literals whole", () => {
    expect(strip(`const u = "https://x"; // note\nconst r = /\\/\\/.*$/g; /* block */ const t = \`a // b\`;`))
      .toBe(`const u = "https://x"; \nconst r = /\\/\\/.*$/g;  const t = \`a // b\`;`);
    expect(strip(`const q = "it's"; x = a / b; // c`)).toBe(`const q = "it's"; x = a / b; `);
    expect(strip(`const re = /["']/; y(); // z`)).toBe(`const re = /["']/; y(); `);
    expect(strip(`<Panel legend={L} /> // <StatusLegend />`)).toBe(`<Panel legend={L} /> `);
  });

  it("client-API rule: a comment right after code is ignored, a URL with // in a string still checked", () => {
    expect(clientApiViolations([
      f(`${WEB}features/x/a.tsx`, `fetch("/api/x");// fetch("http://x")\nconst s = "a //b"; fetch("https://evil.example/x");`),
    ])).toEqual([`${WEB}features/x/a.tsx: fetch("https://evil…) must start with "/api/"`]);
  });

  it("zod import check: a side-effect import followed by a type-only contract import passes", () => {
    expect(clientZodViolations([
      f(`${WEB}features/x/a.tsx`, `import "./x.css";\nimport type { A } from "@starterkit/shared/contracts/audit";`),
    ])).toEqual([]);
  });

  it("motion literals in TS/TSX and CSS; tokens, token definitions and 0ms pass", () => {
    const bad = motionLiteralViolations([
      f(`${UI}ui/a.tsx`, `<div className="transition-opacity duration-200" />`),
      f(`${UI}ui/b.tsx`, `animate(el, { x: 0 }, { duration: 0.2 });`),
      f(`${UI}ui/c.tsx`, `const t = { ease: [0.2, 0, 0, 1] };`),
      f(`${UI}ui/d.tsx`, `style={{ transition: "opacity 200ms ease" }}`),
      f(`${UI}ui/e.tsx`, `const s = { type: "spring", stiffness: 420 };`),
      f(`${UI}charts/f.tsx`, "const m = { animationDelay: `${Math.min(200, i * 12)}ms` };"),
      f(`${WEB}features/g.tsx`, `const e = "cubic-bezier(0.2, 0, 0, 1)";`),
      f(`${UI}motion/h.tsx`, `const t = { duration: DUR.instant, ease: "linear" };`),
      f(`${UI}motion/i.tsx`, `animate(0, 1, { type: "spring", bounce: 0 });`),
      f(`${UI}charts/j.ts`, `const SETTLE_MS = Math.round((DUR.slow + 0.32) * 1000);`),
      f(`${UI}charts/k.ts`, `const d = 0.05 + STAGGER.step;`),
      f(`${UI}charts/ok2.ts`, `const a = DUR.enter * 1000; const b = Math.max(DUR.slow + CHART_STAGGER.max, DUR.draw); animate(0, 1, { ...SPRING_TWEEN, duration: s, ease: EASE.linear });`),
      f(`${UI}ui/ok.tsx`, "<div className=\"duration-(--dur-fast)\" style={{ animationDelay: `${staggerDelay(i)}s` }} /> // duration-200 in a comment"),
      f(MOTION_TOKENS, `export const DUR = { fast: 0.15 }; export const EASE = { out: [0.22, 1, 0.36, 1] };`),
    ], [
      f(`${UI}styles/x.css`, `.a { transition: opacity 150ms linear; }\n.b { animation-delay: 35ms; }\n.c { animation: s 1.2s linear infinite; }\n.d { transition-timing-function: cubic-bezier(0, 0, 1, 1); }`),
      f(`${UI}styles/ok.css`, `:root { --dur-fast: 150ms; --ease-out: cubic-bezier(0.22, 1, 0.36, 1); }\n.e { animation-delay: 0ms; height: 100svh; transition: opacity var(--dur-fast) var(--ease-out); } /* 200ms */`),
    ]);
    expect(bad).toEqual([
      `${UI}ui/a.tsx: duration-2`, `${UI}ui/b.tsx: duration: 0`, `${UI}ui/c.tsx: ease: [`, `${UI}ui/d.tsx:  200ms ease`,
      `${UI}ui/e.tsx: stiffness: 4`, `${UI}charts/f.tsx: animationDelay: \`\${Math.min(200`, `${WEB}features/g.tsx: cubic-bezier(`,
      `${UI}motion/h.tsx: ease: "`, `${UI}motion/i.tsx: bounce: 0`, `${UI}charts/j.ts: DUR.slow + 0`, `${UI}charts/k.ts: 5 + STAGGER.step`,
      `${UI}styles/x.css: 150ms`, `${UI}styles/x.css: 35ms`, `${UI}styles/x.css: 1.2s`, `${UI}styles/x.css: cubic-bezier(`,
    ]);
  });

  it("the vendored affect folder alone keeps its own colours and timings; a sibling folder or a feature is reported", () => {
    const own = (r: string) => f(r, `const css = "a { color: #171717; }"; el.animate(k, { duration: 480 });`);
    expect(colourLiteralViolations([own(`${UI}affect/button.tsx`), own(`${UI}affects/x.tsx`), own(`${WEB}features/ds/affect/x.tsx`)]))
      .toEqual([`${UI}affects/x.tsx: #171717`, `${WEB}features/ds/affect/x.tsx: #171717`]);
    expect(motionLiteralViolations([own(`${UI}affect/button.tsx`), own(`${UI}affects/x.tsx`), own(`${WEB}features/ds/affect/x.tsx`)], []))
      .toEqual([`${UI}affects/x.tsx: duration: 4`, `${WEB}features/ds/affect/x.tsx: duration: 4`]);
  });
  it("a zone literal in apps/web is reported", () => {
    expect(zoneViolations([f(`${WEB}features/x/a.tsx`, "const t = `${formatTime(at)} WIB`;"), f(`${WEB}features/x/b.tsx`, `formatTime(at); // 14:00 WIB`)]))
      .toEqual([`${WEB}features/x/a.tsx`]);
  });

  it("a page guard that differs from pagePerm is reported", () => {
    expect(pageGuardViolations([
      f(`${WEB}app/(main)/roles/page.tsx`, `await requirePagePermission("user.view");`),
      f(`${WEB}app/(main)/users/new/page.tsx`, `await requirePagePermission("user.create");`),
      f(`${WEB}app/(main)/audit/auth/page.tsx`, `export default function P() {}`),
    ])).toEqual([
      `${WEB}app/(main)/roles/page.tsx: guards with user.view, pagePerm("/roles") is role.view`,
      `${WEB}app/(main)/audit/auth/page.tsx: guards with nothing, pagePerm("/audit/auth") is audit.view`,
    ]);
  });

  it("overflow-*-auto without scroll-quiet is reported; with it, or overflow-hidden, passes", () => {
    expect(scrollViolations([
      f(`${UI}ui/a.tsx`, `<div className="max-h-80 overflow-y-auto" />`),
      f(`${WEB}features/x/b.tsx`, "<div className={`grid ${x} overflow-x-auto`} />"),
      f(`${UI}ui/ok.tsx`, `<div className="scroll-quiet overflow-auto" /><div className="overflow-hidden" />`),
    ])).toEqual([`${UI}ui/a.tsx: overflow-y-auto without scroll-quiet`, `${WEB}features/x/b.tsx: overflow-x-auto without scroll-quiet`]);
  });

  it("a raw password input and a new-password field without its checklist are reported; PasswordInput passes", () => {
    expect(passwordFieldViolations([
      f(`${WEB}features/auth/a.tsx`, `<Input id="p" type="password" />`),
      f(`${WEB}features/me/b.tsx`, `<Input type={show ? "text" : "password"} />`),
      f(`${WEB}features/me/c.tsx`, `<PasswordInput id="p" autoComplete="current-password" /> // type="password" in a comment`),
      f(PASSWORD_HOME, `<Input type={shown ? "text" : "password"} />`),
    ])).toEqual([`${WEB}features/auth/a.tsx: a raw password input; use PasswordInput`, `${WEB}features/me/b.tsx: a raw password input; use PasswordInput`]);
    expect(newPasswordViolations([
      f(`${WEB}features/users/form.tsx`, `<PasswordInput autoComplete="new-password" />`),
      f(`${WEB}features/me/ok.tsx`, `<PasswordInput autoComplete="new-password" /><PasswordChecks id="c" checks={passwordChecks(pw)} />`),
    ])).toEqual([`${WEB}features/users/form.tsx: a new-password field without PasswordChecks`]);
  });

  it("a literal product name outside brand.ts is reported; BRAND.name and the package scope pass", () => {
    expect(brandViolations([
      f(`${WEB}app/(main)/users/page.tsx`, `export const metadata = { title: "Users · ${BRAND.name}" };`),
      f(`${WEB}features/x/a.tsx`, `<Failure source={BRAND.name} />; import { Panel } from "@starterkit/ui/ds";`),
      f(BRAND_HOME, `export const BRAND = { name: "${BRAND.name}" } as const;`),
    ])).toEqual([`${WEB}app/(main)/users/page.tsx: write BRAND.name, not the product name`]);
  });

  it("a list screen without SavedViewsMenu or ColumnsMenu, or not passing hidden to DataTable, is reported", () => {
    const msg = "a list screen renders SavedViewsMenu and ColumnsMenu and passes hidden to DataTable";
    expect(columnsMenuViolations([
      f(`${WEB}features/a/list.tsx`, `const t = useTableQuery({}); <SavedViewsMenu /> <DataTable columns={c} />`),
      f(`${WEB}features/b/list.tsx`, `const t = useTableQuery({}); <SavedViewsMenu /> <ColumnsMenu columns={c} hidden={t.hidden} /> <DataTable columns={c} />`),
      f(`${WEB}features/e/list.tsx`, `const t = useTableQuery<T, F>({}); <ColumnsMenu columns={c} hidden={t.hidden} /> <DataTable columns={c} hidden={t.hidden} />`),
      f(`${WEB}features/c/list.tsx`, `const t = useTableQuery({}); <SavedViewsMenu /> <ColumnsMenu columns={c} hidden={t.hidden} onChange={t.setHidden} /> <DataTable columns={c} hidden={t.hidden} />`),
      f(`${WEB}features/d/detail.tsx`, `<DataTable columns={c} rows={u.recent} />`),
      f(`${WEB}features/f/picker.tsx`, `const t = useTableQuery({}); <DataTable columns={c} />`),
    ], { [`${WEB}features/f/picker.tsx`]: "a picker" })).toEqual([`${WEB}features/a/list.tsx: ${msg}`, `${WEB}features/b/list.tsx: ${msg}`, `${WEB}features/e/list.tsx: ${msg}`]);
  });

  it("fixture: a defaultHidden column on a table without ColumnsMenu, in the file or through a columns module", () => {
    expect(defaultHiddenViolations([
      f(`${WEB}features/a/list.tsx`, `const c = [{ key: "at", defaultHidden: true }]; <ColumnsMenu columns={c} /> <DataTable columns={c} />`),
      f(`${WEB}features/b/list.tsx`, `const c = [{ key: "at", defaultHidden: true }]; <DataTable columns={c} />`),
      f(`${WEB}features/c/c-columns.tsx`, `export const cols = [{ key: "at", defaultHidden: true }];`),
      f(`${WEB}features/c/list.tsx`, `import { cols } from "./c-columns"; <DataTable columns={cols} />`),
      f(`${WEB}features/c/page.tsx`, `import { cols } from "./c-columns"; <ColumnsMenu columns={cols} /> <DataTable columns={cols} />`),
      f(`${WEB}features/d/list.tsx`, `const c = [{ key: "at", defaultHidden: false }]; <DataTable columns={c} />`),
    ])).toEqual([`${WEB}features/b/list.tsx: a defaultHidden column without ColumnsMenu`, `${WEB}features/c/list.tsx: a defaultHidden column (${WEB}features/c/c-columns.tsx) without ColumnsMenu`]);
  });

  it("fixture: a shared file outside contracts/ importing zod", () => {
    expect(sharedZodViolations([
      f(`${SHARED}contracts/things.ts`, `import { z } from "zod";`),
      f(`${SHARED}things.ts`, `import { z } from "zod";`),
      f(`${SHARED}limits.ts`, `import type { ZodType } from "zod/v4";`),
      f(`${SHARED}paging.ts`, `export const MAX_PAGE = 1000;`),
    ])).toEqual([
      `${SHARED}things.ts: only packages/shared/src/contracts/ imports zod; client code imports this file as values`,
      `${SHARED}limits.ts: only packages/shared/src/contracts/ imports zod; client code imports this file as values`,
    ]);
  });

  it("fixture: a page rendering a list screen, directly or through its feature folder, must be in VIEW_PAGES (a dynamic route by its pattern)", () => {
    const list = `const t = useTableQuery({}); <SavedViewsMenu />`;
    const fs = [
      f(`${WEB}app/(main)/things/page.tsx`, `import { ThingsPage } from "@/features/things/things-page";`),
      f(`${WEB}features/things/things-page.tsx`, list),
      f(`${WEB}app/(main)/logs/page.tsx`, `import { LogsPage } from "@/features/logs/logs-page";`),
      f(`${WEB}features/logs/logs-page.tsx`, `import { LogTable } from "./log-table";`),
      f(`${WEB}features/logs/log-table.tsx`, `const t = useTableQuery<T, F>(table); <SavedViewsMenu />`),
      f(`${WEB}app/(main)/things/[id]/page.tsx`, `import { ThingDetail } from "@/features/things/thing-detail";`),
      f(`${WEB}features/things/thing-detail.tsx`, `<p>One thing</p>`),
      f(`${WEB}app/(main)/groups/[groupId]/items/page.tsx`, `import { ItemsPage } from "@/features/groups/items-page";`),
      f(`${WEB}features/groups/items-page.tsx`, list),
      f(`${WEB}app/(main)/about/page.tsx`, `import { About } from "@/features/about/about";`),
      f(`${WEB}features/about/about.tsx`, `<p>Text</p>`),
    ];
    const groups = `${WEB}app/(main)/groups/[groupId]/items/page.tsx: renders a list screen; add "/groups/[groupId]/items" to VIEW_PAGES (lib/shared/prefs.ts)`;
    expect(viewPageViolations(fs, ["/logs", "/groups/[groupId]/items"])).toEqual([`${WEB}app/(main)/things/page.tsx: renders a list screen; add "/things" to VIEW_PAGES (lib/shared/prefs.ts)`]);
    expect(viewPageViolations(fs, ["/things", "/groups/[groupId]/items"])).toEqual([`${WEB}app/(main)/logs/page.tsx: renders a list screen; add "/logs" to VIEW_PAGES (lib/shared/prefs.ts)`]);
    // A dynamic route is checked too, by its pattern: one list view for every id.
    expect(viewPageViolations(fs, ["/things", "/logs"])).toEqual([groups]);
    expect(viewPageViolations(fs, ["/things", "/logs", "/groups/[groupId]/items"])).toEqual([]);
  });

  it("StatusLegend outside Panel (page header, toolbar, gallery) is reported; Panel and StatusLegendList pass", () => {
    expect(legendViolations([
      f(`${WEB}features/users/page.tsx`, `<Toolbar end={<StatusLegend items={LEGEND} />} />`),
      f(`${WEB}features/ds/gallery.tsx`, `<PageHeader actions={<StatusLegend items={L} />} />`),
      f(LEGEND_HOME, `{legend && <StatusLegend items={legend} />}`),
      f(`${UI}ds/status-legend.tsx`, `<StatusLegendList items={items} />`),
      f(`${WEB}features/audit/x.tsx`, `<Panel legend={LEGEND} /> // <StatusLegend items={x} />`),
    ])).toEqual([
      `${WEB}features/users/page.tsx: renders StatusLegend; pass Panel legend instead`,
      `${WEB}features/ds/gallery.tsx: renders StatusLegend; pass Panel legend instead`,
    ]);
  });
  it("fixture: a next/dynamic call without ssr: false is reported unless allowlisted; ssr: false (any layout) passes", () => {
    const fx = [
      f(`${WEB}features/users/a.tsx`, `import dynamic from "next/dynamic";\nconst P = dynamic(() => import("./panel").then((m) => m.P));`),
      f(`${WEB}features/users/b.tsx`, `import dynamic from "next/dynamic";\nconst F = dynamic(() => import("./filters").then((m) => m.F), {\n  loading: () => <Spin />,\n});`),
      f(`${WEB}features/users/c.tsx`, `import dynamic from "next/dynamic";\nconst D = dynamic(() => import("./dialog").then((m) => m.D), { ssr: false });\nconst E = dynamic(\n  () => import("./e"),\n  { loading: () => null, ssr: false },\n);`),
      f(`${WEB}features/users/d.tsx`, `import lazy from "next/dynamic";\nconst G = lazy(() => import("./g")); // dynamic(() => import("./x"))`),
      f(`${WEB}features/users/e.tsx`, `const dynamic = (x: unknown) => x; dynamic(() => import("./h"));`),
    ];
    expect(dynamicSsrViolations(fx, {})).toEqual([
      `${WEB}features/users/a.tsx → ./panel: pass ssr: false (or allowlist it with a reason)`,
      `${WEB}features/users/b.tsx → ./filters: pass ssr: false (or allowlist it with a reason)`,
      `${WEB}features/users/d.tsx → ./g: pass ssr: false (or allowlist it with a reason)`,
    ]);
    expect(dynamicSsrViolations(fx, { [`${WEB}features/users/a.tsx → ./panel`]: "reason", [`${WEB}features/users/b.tsx → ./filters`]: "reason", [`${WEB}features/users/d.tsx → ./g`]: "reason" })).toEqual([]);
  });
  it("fixture: the ssr: false check sees a type argument, a space before the parenthesis and a named default import", () => {
    expect(dynamicSsrViolations([
      f(`${WEB}features/users/f.tsx`, `import dynamic from "next/dynamic";\nconst A = dynamic<{ id: string }>(() => import("./typed"));\nconst B = dynamic<Props<X>>(() => import("./nested"), { ssr: false });`),
      f(`${WEB}features/users/g.tsx`, `import dynamic from "next/dynamic";\nconst C = dynamic (() => import("./spaced"));`),
      f(`${WEB}features/users/h.tsx`, `import { default as later } from "next/dynamic";\nconst D = later(() => import("./aliased"));\nconst E = later<P>(() => import("./ok"), { ssr: false });`),
    ], {})).toEqual([
      `${WEB}features/users/f.tsx → ./typed: pass ssr: false (or allowlist it with a reason)`,
      `${WEB}features/users/g.tsx → ./spaced: pass ssr: false (or allowlist it with a reason)`,
      `${WEB}features/users/h.tsx → ./aliased: pass ssr: false (or allowlist it with a reason)`,
    ]);
  });
});
