"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useRef, useState } from "react";
import { ErrorSummary, Failure, Field, FormFooter, Notice, Panel, RequiredNote, useForm } from "@starterkit/ui/ds";
import { rules, type Rule, type Schema } from "@starterkit/ui/lib/validate";
import { useDelayedFlag } from "@starterkit/ui/motion";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { SpinnerIcon, UploadIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { toast } from "@starterkit/ui/ui/toast";
import { BRAND } from "@starterkit/shared/brand";
import type { ImportFeedDto, ImportFeedSpec } from "@starterkit/shared/contracts/imports";
import { BATCH_PREFIX, HISTORY_SOURCE, RUN_TIME } from "@starterkit/shared/imports";
import { DetailNotFound } from "@/components/detail-not-found";
import { LazyConfirmActionDialog } from "@/components/lazy-confirm";
import { LoadingShape } from "@/components/route-skeleton";
import { PageHeader } from "@/components/shell/page-header";
import { ApiError, api, errorText, isNotFound } from "@/lib/client/api";
import { useAuth } from "@/lib/client/auth-context";
import { useLeaveGuard } from "@/lib/client/use-leave-guard";
import { feedHref } from "./import-model";
import { IssuesNotice } from "./issues-notice";
import { FEED_FORM_SHAPE } from "./shapes";
import { IMPORTS_KEY, useFeed } from "./use-imports";

const CREATE = { title: "Add feed", description: "Name the feed and its history source, so Monitoring watches its dates. The query, table and schedule come next." };

type Values = { name: string; historySource: string; batchPrefix: string; startDate: string; dueTime: string; graceMinutes: string };
const pattern = (re: RegExp, message: string): Rule => (value) => (typeof value === "string" && value !== "" && !re.test(value.trim()) ? message : null);
const SCHEMA: Schema<Values> = {
  name: [rules.required("Enter a feed name."), rules.maxLength(100)],
  historySource: [rules.required("Enter the history source."), pattern(HISTORY_SOURCE, "Use upper case letters, digits and _, starting with a letter, like KAI_TLHIST.")],
  batchPrefix: [rules.required("Enter the batch prefix."), pattern(BATCH_PREFIX, "Use upper case letters, digits and _, like HISTORY_TLHIST.")],
  startDate: [rules.required("Choose the first MIS date to watch.")],
  dueTime: [rules.required("Enter the due time."), pattern(RUN_TIME, "Use HH:MM on the 24-hour clock, like 06:30.")],
  graceMinutes: [rules.required("Enter the grace in minutes."), pattern(/^(\d{1,3})$/, "Enter whole minutes, 0 to 720.")],
};
const LABELS = { name: "Name", historySource: "History source", batchPrefix: "Batch prefix", startDate: "First MIS date", dueTime: "Due time", graceMinutes: "Grace" };

const valuesOf = (f?: ImportFeedDto): Values => ({
  name: f?.name ?? "", historySource: f?.spec.historySource ?? "", batchPrefix: f?.spec.batchPrefix ?? "HISTORY_TLHIST",
  startDate: f?.spec.startDate ?? "", dueTime: f?.spec.due.time ?? "06:30", graceMinutes: String(f?.spec.due.graceMinutes ?? 30),
});

/** /imports/feeds/new. */
export function CreateFeed() {
  return <div className="grid gap-section"><PageHeader {...CREATE} trail={[{ label: "Feeds", href: "/imports/feeds" }]} /><FeedForm /></div>;
}

/**
 * The feed's monitoring settings (create, or edit with the rest of its spec kept as it is): what Monitoring needs to
 * watch it from staging history. The history source and batch prefix can't change once history has a batch of them.
 */
function FeedForm({ feed }: { feed?: ImportFeedDto }) {
  const router = useRouter();
  const qc = useQueryClient();
  const initial = valuesOf(feed);
  const f = useForm<Values>({ initial, schema: SCHEMA, idPrefix: "feed" });
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = (Object.keys(initial) as (keyof Values)[]).some((k) => f.values[k] !== initial[k]);
  const guard = useLeaveGuard(dirty && !busy);

  const save = (event: FormEvent<HTMLFormElement>) => f.submit(async (v) => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    const spec: ImportFeedSpec = {
      ...(feed?.spec ?? { kind: "db_host" }),
      kind: "db_host", historySource: v.historySource.trim(), batchPrefix: v.batchPrefix.trim(), startDate: v.startDate,
      due: { time: v.dueTime.trim(), graceMinutes: Number(v.graceMinutes) },
    };
    const body = JSON.stringify({ name: v.name.trim(), spec });
    try {
      const saved = feed
        ? await api<ImportFeedDto>(`/api/imports/feeds/${encodeURIComponent(feed.id)}`, { method: "PATCH", body })
        : await api<ImportFeedDto>("/api/imports/feeds", { method: "POST", body });
      toast(feed ? `Saved ${saved.name}.` : `Added ${saved.name}.`);
      await qc.invalidateQueries({ queryKey: IMPORTS_KEY });
      if (feed) { saving.current = false; setBusy(false); } else router.push(feedHref(saved.id));
    } catch (err) {
      setError(err instanceof ApiError ? errorText(err) : errorText(err));
      saving.current = false;
      setBusy(false);
    }
  })(event);

  return (
    <Panel bodyClassName="md:p-6" icon={UploadIcon} title={feed ? "Monitoring settings" : undefined}>
      <form noValidate onSubmit={save} aria-label={feed ? "Monitoring settings" : "Add feed"} className="grid max-w-xl gap-4">
        {f.submitted && <ErrorSummary errors={f.shown} idPrefix="feed" labels={LABELS} />}
        <fieldset disabled={busy} className="contents">
          <RequiredNote />
          <Field id={f.id("name")} label="Name" required note="Unique across feeds, ignoring letter case." error={f.error("name")}>
            <Input {...f.text("name")} autoComplete="off" />
          </Field>
          <Field id={f.id("historySource")} label="History source" required
            note="The source its batches have in import_file_history, as import-host writes it (KAI_TLHIST). Fixed once history has a batch of it." error={f.error("historySource")}>
            <Input {...f.text("historySource")} autoComplete="off" className="font-mono" />
          </Field>
          <Field id={f.id("batchPrefix")} label="Batch prefix" required note="A batch's file name is <prefix>:<date>; import-host's host feeds use HISTORY_TLHIST." error={f.error("batchPrefix")}>
            <Input {...f.text("batchPrefix")} autoComplete="off" className="font-mono" />
          </Field>
          <Field id={f.id("startDate")} label="First MIS date" required note="Monitoring and the scheduler keep every date from this one on complete." error={f.error("startDate")}>
            <Input {...f.text("startDate")} type="date" className="md:w-44" />
          </Field>
          <div className="grid gap-4 md:grid-cols-2">
            <Field id={f.id("dueTime")} label="Due time" required note="MIS date D is due on D + 1 at this time." error={f.error("dueTime")}>
              <Input {...f.text("dueTime")} inputMode="numeric" placeholder="06:30" />
            </Field>
            <Field id={f.id("graceMinutes")} label="Grace" required note="Minutes after the due time before a date counts as late or missing." error={f.error("graceMinutes")}>
              <Input {...f.text("graceMinutes")} inputMode="numeric" />
            </Field>
          </div>
          {error && <p role="alert" className="text-body-sm text-down-ink">{error}</p>}
          <FormFooter className="md:-mx-6 md:-mb-6 md:px-6"
            primary={<Button type="submit" disabled={busy} aria-busy={busy || undefined}>{busy && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}{feed ? "Save settings" : "Add feed"}</Button>}
            cancel={busy ? <Button type="button" variant="ghost" disabled>Cancel</Button>
              : <Button asChild variant="ghost"><Link href={feed ? "/imports/feeds" : "/imports/feeds"}>Cancel</Link></Button>} />
        </fieldset>
      </form>
      {guard.leaving && (
        <LazyConfirmActionDialog open onOpenChange={(o) => { if (!o) guard.stay(); }} auditFields={false} reasons={[]} destructive title="Leave without saving"
          onCloseAutoFocus={(e) => { e.preventDefault(); guard.restoreFocus(); }}
          description={feed ? `Your changes to ${feed.name} aren't saved.` : "This feed isn't added yet."}
          impact={["What you typed is discarded."]} actionLabel="Leave page" onConfirm={async () => guard.leave()} />
      )}
    </Panel>
  );
}

