import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UsersIcon } from "../ui/icons";
import { Panel } from "./panel";
import { Avatar } from "./avatar";
import { TickMeter } from "./meter";
import { StatTile } from "./stat-tile";
import { PasswordChecks } from "./password-checks";
import { Segmented } from "./segmented";
import { Pagination } from "./pagination";
import { Button } from "../ui/button";
import { ActionCard } from "./action-card";
import { CompareCard } from "./compare-card";
import { EditorRow } from "./editor-row";
import { CategoryChip } from "./badges";
import { PageZone } from "./page-zone";
import { BlockedButton } from "./blocked-button";
import { TooltipProvider } from "../ui/tooltip";

/** Server markup of the v3 signature components (spec §5.4, §5.5): structure and copy, not pixels. */
const html = (el: ReturnType<typeof h>) => renderToStaticMarkup(el);

describe("Panel (tray + card)", () => {
  it("tray holds the header (title-3 600, fg-2 icon, count, caption) and one card with the content", () => {
    const out = html(h(Panel, { title: "Sessions", count: 312, description: "Newest first", icon: UsersIcon, children: h("p", null, "body") }));
    expect(out).toMatch(/^<section class="[^"]*rounded-xl[^"]*bg-tray[^"]*p-tray/);
    expect(out).toContain('<h2 class="text-title-3 text-fg">Sessions</h2>');
    expect(out).toMatch(/<svg[^>]*class="[^"]*size-4 shrink-0 text-fg-2/);
    expect(out).toMatch(/data-slot="count-badge"[^>]*>312</);
    expect(out).toContain("Newest first");
    expect(out).toMatch(/<div class="[^"]*rounded-lg border border-line bg-card p-card[^"]*"><p>body<\/p><\/div>/);
  });
  it("flush: the card has no padding (a table is the card); footnote sits under the card", () => {
    const out = html(h(Panel, { title: "Table", flush: true, footnote: "Data from 14:02 WIB · Metrics", children: h("table") }));
    expect(out).toMatch(/bg-card overflow-clip"><table><\/table><\/div><div class="[^"]*text-caption text-fg-3">Data from 14:02 WIB · Metrics<\/div>/);
  });
  it("description: after a middot on the title row; on a phone its own line, no middot", () => {
    const out = html(h(Panel, { title: "Users", description: "Select rows", children: "x" }));
    expect(out).toMatch(/<p class="min-w-0 grow basis-48 text-body-sm text-fg-3 max-md:order-last max-md:basis-full"><span aria-hidden="true" class="mr-2 text-fg-4 max-md:hidden">·<\/span>Select rows<\/p>/);
  });
  it("tone quiet (history): no tray fill, the title in fg-2, the card unchanged", () => {
    const out = html(h(Panel, { title: "Run history", tone: "quiet", children: "x" }));
    const tray = /^<section class="([^"]*)"/.exec(out)![1]!.split(" ");
    expect(tray).toEqual(expect.arrayContaining(["bg-transparent", "border-line"]));
    expect(tray).not.toContain("bg-tray");
    expect(out).toContain('<h2 class="text-title-3 text-fg-2">Run history</h2>');
    expect(out).toContain("bg-card");
  });
  it("flat: card only, no tray; cards: no inner card wrapper", () => {
    expect(html(h(Panel, { variant: "flat", children: "x" }))).not.toContain("bg-tray");
    const cards = html(h(Panel, { title: "KPIs", cards: true, children: h("i") }));
    expect(cards).not.toContain("bg-card");
  });
});

describe("affectUI look (design-system.md §3.7)", () => {
  it("Segmented: the track keeps its 1 px box (base.css makes it transparent), segments one radius step under it", () => {
    const out = html(h(Segmented, { label: "Range", value: "a", onChange: () => {}, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }));
    const track = /<div role="radiogroup"[^>]*class="([^"]*)"/.exec(out)![1]!.split(" ");
    expect(track).toEqual(expect.arrayContaining(["rounded-ctl", "border", "bg-tray", "p-0.5"]));
    expect(out).toContain("rounded-sm"); expect(out).not.toContain("rounded-md");
  });
  it("Pagination: the current page is a tray fill without a line", () => {
    const out = html(h(Pagination, { label: "Users", page: 2, pageSize: 15, total: 60, onPageChange: () => {} }));
    const current = /aria-current="page"[^>]*class="([^"]*)"/.exec(out)![1]!.split(" ");
    expect(current).toEqual(expect.arrayContaining(["border", "border-transparent", "bg-tray", "text-fg"]));
    expect(current).not.toContain("border-line");
  });
});

