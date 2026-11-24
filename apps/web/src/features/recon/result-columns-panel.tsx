"use client";

import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { useState } from "react";
import { Failure, Panel, StatusChip } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { EditIcon } from "@starterkit/ui/ui/icons";
import { Skeleton } from "@starterkit/ui/ui/skeleton";
import { BRAND } from "@starterkit/shared/brand";
import type { ReconSpec } from "@starterkit/shared/contracts/recon";
import type { ResultColumnsDto } from "@starterkit/shared/contracts/results";
import { api } from "@/lib/client/api";
import { statusChip } from "@/lib/shared/categories";
import { resultColumns } from "@/lib/shared/queries-recon";
import { columnValue, fieldText } from "./result-columns-model";

// the editor (its field picker reads both sides' sources) loads on Edit: the recon page sits near its budget
const ResultColumnsEditor = dynamic(() => import("./result-columns-editor"), { ssr: false, loading: () => <Skeleton className="h-40" /> });

const MISSING = statusChip("missing", "Field not in the source");

/**
 * The recon's Operation result columns (outside the versioned spec: a save applies at once, no approval), in order;
 * a column whose field the source no longer has stays and says so. Edit for a config maker or space admin.
 */
export function ResultColumnsPanel({ spaceId, configId, spec, canEdit }: { spaceId: string; configId: string; spec: ReconSpec; canEdit: boolean }) {
  const cq = resultColumns(spaceId, configId);
  const q = useQuery({ queryKey: cq.key, queryFn: () => api<ResultColumnsDto>(cq.url) });
  const [editing, setEditing] = useState(false);
  const sides = [spec.sides[0].label, spec.sides[1].label] as const;
  const missing = new Set((q.data?.missing ?? []).map(columnValue));
  return (
    <Panel title="Operation result columns" description="What the Operation result table shows for this recon; changes apply now, no approval"
      actions={canEdit && q.data && !editing ? <Button variant="edit" size="sm" onClick={() => setEditing(true)}><Icon icon={EditIcon} />Edit columns</Button> : undefined}>
      {q.error && !q.data ? <Failure title="Couldn't load the columns" error={q.error} source={BRAND.name} onRetry={() => void q.refetch()} />
        : !q.data ? <Skeleton className="h-24" />
        : editing ? <ResultColumnsEditor spaceId={spaceId} configId={configId} spec={spec} value={q.data} onDone={() => setEditing(false)} />
        : (
          <ol aria-label="Columns in order" className="grid gap-2">
            {q.data.columns.map((c, i) => (
              <li key={columnValue(c)} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-card px-3 py-2">
                <span className="tabular text-caption text-fg-3">{i + 1}</span>
                <span className="font-medium text-fg">{c.label}</span>
                <span className="text-body-sm text-fg-3">{c.kind === "recon" ? "Recon" : `${sides[c.kind === "a" ? 0 : 1]} · ${fieldText(c.field)}`}</span>
                {missing.has(columnValue(c)) && <StatusChip health={MISSING.health} label={MISSING.label} />}
              </li>
            ))}
            {q.data.isDefault && <li className="text-caption text-fg-3">The default columns: no one has changed them yet.</li>}
          </ol>
        )}
    </Panel>
  );
}
