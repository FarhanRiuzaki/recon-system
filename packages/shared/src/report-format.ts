// A report cell as text (spec 2026-11-26 "Spec v2": number, date and text formats; Text fixed-width layout). One
// implementation for the file and the preview: the API renders both (preview = file), the browser shows the result.
import type { ColumnFormat, ColumnLayout } from "./contracts/reports";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function number(v: number, f: Extract<ColumnFormat, { kind: "number" }>): string {
  const [int, frac] = Math.abs(v).toFixed(f.decimals).split(".");
  const point = f.thousands === "." ? "," : ".";
  const grouped = f.thousands === "none" ? int! : int!.replace(/\B(?=(\d{3})+(?!\d))/g, f.thousands);
  const body = `${f.prefix}${grouped}${frac ? point + frac : ""}${f.suffix}`;
  if (v >= 0 || Number(Math.abs(v).toFixed(f.decimals)) === 0) return body;
  return f.negative === "paren" ? `(${body})` : f.negative === "trailing" ? `${body}-` : `-${body}`;
}

function date(v: string, pattern: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (!m) return v;
  const [, y, mo, d] = m;
  return pattern.replace("yyyy", y!).replace("MMM", MONTHS[Number(mo) - 1]!).replace("MM", mo!).replace("dd", d!);
}

/** `v` in format `f`; null or "" → "". A value the format can't read (text in a number column) stays as it is. */
export function formatCell(v: string | number | bigint | null | undefined, f: ColumnFormat): string {
  if (v === null || v === undefined || v === "") return "";
  switch (f.kind) {
    case "number": {
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? number(n, f) : String(v);
    }
    case "date": return date(String(v), f.pattern);
    case "text": return f.case === "upper" ? String(v).toUpperCase() : f.case === "lower" ? String(v).toLowerCase() : String(v);
    case "auto": return String(v);
  }
}

/**
 * A Text fixed-width cell: cut to `width`, padded by `align` with `pad`. Zero padding applies to numbers only (text
 * pads with spaces) and keeps a minus sign in front of the zeros (`-0001500`).
 */
export function fitWidth(s: string, l: ColumnLayout, numeric: boolean): string {
  const w = l.width;
  // zeros only before a plain number (1500, -1500, 1500.25): "(1.500)", "1.500-" or "Rp 1.500" pad with spaces
  if (numeric && l.pad === "0" && l.align === "r" && /^-?\d+([.,]\d+)?$/.test(s)) {
    if (w <= 1) return s.startsWith("-") ? "-" : s.slice(-1);
    const neg = s.startsWith("-");
    const digits = neg ? s.slice(1) : s;
    return (neg ? "-" : "") + digits.slice(-(w - (neg ? 1 : 0))).padStart(w - (neg ? 1 : 0), "0");
  }
  const cut = [...s].slice(0, w).join("");
  const gap = w - [...cut].length;
  if (l.align === "r") return " ".repeat(gap) + cut;
  if (l.align === "c") return " ".repeat(Math.floor(gap / 2)) + cut + " ".repeat(Math.ceil(gap / 2));
  return cut + " ".repeat(gap);
}