describe("StatTile (KPI)", () => {
  it("number-first delta → pill (arrow + number) right of the label, comparison as caption", () => {
    const out = html(h(StatTile, { label: "AI requests · 24 hours", value: "1,284", delta: { text: "+18% vs previous 24 hours", direction: "up", good: "up" } }));
    expect(out).toMatch(/<span class="-my-0.5 ml-auto [^"]*bg-healthy-soft text-healthy-ink"><svg[^>]*aria-hidden="true"[^>]*>.*?<\/svg>\+18%<\/span>/);
    expect(out).toContain('<span class="text-caption text-fg-3">vs previous 24 hours</span>');
    expect(out).toContain(">1,284<");
  });
  it("bad direction tints Down; text that is not number-first stays a caption without a pill", () => {
    expect(html(h(StatTile, { label: "Cost", value: "4.2", delta: { text: "+8.2% vs previous 7 days", direction: "up", good: "down" } }))).toContain("bg-down-soft text-down-ink");
    const flat = html(h(StatTile, { label: "Developers connected", value: "4", delta: { text: "19 of 24 services running", direction: "flat", good: null } }));
    expect(flat).not.toContain("rounded-full px-1.5");
    expect(flat).toContain('<span class="text-caption text-fg-3">19 of 24 services running</span>');
  });
  it("unit in fg-3; tween keeps the final value for screen readers", () => {
    const out = html(h(StatTile, { label: "Tokens", value: "4.6", unit: "M", tween: { value: 4.6, format: (v: number) => v.toFixed(1) } }));
    expect(out).toMatch(/<span class="ml-0\.5 text-body font-normal tracking-normal text-fg-3">M<\/span>/);
    expect(out).toContain('<span class="sr-only">4.6</span>');
  });
  it("caption without a delta: caption line, no pill", () => {
    const out = html(h(StatTile, { label: "Tokens", value: "1,204", caption: "1,204 tokens today" }));
    expect(out).toContain('<span class="text-caption text-fg-3">1,204 tokens today</span>');
    expect(out).not.toContain("rounded-full px-1.5");
  });
  it("caption overrides the comparison under the value; the pill stays", () => {
    const out = html(h(StatTile, { label: "AI requests", value: "12", caption: "Last 7 days · vs previous 7 days", delta: { text: "+15% vs previous 7 days", direction: "up", good: null } }));
    expect(out).toContain(">Last 7 days · vs previous 7 days</span>");
    expect(out).toMatch(/bg-tray text-fg-2"><svg[^>]*>.*?<\/svg>\+15%<\/span>/);
  });
});

describe("PasswordChecks", () => {
  it("a met item is fg with a tick, an open one fg-3 with a ring; each says its state to a screen reader; no live region", () => {
    const out = html(h(PasswordChecks, { id: "pw-checks", checks: [{ label: "At least 12 characters", met: true }, { label: "The two passwords match", met: false }] }));
    expect(out).toMatch(/^<ul id="pw-checks"/);
    expect(out).toMatch(/<li class="[^"]*text-fg"><svg[^>]*aria-hidden="true"[^>]*>.*?<\/svg>At least 12 characters<span class="sr-only">, done<\/span><\/li>/);
    expect(out).toMatch(/<li class="[^"]*text-fg-3"><span aria-hidden="true"[^>]*rounded-full[^>]*><\/span>The two passwords match<span class="sr-only">, not yet<\/span><\/li>/);
    expect(out).not.toMatch(/aria-live|role="status"|role="alert"/);
  });
});

describe("Avatar", () => {
  it("seed picks the tint, the name gives the initials: one developer looks the same on every page", () => {
    const a = html(h(Avatar, { name: "Rina Wulandari", seed: "20990001" }));
    const b = html(h(Avatar, { name: "Rina", seed: "20990001" }));
    const tint = (s: string) => /bg-chart-\d\/15/.exec(s)?.[0];
    expect(tint(a)).toBe(tint(b));
    expect(a).toContain(">RW</span>");
    expect(b).toContain(">R</span>");
  });
  it("without a seed the name seeds the tint (v2 behaviour)", () => {
    const tint = (s: string) => /bg-chart-\d\/15/.exec(s)?.[0];
    expect(tint(html(h(Avatar, { name: "Dimas" })))).toBe(tint(html(h(Avatar, { name: "Other", seed: "Dimas" }))));
  });
});

describe("TickMeter compact (table cell)", () => {
  it("24 ticks of 2 × 10 px, threshold 12 px, value text above; the label stays the meter's name only", () => {
    const out = html(h(TickMeter, { label: "Home", ratio: 0.5, value: "10 GB / 20 GB", threshold: 0.8, size: "compact" }));
    expect(out.match(/w-0\.5/g)).toHaveLength(24);
    expect(out.match(/h-2\.5 /g)).toHaveLength(23);
    expect(out).toMatch(/h-3 bg-fg-2/);
    expect(out).toContain('aria-label="Home"');
    expect(out).toContain('aria-valuetext="10 GB / 20 GB"');
    expect(out).not.toContain(">Home<");
    expect(out).toContain(">10 GB / 20 GB</span>");
  });
});

describe("Notice", () => {
  it("only a running process spins: progress has the spinner; warn (a failure) the warning icon; info the info icon", async () => {
    const { Notice, NOTICE_ICON } = await import("./notice");
    const { InfoIcon, SpinnerIcon, WarningIcon } = await import("../ui/icons");
    expect(NOTICE_ICON).toEqual({ info: InfoIcon, warn: WarningIcon, progress: SpinnerIcon });
    expect(html(h(Notice, { tone: "progress", children: "Updating the preview" }))).toContain("animate-spin");
    for (const tone of ["info", "warn"] as const) expect(html(h(Notice, { tone, children: "Pull failed" }))).not.toContain("animate-spin");
  });
});

describe("TableCell", () => {
  it("long text wraps in the column, also in a Truncate or truncate span inside it; nowrap stays possible per cell", async () => {
    const { TableCell, CELL_WRAP } = await import("../ui/table");
    const out = html(h("table", null, h("tbody", null, h("tr", null, h(TableCell, null, "A long source name that wraps"))))).replaceAll("&amp;", "&");
    for (const c of CELL_WRAP.split(" ")) expect(out).toContain(c);
    expect(out).not.toContain("whitespace-nowrap");
    expect(html(h("table", null, h("tbody", null, h("tr", null, h(TableCell, { className: "whitespace-nowrap" }, "14:05")))))).toContain("whitespace-nowrap");
  });
});

const classOf = (out: string, slot: string) => new RegExp(`data-slot="${slot}" class="([^"]*)"`).exec(out)![1]!.split(" ");

describe("PageZone (audit P2)", () => {
  it("an eyebrow heading and its panels, 16 px apart", () => {
    const out = html(h(PageZone, { title: "History", children: h("p", null, "panel") }));
    expect(classOf(out, "page-zone")).toEqual(expect.arrayContaining(["grid", "gap-gutter"]));
    expect(out).toContain('<h2 class="eyebrow text-fg-3">History</h2><p>panel</p>');
  });
  it("the zone heading is h2; a Panel inside the zone titles itself h3, outside it h2", () => {
    const out = html(h(PageZone, { title: "History", children: h(Panel, { title: "Activity", children: "x" }) }));
    expect(out).toContain('<h2 class="eyebrow text-fg-3">History</h2>');
    expect(out).toContain('<h3 class="text-title-3 text-fg">Activity</h3>');
    expect(out).not.toContain(">Activity</h2>");
    expect(html(h(Panel, { title: "Activity", children: "x" }))).toContain('<h2 class="text-title-3 text-fg">Activity</h2>');
  });
});

describe("EditorRow (audit P7)", () => {
  it("the fixed grid: 9rem lead, main, 2rem trailing, tops aligned; one column on a phone", () => {
    const c = classOf(html(h(EditorRow, { lead: "Level 1", children: "x" })), "editor-row");
    expect(c).toEqual(expect.arrayContaining(["grid", "grid-cols-1", "items-start", "gap-2", "md:grid-cols-[9rem_minmax(0,1fr)_2rem]"]));
  });
  it("the trailing column is reserved when absent (invisible), filled when given", () => {
    const empty = html(h(EditorRow, { lead: "Level 1", children: "x" }));
    expect(empty).toMatch(/<div aria-hidden="true" class="invisible max-md:hidden"><\/div><\/div>$/);
    const filled = html(h(EditorRow, { lead: "Level 2", trailing: h("button", null, "Remove"), children: "x" }));
    expect(filled).toContain("<button>Remove</button>");
    expect(filled).not.toContain("invisible");
  });
});

describe("EditorRow on a phone (one column)", () => {
  it("no lead: its cell is there from md (the column), gone on a phone, so no empty row and gap", () => {
    const out = html(h(EditorRow, { lead: null, children: "x" }));
    expect(out).toMatch(/^<div data-slot="editor-row" class="[^"]*"><div class="[^"]*\bmax-md:hidden\b[^"]*"><\/div>/);
  });
  it("a trailing control's wrapper is no box on a phone (the control places itself), a flex cell from md", () => {
    const out = html(h(EditorRow, { lead: "Level 2", trailing: h("button", null, "Remove"), children: "x" }));
    const wrap = /<div class="([^"]*)"><button>Remove<\/button>/.exec(out)![1]!.split(" ");
    expect(wrap).toEqual(expect.arrayContaining(["max-md:contents", "md:flex", "md:justify-end"]));
  });
});

