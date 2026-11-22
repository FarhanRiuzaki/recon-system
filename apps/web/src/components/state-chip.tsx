import { CategoryChip, StatusChip } from "@starterkit/ui/ds";
import type { Chip } from "@/lib/shared/categories";

/** A value's chip: its health as a StatusChip, anything else as a CategoryChip (design-system §5.8 "Categories"). */
export const StateChip = ({ chip }: { chip: Chip }) =>
  "health" in chip ? <StatusChip health={chip.health} label={chip.label} /> : <CategoryChip slot={chip.slot} label={chip.label} />;
