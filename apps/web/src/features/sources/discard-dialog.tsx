"use client";

import { LazyConfirmActionDialog } from "@/components/lazy-confirm";

/**
 * "Delete this draft source?" (designer's copy, board 127:10387): a source nobody submitted, deleted with its
 * connection and draft (DELETE …/sources/{id}); a failure stays in the dialog.
 */
export function DiscardDialog({ name, onClose, onConfirm }: { name: string; onClose: () => void; onConfirm: () => Promise<void> }) {
  return (
    <LazyConfirmActionDialog open onOpenChange={(o) => { if (!o) onClose(); }} auditFields={false} reasons={[]} destructive title="Delete this draft source?"
      description={`${name} was never submitted, so nothing was pulled or ingested. Its connection and draft settings are removed. This can't be undone.`}
      impact={[]} actionLabel="Delete draft source" onConfirm={async () => onConfirm()} />
  );
}
