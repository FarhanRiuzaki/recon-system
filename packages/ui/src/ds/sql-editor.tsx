"use client";

import { type ComponentProps, type KeyboardEvent, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { Icon } from "../ui/icon";
import { SpinnerIcon } from "../ui/icons";

export type SqlTokenKind = "keyword" | "string" | "number" | "comment" | "param" | "plain";
export type SqlToken = { kind: SqlTokenKind; text: string };

const KEYWORD_LIST = ("select from where and or not in is null as on join left right inner outer full cross group by order having " +
  "limit offset fetch first next rows only top distinct union all except intersect case when then else end between like ilike exists " +
  "with asc desc true false cast interval date timestamp over partition").split(" ");
const FUNCTION_LIST = "count sum min max avg coalesce nullif upper lower trim substring length round abs cast concat date_trunc extract now current_date to_char to_date".split(" ");
const KEYWORDS = new Set([...KEYWORD_LIST, ...FUNCTION_LIST]);
// one alternative per kind, in priority order: comments, strings and quoted names, parameters, numbers, words
const LEXER = /(--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|('(?:[^']|'')*'?)|("(?:[^"]|"")*"?|`[^`]*`?)|(:[A-Za-z_]\w*)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_]\w*)/g;

/**
 * SQL split for colouring (SqlEditor): comments, strings, :parameters, numbers and keywords; everything else, quoted
 * names included, is plain. The pieces always join back to `text` exactly. Colouring only: it judges nothing.
 */
export function sqlTokens(text: string): SqlToken[] {
  const out: SqlToken[] = [];
  let at = 0;
  for (const m of text.matchAll(LEXER)) {
    if (m.index > at) out.push({ kind: "plain", text: text.slice(at, m.index) });
    const kind: SqlTokenKind = m[1] ? "comment" : m[2] ? "string" : m[4] ? "param" : m[5] ? "number"
      : m[6] && KEYWORDS.has(m[6].toLowerCase()) ? "keyword" : "plain";
    out.push({ kind, text: m[0] });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ kind: "plain", text: text.slice(at) });
  return out;
}

/**
 * What the caret is in, for suggestions: `word` being typed (from `start`), `want` = a table (after FROM, JOIN, INTO,
 * UPDATE), a column of `table` (after `name.`: an alias of a FROM/JOIN table resolves to it), or anything; `tables` =
 * every table the query names in FROM/JOIN. `none` inside a string or a comment.
 */
