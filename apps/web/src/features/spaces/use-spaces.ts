import { useQuery } from "@tanstack/react-query";
import { api, retryUnlessNotFound } from "@/lib/client/api";
import type { Page } from "@starterkit/shared/contracts/common";
import type { SpaceCandidateDto, SpaceRowDto } from "@starterkit/shared/contracts/spaces";
import { spaceCandidates, spaceDetail, spaceOptions, SPACES_KEY } from "@/lib/shared/queries";

export { SPACES_KEY };
export { ROLE_DESCRIPTION, ROLE_LABEL } from "@starterkit/shared/spaces";

/** Why a member action is off (Build notes 01 final copy); shared by the members page and the role checklist. */
export const SOURCE_ADMIN_REASON = "Only an app admin can grant or remove Source admin.";
export const LAST_SPACE_ADMIN = "A space needs at least one space admin.";

export const spaceHref = (id: string, page: "members") => `/spaces/${encodeURIComponent(id)}/${page}`;

/** Every space the caller belongs to, for the switcher (one page of 100, name A–Z). The members table is the members screen's own `useTableQuery(SPACE_MEMBERS(id))`. */
export function useSpaces() {
  const { key, url } = spaceOptions();
  return useQuery({ queryKey: key, queryFn: () => api<Page<SpaceRowDto>>(url) });
}

/** The space with the caller's roles in it ([] when let in through space.manage). A 404 is final (no retry). */
export function useSpace(id: string) {
  const { key, url } = spaceDetail(id);
  return useQuery({ queryKey: key, queryFn: () => api<SpaceRowDto>(url), retry: retryUnlessNotFound });
}

export function useCandidates(id: string, q = "") {
  const { key, url } = spaceCandidates(id, q);
  return useQuery({ queryKey: key, queryFn: () => api<Page<SpaceCandidateDto>>(url) });
}
