import type { Metadata } from "next";
import { CreateFeed } from "@/features/imports/feed-form";
import { guardedTitle, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch } from "@/lib/server/prefetch";

export const generateMetadata = (): Promise<Metadata> => guardedTitle("Add feed");

export default async function Page() {
  await requirePagePermission("import.manage");
  return <Prefetch reads={[]}><CreateFeed /></Prefetch>;
}
