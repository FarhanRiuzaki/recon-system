import type { VariantProps } from "class-variance-authority";
import type { buttonVariants } from "../ui/button";
import type { IconData } from "../ui/icon";
import { AddIcon, EditIcon, ErrorIcon, ExportIcon, RefreshIcon, RemoveIcon } from "../ui/icons";

type Variant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;

/**
 * Every action has an intent: colour, icon and verb together (design-system.md §5.3). Colour marks what changes data;
 * everything else is neutral and carries its verb icon. `actions` are the labels' first words, as a button starts
 * ("Reject", "Export CSV"); `apps/web/src/test/architecture.test.ts` reads `caution` and the `required` intents from
 * here. `icon` = the intent's one icon (absent: the action's own verb icon, or none); `required` = a Button with that
 * label must render an `<Icon>`. `variant` lists more than one when a confirm dialog may carry the action.
 */
export type Intent = { variant: Variant | readonly Variant[]; actions: readonly string[]; icon?: IconData; required?: boolean; note: string };

export const INTENTS = {
  next: { variant: "default", actions: ["Request posting", "Approve", "Match pair", "Take", "Send for approval", "Create", "Run"], note: "The next step; one per page." },
  second: { variant: "secondary", actions: ["Force match", "Write-off", "Close", "Assign"], note: "A second choice, with its verb icon." },
  // a confirm dialog's Turn off is destructive, so the rule accepts both
  caution: { variant: ["caution", "destructive"], actions: ["Reject", "Turn off", "Cancel request"], icon: ErrorIcon, note: "A negative decision: Down ink on a line edge." },
  destructive: { variant: "destructive", actions: ["Remove"], note: "Confirms a removal inside its dialog." },
  add: { variant: "add", actions: ["Add"], icon: AddIcon, required: true, note: "Adds a row, level, group, filter, pass, action or variant." },
  remove: { variant: "remove", actions: ["Remove"], icon: RemoveIcon, note: "Takes one out of a list (bin or X)." },
  edit: { variant: "ghost", actions: ["Edit", "Replace"], icon: EditIcon, required: true, note: "Never a bare word; a Change that edits a record (Change server) takes it too." },
  navigate: { variant: "link", actions: ["Open", "View", "Review"], note: "A link with a trailing arrow." },
  output: { variant: "secondary", actions: ["Export"], icon: ExportIcon, required: true, note: "Export, Get token, Show who approves: secondary with its icon." },
  retry: { variant: "secondary", actions: ["Retry", "Try again"], icon: RefreshIcon, required: true, note: "Secondary with Refresh." },
} as const satisfies Record<string, Intent>;
