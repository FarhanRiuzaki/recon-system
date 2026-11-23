import type { VariantProps } from "class-variance-authority";
import type { buttonVariants } from "../ui/button";

type Variant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;

// The verbs of the create / edit / remove intents (owner 24 Nov), apart from `INTENTS` so `verbVariant` (the page header,
// in every route) doesn't keep the intents' icons in the bundle.
export const CREATE_VERBS = ["Create", "Add", "New"] as const;
export const EDIT_VERBS = ["Edit", "Replace", "Continue editing"] as const;
export const REMOVE_VERBS = ["Remove", "Delete"] as const;

const starts = (words: readonly string[]) => new RegExp(`^(${words.join("|")})\\b`);
const CREATE = starts(CREATE_VERBS), EDIT = starts(EDIT_VERBS), REMOVE = starts(REMOVE_VERBS);

/** The quiet variant a label's verb asks for (Create / Add / New → create, Edit → edit, Delete / Remove → remove), else `fallback`: for a button whose label is data (a header action). */
export function verbVariant(label: string, fallback: Variant): Variant {
  return CREATE.test(label) ? "create" : EDIT.test(label) ? "edit" : REMOVE.test(label) ? "remove" : fallback;
}
