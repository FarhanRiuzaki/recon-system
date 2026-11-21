"use client";

import { type ComponentProps, type ReactNode, useRef } from "react";
import { cn } from "../lib/cn";

export type SqlTokenKind = "keyword" | "string" | "number" | "comment" | "param" | "plain";
export type SqlToken = { kind: SqlTokenKind; text: string };

const KEYWORDS = new Set(("select from where and or not in is null as on join left right inner outer full cross group by order having " +
  "limit offset fetch first next rows only top distinct union all except intersect case when then else end between like ilike exists " +
  "with asc desc true false cast interval date timestamp over partition count sum min max avg coalesce nullif").split(" "));
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

const COLOR: Record<SqlTokenKind, string> = {
  keyword: "text-code-keyword", string: "text-code-string", number: "text-code-number", comment: "text-code-comment italic", param: "text-code-param", plain: "",
};
// the textarea and its coloured copy share every metric, so each character sits over its colour
const METRICS = "px-2.5 pt-2 pb-11 font-mono text-body whitespace-pre-wrap break-words";

/**
 * A SQL field (design-system §5.12): a textarea with the Input's look whose text is coloured as SQL (VS Code's Light+ /
 * Dark+ hues, the `--code-*` tokens) by a copy drawn under its transparent text, and an `action` (a "Check query"
 * button) inside the box at its bottom right. The textarea stays the field: typing, selection, undo, the screen reader
 * and Field's id, note and error all work as on a Textarea.
 */
export function SqlEditor({ value, action, className, rows = 6, ...props }: Omit<ComponentProps<"textarea">, "value" | "children"> & { value: string; action?: ReactNode }) {
  const copy = useRef<HTMLPreElement>(null);
  return (
    <div data-slot="sql-editor" className={cn("relative isolate grid min-w-0 rounded-md", className)}>
      <pre ref={copy} aria-hidden="true" className={cn("pointer-events-none col-start-1 row-start-1 m-0 overflow-hidden border border-transparent text-fg", METRICS)}>
        {sqlTokens(value).map((t, i) => (t.kind === "plain" ? t.text : <span key={i} className={COLOR[t.kind]}>{t.text}</span>))}
        {/* a trailing newline needs a line under it, as the textarea draws one */}{"\n"}
      </pre>
      <textarea data-slot="textarea" spellCheck={false} autoCapitalize="off" autoCorrect="off" rows={rows} {...props} value={value}
        onScroll={(e) => { if (copy.current) { copy.current.scrollTop = e.currentTarget.scrollTop; copy.current.scrollLeft = e.currentTarget.scrollLeft; } props.onScroll?.(e); }}
        className={cn("col-start-1 row-start-1 min-h-32 w-full min-w-0 resize-y rounded-md border border-control-border bg-transparent text-transparent caret-fg outline-none selection:bg-primary-soft selection:text-transparent",
          "transition-[border-color,box-shadow] duration-(--dur-fast) focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary-soft",
          "aria-invalid:border-down-mark aria-invalid:focus-visible:ring-down-soft disabled:cursor-not-allowed disabled:opacity-60", METRICS)} />
      {/* the field's fill under both layers */}
      <span aria-hidden="true" className="col-start-1 row-start-1 -z-10 rounded-md bg-card" />
      {action && <div className="absolute right-2 bottom-2 flex items-center gap-2">{action}</div>}
    </div>
  );
}
