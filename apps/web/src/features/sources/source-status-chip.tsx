import { StatusChip } from "@starterkit/ui/ds";
import type { SourceRowDto } from "@starterkit/shared/contracts/sources";
import { sourceStatus } from "@/lib/shared/source-status";
import { withDays } from "./source-text";

/** A source's state chip with the API's reason (or last error) as its description. */
export function SourceStatusChip({ s }: { s: SourceRowDto }) {
  const st = sourceStatus(s);
  const why = s.health?.reason ?? s.health?.lastError ?? null;
  return <StatusChip strong health={st.health} label={st.label} description={why ? withDays(why) : null} />;
}