/** /imports/feeds/[feedId]: what the feed still needs to run on its own, and its monitoring settings. */
export function FeedPage({ id }: { id: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const { can } = useAuth();
  const q = useFeed(id);
  const skeleton = useDelayedFlag(!q.data && !q.error);
  if (isNotFound(q.error)) return <DetailNotFound title="Feed" noun="feed" list={{ href: "/imports/feeds", label: "Feeds" }} />;
  if (q.error && !q.data) return <div className="grid gap-section"><PageHeader title="Feed" /><Panel><Failure title="Couldn't load this feed" error={q.error} source={BRAND.name} onRetry={() => void q.refetch()} /></Panel></div>;
  if (!q.data || skeleton) return <LoadingShape sections={FEED_FORM_SHAPE} shown={skeleton} />;
  const feed = q.data;
  async function remove() {
    await api(`/api/imports/feeds/${encodeURIComponent(feed.id)}`, { method: "DELETE" });
    toast(`Deleted ${feed.name}.`);
    await qc.invalidateQueries({ queryKey: IMPORTS_KEY });
    router.push("/imports/feeds");
  }
  return (
    <div className="grid gap-section">
      <PageHeader title={feed.name} description={`History source ${feed.spec.historySource} · scheduler ${feed.schedulerOn ? "on" : "off"}`}
        trail={[{ label: "Feeds", href: "/imports/feeds" }]}
        more={can("import.manage") ? [{
          label: "Delete feed", destructive: true as const, reason: feed.schedulerOn ? "Turn the scheduler off first." : null,
          confirm: { title: `Delete ${feed.name}`, description: "Monitoring stops watching it.", impact: ["Its settings and its run and check logs are removed.", "Its staging table and history stay as they are.", "This can't be undone."], onConfirm: remove },
        }] : undefined} />
      <IssuesNotice />
      {q.error && <Notice tone="warn" live>Couldn&apos;t refresh this feed; showing the last loaded settings.</Notice>}
      {feed.missing.length > 0 && (
        <Notice>
          Monitoring watches this feed from its history. To load data on its own it still needs: {feed.missing.join(" ")}
        </Notice>
      )}
      {can("import.manage") ? <FeedForm key={feed.updatedAt} feed={feed} /> : (
        <Panel icon={UploadIcon} title="Monitoring settings">
          <dl className="grid gap-2 p-4 text-body-sm md:grid-cols-[12rem_1fr]">
            <dt className="text-fg-3">History source</dt><dd className="font-mono">{feed.spec.historySource}</dd>
            <dt className="text-fg-3">Batch prefix</dt><dd className="font-mono">{feed.spec.batchPrefix}</dd>
            <dt className="text-fg-3">First MIS date</dt><dd>{feed.spec.startDate}</dd>
            <dt className="text-fg-3">Due</dt><dd>The next day at {feed.spec.due.time}, plus {feed.spec.due.graceMinutes} minutes</dd>
          </dl>
        </Panel>
      )}
    </div>
  );
}
