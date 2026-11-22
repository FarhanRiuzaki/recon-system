import type { Metadata } from "next";
import { LibraryEditor } from "@/features/approvals/library-editor";
import { guardedTitle, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads } from "@/lib/server/prefetch";

type Params = Promise<{ id: string }>;

export const generateMetadata = (): Promise<Metadata> => guardedTitle("Workflow");

/** One library workflow: its levels (a draft to edit, or the live version) beside the approval rules that use it. */
export default async function Page({ params }: { params: Params }) {
  await requirePagePermission("workflow.view");
  const { id } = await params;
  return <Prefetch reads={[reads.libraryWorkflow(id)]}><LibraryEditor id={id} /></Prefetch>;
}