describe("CategoryChip long labels", () => {
  it("the label truncates inside the chip, which never grows past its line", () => {
    const out = html(h(CategoryChip, { label: "A very long name that would overflow a phone", slot: 2 }));
    expect(classOf(out, "category-chip")).toEqual(expect.arrayContaining(["max-w-full", "min-w-0"]));
    expect(out).toContain('<span class="min-w-0 truncate" title="A very long name that would overflow a phone">A very long name that would overflow a phone</span>');
  });
});

describe("CompareCard (audit P8)", () => {
  const rows = [
    { label: "Amount", a: "1,250,000", b: "1,200,000", delta: "50,000", differs: true },
    { label: "Date", a: "3 Nov", b: "3 Nov", differs: false },
  ];
  const out = html(h(CompareCard, { title: "Bank and ledger", sides: ["Bank statement", "Ledger"], rows }));
  it("a column per side and a difference column", () => {
    expect(out).toMatch(/<th scope="col"[^>]*>Bank statement<\/th><th scope="col"[^>]*>Ledger<\/th><th scope="col"[^>]*>Difference<\/th>/);
  });
  it("a differing row: 2 px line-strong rule, bold values, 'differs' for a screen reader; a same row neither", () => {
    const [, , diff, same] = out.split("<tr ") as [string, string, string, string];
    expect(diff).toMatch(/border-l-2 [^"]*border-l-line-strong[^"]*">Amount<span class="sr-only">, differs<\/span>/);
    expect(diff).toMatch(/font-semibold">1,250,000</);
    expect(same).toContain("border-l-transparent");
    expect(same).not.toContain("font-semibold");
  });
  it("the table is named by the card title, and so is its scroll box (focusable while it overflows: scroll-fade.test)", () => {
    expect(out).toMatch(/<table[^>]*><caption class="sr-only" id="([^"]+)">Bank and ledger<\/caption>/);
    const id = /<caption class="sr-only" id="([^"]+)"/.exec(out)![1]!;
    expect(out).toContain(`aria-labelledby="${id}"`);
  });
  it("two rows with one label both render (rows keyed by place and label)", () => {
    const twice = html(h(CompareCard, { title: "x", sides: ["A", "B"], rows: [{ label: "Ref", a: "1", b: "2", differs: true }, { label: "Ref", a: "3", b: "3", differs: false }] }));
    expect(twice.match(/>Ref</g)).toHaveLength(2);
  });
  it("no difference column when no row has one", () => {
    expect(html(h(CompareCard, { title: "x", sides: ["A", "B"], rows: [{ label: "Ref", a: "1", b: "2", differs: true }] }))).not.toContain("Difference");
  });
});

