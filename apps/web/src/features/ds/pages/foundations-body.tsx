"use client";

import { Brand, Panel } from "@starterkit/ui/ds";
import { Icon } from "@starterkit/ui/ui/icon";
import * as Icons from "@starterkit/ui/ui/icons";
import { LogoMark, LogoWordmark } from "@/components/brand";
import { SectionTitle } from "../section-title";
import { useHashScroll } from "../use-hash-scroll";

/** /ds/foundations below the header: the tokens and the icon library. */
export function FoundationsSections() {
  useHashScroll();
  return (
    <>
      <div id="ds-foundations" className="scroll-mt-20"><SectionTitle>Tokens</SectionTitle></div>
      <Tokens />
      <section id="ds-icons" className="scroll-mt-20"><Panel title="Icon library" description="One shared icon source. Icons accompany labels; icon-only actions have accessible names."><div className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-6">{Object.entries(Icons).filter(([name]) => name.endsWith("Icon")).map(([name, icon]) => <div key={name} className="grid justify-items-center gap-2 rounded-md bg-tray p-3"><Icon icon={icon} className="size-5 text-fg-2" /><span className="max-w-full break-words text-center text-caption text-fg-3">{name.replace(/Icon$/, "")}</span></div>)}</div></Panel></section>
    </>
  );
}

const SURFACES = [
  { name: "bg", cls: "bg-bg" }, { name: "sheet", cls: "bg-sheet" }, { name: "tray", cls: "bg-tray" }, { name: "card", cls: "bg-card" },
  { name: "inset", cls: "bg-inset" }, { name: "raised", cls: "bg-raised" },
] as const;
const COLOURS = [
  { name: "primary", cls: "bg-primary" }, { name: "action", cls: "bg-action" }, { name: "row-selected", cls: "bg-row-selected" },
  { name: "healthy-mark", cls: "bg-healthy-mark" }, { name: "degraded-mark", cls: "bg-degraded-mark" }, { name: "down-mark", cls: "bg-down-mark" },
  { name: "stopped-mark", cls: "bg-stopped-mark" }, { name: "chart-1", cls: "bg-chart-1" }, { name: "chart-2", cls: "bg-chart-2" },
  { name: "chart-3", cls: "bg-chart-3" }, { name: "chart-4", cls: "bg-chart-4" }, { name: "chart-5", cls: "bg-chart-5" }, { name: "chart-6", cls: "bg-chart-6" },
  // category hues: a role, reason or change kind beside status chips (CategoryChip)
  { name: "cat-indigo", cls: "bg-cat-indigo" }, { name: "cat-violet", cls: "bg-cat-violet" }, { name: "cat-pink", cls: "bg-cat-pink" },
  { name: "cat-teal", cls: "bg-cat-teal" }, { name: "cat-brown", cls: "bg-cat-brown" }, { name: "cat-slate", cls: "bg-cat-slate" },
  // SqlEditor's syntax colours (text on the field, design-system §5.12)
  { name: "code-keyword", cls: "bg-code-keyword" }, { name: "code-string", cls: "bg-code-string" }, { name: "code-number", cls: "bg-code-number" },
  { name: "code-comment", cls: "bg-code-comment" }, { name: "code-param", cls: "bg-code-param" },
] as const;
const TYPE = [
  { name: "display 32/40", cls: "text-display", sample: "1,284" }, { name: "title-1 22/28", cls: "text-title-1", sample: "Users" },
  { name: "title-2 15/22", cls: "text-title-2", sample: "Requests by service" }, { name: "title-3 14/20", cls: "text-title-3", sample: "Alex Rivers" },
  { name: "stat 28/32", cls: "text-stat", sample: "4.6 MB" }, { name: "stat-sm 20/28", cls: "text-stat-sm", sample: "52%" },
  { name: "body 14/20", cls: "text-body", sample: "Sessions appear here after someone signs in." },
  { name: "body-sm 13/18", cls: "text-body-sm", sample: "Updated 2 minutes ago" }, { name: "label 12/16", cls: "text-label", sample: "Email" },
  { name: "caption 11/16", cls: "text-caption", sample: "vs previous 24 hours" }, { name: "eyebrow mono", cls: "eyebrow", sample: "Access" },
  { name: "mono 12/16", cls: "font-mono text-mono", sample: "alex.rivers · 10.0.0.14" },
] as const;

/** The Brand slot at the sizes the app uses (the logo itself lives in components/brand). */
const LOGOS = [
  { name: "sidebar · wordmark 36 px tall", collapsed: false, wordmark: <LogoWordmark className="h-9 w-auto" /> },
  { name: "sign-in page · wordmark 48 px tall", collapsed: false, wordmark: <LogoWordmark className="h-12 w-auto" /> },
  { name: "rail · mark 36 px wide", collapsed: true, wordmark: null },
] as const;

function Tokens() {
  return (
    <div className="grid grid-cols-12 gap-gutter">
      <Panel title="Brand" description="Wordmark when expanded, mark in the rail; the artwork's own colours in every palette" className="col-span-12">
        <ul className="flex flex-wrap items-end gap-12">
          {LOGOS.map((l) => (
            <li key={l.name} className="grid justify-items-start gap-4">
              <Brand collapsed={l.collapsed} mark={<LogoMark className="h-auto w-9" />} wordmark={l.wordmark} />
              <span className="font-mono text-caption text-fg-3">{l.name}</span>
            </li>
          ))}
        </ul>
      </Panel>
      <Panel icon={Icons.SurfacesIcon} title="Surfaces" description="bg → sheet → tray → card → inset" className="col-span-12 md:col-span-6">
        <ul className="grid grid-cols-3 gap-2">{SURFACES.map((s) => <Swatch key={s.name} {...s} />)}</ul>
      </Panel>
      <Panel title="Color" description="Ink is neutral; color is information" className="col-span-12 md:col-span-6">
        <ul className="grid grid-cols-4 gap-2">{COLOURS.map((s) => <Swatch key={s.name} {...s} />)}</ul>
      </Panel>
      <Panel title="Type scale" description="Inter Variable + Geist Mono" className="col-span-12">
        <dl className="grid">
          {TYPE.map((t) => (
            <div key={t.name} className="flex min-w-0 items-baseline gap-4 border-b border-dashed border-line py-2 last:border-b-0">
              <dt className="w-32 shrink-0 font-mono text-caption text-fg-3">{t.name}</dt><dd className={`${t.cls} min-w-0 truncate text-fg`} title={t.sample}>{t.sample}</dd>
            </div>
          ))}
        </dl>
      </Panel>
    </div>
  );
}

function Swatch({ name, cls }: { name: string; cls: string }) {
  return (
    <li className="overflow-hidden rounded-lg border border-line bg-card">
      <span aria-hidden="true" className={`block h-11 border-b border-line ${cls}`} />
      <span className="block px-2 py-1.5 font-mono text-caption text-fg-2">{name}</span>
    </li>
  );
}
