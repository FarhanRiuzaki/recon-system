// Reads of import_file_history (staging) for the screens: whatever wrote the rows, this engine or import-host.
import { and, eq } from "drizzle-orm";
import type { Tx } from "../../../kernel/db";
import { history } from "./history-table";
import { staging } from "./pool";

/** Whether history has any row of `source` (then its source and batch prefix can't change). */
export async function historyExists(source: string, on: Tx = staging()): Promise<boolean> {
  const h = history();
  const [r] = await on.select({ id: h.id }).from(h).where(and(eq(h.source, source))).limit(1);
  return !!r;
}