describe("ActionCard (audit P9)", () => {
  it("title, consequence, meta, and the button pinned to the bottom; full height in its grid row", () => {
    const out = html(h(ActionCard, { title: "Request posting", consequence: "Sends the entry to core banking after approval.", meta: "Two-level approval · Core banking", action: h(Button, null, "Request posting") }));
    expect(classOf(out, "action-card")).toEqual(expect.arrayContaining(["flex", "h-full", "flex-col"]));
    expect(out).toMatch(/<h3[^>]*>Request posting<\/h3><p[^>]*>Sends the entry to core banking after approval\.<\/p><p class="text-caption text-fg-3">Two-level approval · Core banking<\/p><div class="mt-auto[^"]*" data-slot="action-card-action"><button/);
  });
  it("a BlockedButton's caption (shown on touch) sits above the button, so the buttons of a row stay on one line", () => {
    const out = html(h(TooltipProvider, null, h(ActionCard, { title: "Request posting", consequence: "Sends it.", action: h(BlockedButton, { reason: "Needs approval first." }, "Request posting") })));
    expect(out).toMatch(/<div class="mt-auto [^"]*\*:data-\[slot=blocked-button\]:flex-col-reverse[^"]*" data-slot="action-card-action"><span class="[^"]*pointer-coarse:inline-flex[^"]*" data-slot="blocked-button"><button/);
  });
  it("without meta, no empty line", () => {
    expect(html(h(ActionCard, { title: "Write off", consequence: "Closes the item.", action: "x" }))).not.toContain("text-caption");
  });
});
