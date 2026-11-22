import type { Metadata } from "next";
import { ConnectorEditor } from "@/features/integrations/connector-editor";
import { guardedTitle, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads } from "@/lib/server/prefetch";

type Params = Promise<{ id: string }>;

export const generateMetadata = (): Promise<Metadata> => guardedTitle("Connector");

/** One Open API connector: its environments, operations and Try it. */
export default async function Page({ params }: { params: Params }) {
  await requirePagePermission("integration.view");
  const { id } = await params;
  return <Prefetch reads={[reads.connector(id)]}><ConnectorEditor id={id} /></Prefetch>;
}
