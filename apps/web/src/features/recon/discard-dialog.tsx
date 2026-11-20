"use client";

import { LazyConfirmActionDialog } from "@/components/lazy-confirm";

/** "Delete this draft recon?" (docs/recon/README.md row Plan 3): a recon never submitted, deleted with its draft; a failure stays in the dialog. */
export function DiscardDialog({ name, onClose, onConfirm }: { name: string; onClose: () => void; onConfirm: () => Promise<void> }) {
  return (
    <LazyConfirmActionDialog open onOpenChange={(o) => { if (!o) onClose(); }} auditFields={false} reasons={[]} destructive title="Delete this draft recon?"
      description={`${name} was never submitted, so it never ran. Its sides, passes and draft settings are removed. This can't be undone.`}
      impact={[]} actionLabel="Delete draft recon" onConfirm={async () => onConfirm()} />
  );
}
