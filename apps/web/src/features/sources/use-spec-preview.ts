"use client";

// The preview of any draft spec (the source mapper's dock): the same request the wizard's step 2 sends (previewBody),
// a moment after the last change, the latest answer kept. The wizard keeps its own preview for its side effects
// (types guessed from the first rows, the plain-mapping fallback for examples).
import { useEffect, useRef, useState } from "react";
import type { SourcePreviewDto, SourceSpec } from "@starterkit/shared/contracts/sources";
import { api, errorText } from "@/lib/client/api";
import { sourceApi } from "./use-sources";

/** A moment after the last change before a preview is asked for. */
const DEBOUNCE_MS = 400;

/** The preview request's body: a detected sample by id, else a pasted sample (and its file name), else a database source's date. */
export function previewBody(o: { file: boolean; sampleId: string | null; sample: string; fileName: string; businessDate: string; spec: SourceSpec }) {
  if (o.file && o.sampleId && !o.sample.trim()) return { sampleId: o.sampleId, spec: o.spec };
  if (o.file) return { sample: o.sample, ...(o.fileName.trim() ? { fileName: o.fileName.trim() } : {}), spec: o.spec };
  return { spec: o.spec, ...(o.businessDate ? { businessDate: o.businessDate } : {}) };
}

export function useSpecPreview(o: {
  spaceId: string; ids: { sourceId: string; versionId: string } | null; spec: SourceSpec; file: boolean; sampleId: string | null;
  sample: string; fileName: string; businessDate: string; enabled: boolean;
}): { result: SourcePreviewDto | null; error: string | null; pending: boolean } {
  const [state, setState] = useState<{ result: SourcePreviewDto | null; error: string | null; pending: boolean }>({ result: null, error: null, pending: false });
  const seq = useRef(0);
  const key = JSON.stringify(previewBody(o));
  useEffect(() => {
    if (!o.enabled || !o.ids) return;
    const ids = o.ids;
    const t = setTimeout(() => {
      const n = ++seq.current;
      setState((s) => ({ ...s, pending: true }));
      api<SourcePreviewDto>(sourceApi(o.spaceId, ids.sourceId, `/versions/${encodeURIComponent(ids.versionId)}/preview`), { method: "POST", body: key })
        .then((result) => { if (n === seq.current) setState({ result, error: null, pending: false }); })
        .catch((e: unknown) => { if (n === seq.current) setState((s) => ({ ...s, error: errorText(e), pending: false })); });
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
    // the request is compared by its body (key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, o.enabled, o.ids?.sourceId, o.ids?.versionId, o.spaceId]);
  return state;
}
