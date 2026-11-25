// Pure rules of the inbox (docs/superpowers/specs/2026-11-25-inbox-files-design.md): where a space's inbox sits on disk,
// which space and folder a path belongs to, and how a file's states over several sources fold into one.
import type { InboxState } from "@starterkit/shared/contracts/inbox";
import path from "node:path";

/** A space's inbox root (kernel/inbox-root.ts, which the spaces module uses for a new space). */
export { spaceRoot } from "../../kernel/inbox-root";

const RANK: Record<InboxState, number> = { failed: 3, duplicate: 2, waiting: 1, ingested: 0 };

/** The state a folder's summary counts a file under: the worst of its sources' (failed > duplicate > waiting > ingested). */
export const worstState = (states: readonly InboxState[]): InboxState =>
  states.reduce<InboxState>((w, s) => (RANK[s] > RANK[w] ? s : w), states.length ? "ingested" : "waiting");

/**
 * The space (by code) and folder a path sits in, by its resolved path: `<first root>/<code>/<folder>[/…]`; folder null
 * for the space root itself; null for a path outside every space root (a folder IT set up by hand).
 */
export function folderOfPath(roots: readonly string[], codes: readonly string[], p: string): { code: string; folder: string | null } | null {
  if (!roots[0]) return null;
  const rel = path.relative(path.resolve(roots[0]), path.resolve(p));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const [code, folder] = rel.split(path.sep);
  return code && codes.includes(code) ? { code, folder: folder ?? null } : null;
}

/**
 * Why an upload's name doesn't fit what its bytes are (owner 25 Nov: a renamed file is caught): text must be named as
 * text (.csv .txt .dat .tsv), a workbook .xlsx or .xls as it really is; null when they fit. `kind` = the sniffed content.
 */
export function nameMismatch(name: string, kind: "text" | "xlsx" | "xls"): string | null {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  const excelName = ext === ".xlsx" || ext === ".xls";
  if (kind === "text") return excelName ? `This file is text, not an Excel workbook, but is named ${ext}. Rename it .csv or .txt and upload it again.` : null;
  if (!excelName) return `This file is an Excel workbook but is named ${ext}. Rename it .${kind} and upload it again.`;
  if (ext === `.${kind}`) return null;
  return kind === "xls"
    ? `This file is an older Excel workbook (.xls) but is named ${ext}. Rename it .xls and upload it again.`
    : `This file is an Excel workbook (.xlsx) but is named ${ext}. Rename it .xlsx and upload it again.`;
}
