import type { HeaderConfirm } from "@/components/shell/page-header";

/**
 * "Delete this draft source?" (designer's copy, board 127:10387): a source nobody submitted, deleted with its
 * connection and draft (DELETE …/sources/{id}); asked from the header's ⋯ menu, a failure stays in the dialog.
 */
export const discardConfirm = (name: string, onConfirm: () => Promise<void>): HeaderConfirm => ({
  title: "Delete this draft source?",
  description: `${name} was never submitted, so nothing was pulled or ingested. Its connection and draft settings are removed. This can't be undone.`,
  onConfirm,
});
