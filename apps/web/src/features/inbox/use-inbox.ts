import { useQuery } from "@tanstack/react-query";
import type { InboxFolderListDto } from "@starterkit/shared/contracts/inbox";
import type { SpaceRowDto } from "@starterkit/shared/contracts/spaces";
import { api } from "@/lib/client/api";
import { INBOX_KEY, inboxFolders, spaceDetail } from "@/lib/shared/queries";

export { INBOX_KEY };

/** The space's inbox root and folders (each with its file count and status summary). */
export function useInboxFolders(spaceId: string) {
  const { key, url } = inboxFolders(spaceId);
  return useQuery({ queryKey: key, queryFn: () => api<InboxFolderListDto>(url) });
}

/** The space with the caller's roles in it (the inbox actions are decided by mayDo on these). */
export function useInboxSpace(spaceId: string) {
  const { key, url } = spaceDetail(spaceId);
  return useQuery({ queryKey: key, queryFn: () => api<SpaceRowDto>(url) }).data;
}
