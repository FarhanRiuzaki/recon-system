"use client";

// The open draft's two endings, asked with their impact (the recon's page and its setup share them): discard a live
// recon's draft (its version keeps running), or delete a draft recon nobody submitted.
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "@starterkit/ui/ui/toast";
import type { ReconDto } from "@starterkit/shared/contracts/recon";
import type { HeaderAction, HeaderConfirm } from "@/components/shell/page-header";
import { api } from "@/lib/client/api";
import { ENGINE_KEY, RECON_KEY } from "@/lib/shared/queries";
import { discardConfirm } from "./discard-dialog";
import { reconApi, reconHref, reconsHref } from "./use-recons";

/** A recon nobody submitted (DELETE …/recons/{id} takes it), for a config maker or a space admin. */
export const discardable = (r: ReconDto, roles: readonly string[]) =>
  (roles.includes("config_maker") || roles.includes("space_admin")) && r.publishedVersion === null && !!r.draft && !r.draft.submitterId && !r.draft.reviewComment;

/** The ⋯ items that end an open draft: "Discard draft vN" (a live recon's) and "Delete draft recon" (one never submitted). */
export function useDraftEndings(spaceId: string, r: ReconDto | undefined, roles: readonly string[]): HeaderAction[] {
  const qc = useQueryClient();
  const router = useRouter();
  if (!r) return [];
  const maker = roles.includes("config_maker");
  const out: HeaderAction[] = [];
  if (maker && r.draft?.status === "draft" && r.published) {
    const v = r.draft.version, live = r.published.version;
    const confirm: HeaderConfirm = {
      title: `Discard Draft v${v}?`,
      description: `The changes since version ${live} are removed, with the draft's simulations. Version ${live} keeps running. This can't be undone.`,
      onConfirm: async () => {
        await api(reconApi(spaceId, r.id, `/versions/${encodeURIComponent(r.draft!.id)}`), { method: "DELETE" });
        toast(`Discarded Draft v${v}. Version ${live} keeps running.`);
        await Promise.all([qc.invalidateQueries({ queryKey: RECON_KEY }), qc.invalidateQueries({ queryKey: ENGINE_KEY })]);
        router.push(reconHref(spaceId, r.id));
      },
    };
    out.push({ label: `Discard draft v${v}`, destructive: true, confirm });
  }
  if (discardable(r, roles)) {
    out.push({ label: "Delete draft recon", destructive: true, confirm: discardConfirm(r.name, async () => {
      await api(reconApi(spaceId, r.id), { method: "DELETE" });
      toast(`Deleted the draft recon ${r.name}.`);
      await qc.invalidateQueries({ queryKey: RECON_KEY });
      router.push(reconsHref(spaceId));
    }) });
  }
  return out;
}
