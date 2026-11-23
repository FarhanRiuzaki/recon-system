// An approval action run's status and event in words (stage 4), shared by the API's CSV and the web. Zod-free.

export type PostingStatus = "queued" | "sending" | "posted" | "failed" | "not_sent" | "timeout" | "no_rule" | "skipped" | "grouped";
export const POSTING_STATUS_LABEL: Record<PostingStatus, string> = {
  posted: "Posted", failed: "Failed", not_sent: "Not sent", timeout: "Timeout", no_rule: "No posting rule", skipped: "Skipped", queued: "Waiting to send", sending: "Sending", grouped: "Waiting for group",
};
/** A posting group's key as people read it: "Merchant id 0012345 · Currency IDR"; an empty value "No Merchant id"; no key "All items". */
export const groupKeyText = (keys: readonly { label: string; value: string }[]) =>
  keys.length ? keys.map((k) => (k.value ? `${k.label} ${k.value}` : `No ${k.label}`)).join(" · ") : "All items";
export const postingEvent =(e: { event: "level_approved" | "approved" | "rejected"; level: number | null }) =>
  e.event === "level_approved" ? `Level ${e.level} approved` : e.event === "approved" ? "Approved" : "Rejected";