export type SqlContext = { word: string; start: number; want: "table" | "column" | "any" | "none"; table: string | null; tables: string[] };
export function sqlContext(text: string, caret: number): SqlContext {
  const before = text.slice(0, caret);
  const last = sqlTokens(before).at(-1);
  const inside = last && (last.kind === "comment" || (last.kind === "string" && !/'$/.test(last.text.slice(1))));
  const word = /[:\w$]*$/.exec(before)![0];
  const start = caret - word.length;
  const tables: string[] = [];
  const alias = new Map<string, string>();
  for (const m of text.matchAll(/\b(?:from|join)\s+([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)(?:\s+(?:as\s+)?([A-Za-z_]\w*))?/gi)) {
    const t = m[1]!;
    if (!tables.includes(t)) tables.push(t);
    const a = m[2];
    if (a && !KEYWORDS.has(a.toLowerCase())) alias.set(a.toLowerCase(), t);
    alias.set(t.toLowerCase(), t);
    alias.set(t.split(".").at(-1)!.toLowerCase(), t);
  }
  if (inside) return { word, start, want: "none", table: null, tables };
  const q = /([A-Za-z_][\w$]*)\.$/.exec(before.slice(0, start));
  if (q) {
    const t = alias.get(q[1]!.toLowerCase()) ?? null;
    // `schema.` before a table name in FROM is a table being typed, not a column
    const intoTable = /\b(?:from|join|into|update)\s+[A-Za-z_][\w$]*\.$/i.test(before.slice(0, start));
    return { word, start: intoTable ? start - q[0].length : start, want: intoTable ? "table" : "column", table: intoTable ? null : t, tables };
  }
  const prev = /([A-Za-z_]+)\s+$/.exec(before.slice(0, start))?.[1]?.toLowerCase();
  return { word, start, want: prev && ["from", "join", "into", "update"].includes(prev) ? "table" : "any", table: null, tables };
}

/** A suggestion: `insert` replaces the word being typed (default `label`); `detail` is shown beside it (a type, a table). */
export type SqlSuggestion = { label: string; kind: "table" | "column" | "keyword" | "function" | "param"; detail?: string; insert?: string };
/** The suggestions a caller adds for a context (tables and columns from a connection); may be async. */
export type SqlSuggest = (c: SqlContext, signal: AbortSignal) => SqlSuggestion[] | Promise<SqlSuggestion[]>;

/** The built-in suggestions for `c`: keywords and functions (not where a table is wanted), and the given params. */
export function builtInSuggestions(c: SqlContext, params: readonly string[]): SqlSuggestion[] {
  if (c.want === "none" || c.want === "table" || c.want === "column") return [];
  if (c.word.startsWith(":")) return params.map((p) => ({ label: p, kind: "param" as const, detail: "filled in per run" }));
  return [...KEYWORD_LIST.map((k) => ({ label: k.toUpperCase(), kind: "keyword" as const })), ...FUNCTION_LIST.map((f) => ({ label: `${f.toUpperCase()}(`, kind: "function" as const, insert: `${f.toUpperCase()}(` }))];
}

/** `list` matching `word` (case-insensitive): names that start with it first, then those containing it; at most `max`. */
export function rankSuggestions(list: readonly SqlSuggestion[], word: string, max = 50): SqlSuggestion[] {
  const w = word.replace(/^:/, "").toLowerCase();
  const name = (s: SqlSuggestion) => s.label.replace(/^:/, "").toLowerCase();
  const seen = new Set<string>();
  const uniq = list.filter((s) => { const k = `${s.kind}:${s.label}`; if (seen.has(k)) return false; seen.add(k); return true; });
  if (!w) return uniq.slice(0, max);
  const starts = uniq.filter((s) => name(s).startsWith(w) || name(s).split(".").at(-1)!.startsWith(w));
  const has = uniq.filter((s) => !starts.includes(s) && name(s).includes(w));
  return [...starts, ...has].filter((s) => name(s) !== w).slice(0, max);
}

const COLOR: Record<SqlTokenKind, string> = {
  keyword: "text-code-keyword", string: "text-code-string", number: "text-code-number", comment: "text-code-comment italic", param: "text-code-param", plain: "",
};
const KIND_COLOR: Record<SqlSuggestion["kind"], string> = {
  table: "text-code-param", column: "text-code-number", keyword: "text-code-keyword", function: "text-code-keyword", param: "text-code-param",
};
const KIND_LETTER: Record<SqlSuggestion["kind"], string> = { table: "T", column: "C", keyword: "K", function: "F", param: "P" };
// the textarea and its coloured copy share every metric, so each character sits over its colour
const METRICS = "px-2.5 pt-2 pb-11 font-mono text-body whitespace-pre-wrap break-words";

/**
 * A SQL field (design-system §5.12): a textarea with the Input's look whose text is coloured as SQL (VS Code's Light+ /
 * Dark+ hues, the `--code-*` tokens) by a copy drawn under its transparent text, and an `action` (a "Check query"
 * button) inside the box at its bottom right. The textarea stays the field: typing, selection, undo, the screen reader
 * and Field's id, note and error all work as on a Textarea.
 *
 * Suggestions, at the caret as in VS Code: keywords and functions, `params` after ":", and what `suggest` adds for the
 * context (sqlContext: tables after FROM/JOIN, the columns of a table after `alias.`, else the named tables' columns).
 * They open while a word is typed or on Ctrl+Space; ↑/↓ move, Enter or Tab inserts (one undo step), Esc closes.
 */
const NO_PARAMS: readonly string[] = [];
const SUGGEST_DEBOUNCE_MS = 250;

export function SqlEditor({ value, action, className, rows = 6, suggest, params = NO_PARAMS, ...props }: Omit<ComponentProps<"textarea">, "value" | "children"> & {
  value: string; action?: ReactNode; suggest?: SqlSuggest; params?: readonly string[];
}) {
  const copy = useRef<HTMLPreElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const mark = useRef<HTMLSpanElement>(null);
  const listId = useId();
  const [open, setOpen] = useState<{ ctx: SqlContext; caret: number } | null>(null);
  const [items, setItems] = useState<SqlSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  // the latest callers' values, read when a context opens (a new function each render must not reopen the list)
  const source = useRef({ suggest, params });
  useLayoutEffect(() => { source.current = { suggest, params }; });

  // the list for the open context: built-ins at once, the caller's when they arrive (the previous request aborted)
  useEffect(() => {
    if (!open) return;
    const { suggest, params } = source.current;
    const own = builtInSuggestions(open.ctx, params);
    setItems(rankSuggestions(own, open.ctx.word));
    setActive(0);
    if (!suggest || open.ctx.want === "none") return;
    const ctl = new AbortController();
    setLoading(true);
    // debounced as the Combobox's server search: a caller reading a connection is asked once typing pauses
    const wait = setTimeout(() => {
      void Promise.resolve(suggest(open.ctx, ctl.signal)).then((more) => {
        if (ctl.signal.aborted) return;
        // the caller's names first: they are what this query reads
        setItems(rankSuggestions([...more, ...own], open.ctx.word));
      }).catch(() => {}).finally(() => { if (!ctl.signal.aborted) setLoading(false); });
    }, SUGGEST_DEBOUNCE_MS);
    return () => { clearTimeout(wait); ctl.abort(); };
  }, [open]);

  // the list hangs under the caret: its place in an invisible copy of the text before it
  useEffect(() => {
    if (!open || !mark.current || !area.current) return;
    setPos({ top: mark.current.offsetTop - area.current.scrollTop + 22, left: Math.min(mark.current.offsetLeft - area.current.scrollLeft, area.current.clientWidth - 288) });
  }, [open, value]);

  const look = (el: HTMLTextAreaElement, force = false) => {
    const caret = el.selectionStart;
    if (caret !== el.selectionEnd) return setOpen(null);
    const ctx = sqlContext(el.value, caret);
    const typing = ctx.word.length > 0 || ctx.want === "column";
    setOpen(ctx.want !== "none" && (force || typing) ? { ctx, caret } : null);
  };
  const take = (s: SqlSuggestion) => {
    const el = area.current;
    if (!el || !open) return;
    el.focus();
    el.setSelectionRange(open.ctx.start, open.caret);
    const text = s.insert ?? s.label;
    // insertText keeps the browser's undo; setRangeText + an input event where it isn't supported
    if (!document.execCommand?.("insertText", false, text)) {
      el.setRangeText(text, open.ctx.start, open.caret, "end");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    setOpen(null);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === " " && e.ctrlKey) { e.preventDefault(); look(e.currentTarget, true); return; }
    if (open && items.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => (i + 1) % items.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => (i - 1 + items.length) % items.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); take(items[active]!); return; }
    }
    if (e.key === "Escape" && open) { e.preventDefault(); setOpen(null); return; }
    props.onKeyDown?.(e);
  };

  const shown = open && (items.length > 0 || loading);
  return (
    <div data-slot="sql-editor" className={cn("relative isolate grid min-w-0 rounded-md", className)}>
      <pre ref={copy} aria-hidden="true" className={cn("pointer-events-none col-start-1 row-start-1 m-0 overflow-hidden border border-transparent text-fg", METRICS)}>
        {sqlTokens(value).map((t, i) => (t.kind === "plain" ? t.text : <span key={i} className={COLOR[t.kind]}>{t.text}</span>))}
        {/* a trailing newline needs a line under it, as the textarea draws one */}{"\n"}
      </pre>
      {/* where the caret is: the text before it, laid out as the textarea lays it out */}
      <pre aria-hidden="true" className={cn("pointer-events-none invisible col-start-1 row-start-1 m-0 overflow-hidden border border-transparent", METRICS)}>
        {value.slice(0, open?.caret ?? 0)}<span ref={mark} />
      </pre>
      <textarea ref={area} data-slot="textarea" spellCheck={false} autoCapitalize="off" autoCorrect="off" rows={rows} {...props} value={value}
        aria-autocomplete="list" aria-controls={listId} aria-activedescendant={shown && items.length ? `${listId}-${active}` : undefined}
        onChange={(e) => { props.onChange?.(e); look(e.currentTarget); }} onKeyDown={onKeyDown}
        onBlur={(e) => { setOpen(null); props.onBlur?.(e); }} onClick={(e) => { if (open) look(e.currentTarget); props.onClick?.(e); }}
        onScroll={(e) => { if (copy.current) { copy.current.scrollTop = e.currentTarget.scrollTop; copy.current.scrollLeft = e.currentTarget.scrollLeft; } props.onScroll?.(e); }}
        className={cn("col-start-1 row-start-1 min-h-32 w-full min-w-0 resize-y rounded-md border border-control-border bg-transparent text-transparent caret-fg outline-none selection:bg-primary-soft selection:text-transparent",
          "transition-[border-color,box-shadow] duration-(--dur-fast) focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary-soft",
          "aria-invalid:border-down-mark aria-invalid:focus-visible:ring-down-soft disabled:cursor-not-allowed disabled:opacity-60", METRICS)} />
      {/* the field's fill under both layers */}
      <span aria-hidden="true" className="col-start-1 row-start-1 -z-10 rounded-md bg-card" />
      {action && <div className="absolute right-2 bottom-2 flex items-center gap-2">{action}</div>}
      <ul id={listId} role="listbox" aria-label="Suggestions" hidden={!shown} style={{ top: pos.top, left: Math.max(pos.left, 0) }}
        className="scroll-quiet absolute z-30 max-h-60 w-72 overflow-y-auto rounded-lg border border-line bg-raised p-1 shadow-overlay">
        {items.map((s, i) => (
          <li key={`${s.kind}:${s.label}`} id={`${listId}-${i}`} role="option" aria-selected={i === active}
            onMouseDown={(e) => e.preventDefault()} onClick={() => take(s)} onMouseMove={() => setActive(i)}
            className={cn("flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 font-mono text-body-sm text-fg", i === active && "bg-tray")}>
            <span aria-hidden="true" className={cn("w-3 shrink-0 text-center text-caption font-semibold", KIND_COLOR[s.kind])}>{KIND_LETTER[s.kind]}</span>
            <span className="min-w-0 flex-1 truncate">{s.label}</span>
            {s.detail && <span className="max-w-32 shrink-0 truncate font-sans text-caption text-fg-3">{s.detail}</span>}
          </li>
        ))}
        {loading && <li role="presentation" className="flex items-center gap-2 px-2 py-1 text-caption text-fg-3"><Icon icon={SpinnerIcon} className="size-3 motion-safe:animate-spin" />Reading the connection…</li>}
      </ul>
    </div>
  );
}
