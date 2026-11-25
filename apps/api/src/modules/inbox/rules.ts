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
