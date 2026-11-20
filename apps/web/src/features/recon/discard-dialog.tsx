import type { HeaderConfirm } from "@/components/shell/page-header";

/** "Delete this draft recon?" (docs/recon/README.md row Plan 3): a recon never submitted, deleted with its draft; asked from the header's ⋯ menu, a failure stays in the dialog. */
export const discardConfirm = (name: string, onConfirm: () => Promise<void>): HeaderConfirm => ({
  title: "Delete this draft recon?",
  description: `${name} was never submitted, so it never ran. Its sides, passes and draft settings are removed. This can't be undone.`,
  onConfirm,
});
