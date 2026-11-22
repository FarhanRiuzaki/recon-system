"use client";

import { Avatar, Timeline, type TimelineItem } from "@starterkit/ui/ds";
import type { RequestViewDto } from "@starterkit/shared/contracts/workflows";

// A request's approval chain (DEC-052), shared by every subject that can wait for one (a break today; versions, sign-off
// and rerun in phase B) and by the workflow editor's "Who approves".

/** How many of a group must approve, in words. */
export const needWords = (n: { kind: string; n?: number }) => (n.kind === "any" ? "Any one of" : n.kind === "all" ? "Everyone in" : `${n.n} of`);

/** People as overlapping avatars (name on hover) and the first two names, then "+N". */
export function People({ people, max = 5 }: { people: readonly { id: string; name: string | null }[]; max?: number }) {
  if (!people.length) return <span className="text-body-sm text-down-ink">Nobody can approve this</span>;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="flex shrink-0 -space-x-1.5">
        {people.slice(0, max).map((p) => <span key={p.id} title={p.name ?? "A removed user"} className="rounded-full ring-2 ring-card"><Avatar name={p.name ?? "?"} seed={p.id} /></span>)}
      </span>
      <span className="min-w-0 truncate text-body-sm text-fg-2">{people.slice(0, 2).map((p) => p.name ?? "A removed user").join(", ")}{people.length > 2 ? ` +${people.length - 2}` : ""}</span>
    </span>
  );
}

const STATE: Record<RequestViewDto["levels"][number]["state"], TimelineItem["status"]> = { done: "done", waiting: "current", next: "upcoming", rejected: "rejected" };

/**
 * The chain of `r` as a timeline: who asked, then each level with, per group, who approved, how many are still needed
 * and who may still approve; a rejection or an override says who, when and why.
 */
export function RequestChain({ r }: { r: RequestViewDto }) {
  const items: TimelineItem[] = [
    { id: "asked", title: "Asked", status: "done", at: Date.parse(r.requestedAt), actor: r.requester?.name ?? "A removed user", note: `“${r.note}”` },
    ...r.levels.map((l, i) => ({
      id: `l${i}`, title: l.name ? `Level ${i + 1} · ${l.name}` : `Level ${i + 1}`, status: r.override && l.state !== "done" && i >= r.currentLevel ? "skipped" as const : STATE[l.state],
      actor: (
        <span className="grid gap-2 pt-0.5">
          {l.groups.map((g, gi) => (
            <span key={gi} className="grid gap-1">
              {gi > 0 && <span className="text-caption text-fg-3">and</span>}
              {g.approvals.map((a) => <span key={a.user.id} className="text-body-sm text-fg">Approved by {a.user.name ?? "a removed user"}{a.note ? ` · “${a.note}”` : ""}</span>)}
              {g.left > 0 && l.state !== "rejected" && !r.override && (
                <>
                  <span className="text-caption text-fg-3">{g.approvals.length ? `${g.left} more · ` : ""}{needWords(g.need)}</span>
                  <People people={g.approvers} />
                </>
              )}
            </span>
          ))}
        </span>
      ),
      note: r.rejection?.level === i ? `Rejected by ${r.rejection.user.name ?? "a removed user"}: “${r.rejection.note ?? ""}”`
        : r.override && i === r.currentLevel ? `Overridden by ${r.override.user.name ?? "a removed user"}: “${r.override.reason}”` : undefined,
      at: r.rejection?.level === i ? Date.parse(r.rejection.at) : r.override && i === r.currentLevel ? Date.parse(r.override.at) : null,
    })),
  ];
  return <Timeline label="Approval chain" items={items} />;
}
