import type { Section } from "@/components/route-skeleton";

// Loading shape of the approvals screen, apart from it so loading.tsx never pulls the screen's code into the first load.

/** /spaces/[spaceId]/approvals: the header and the requests table. */
export const APPROVALS_SHAPE: readonly Section[] = [
  { kind: "header", h: 68 },
  { kind: "table", chrome: 144, rows: "page", rowHeight: 56 },
];
