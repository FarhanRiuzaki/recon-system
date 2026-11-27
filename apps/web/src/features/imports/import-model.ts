// Words and status chips of the Import section (DEC-066), one table per domain: a state's colour and label sit on one
// row (categories.ts statusChips), and every Import screen and legend reads them from here.
import type { DateState, SchedulerState } from "@starterkit/shared/imports";
import { statusChips } from "@/lib/shared/categories";

/** A feed's MIS date (Monitoring's grid). */
export const dateChip = statusChips<DateState>({
  waiting: ["no_data", "Waiting"],
  not_ready: ["waiting", "Not ready"],
  imported: ["done", "Imported"],
  late: ["late", "Late"],
  missing: ["missing", "Missing"],
  failed: ["failed", "Failed"],
  rerun: ["queued", "Rerun"],
});
export const DATE_DESCRIPTION: Record<DateState, string> = {
  waiting: "Not due yet and nothing loaded so far.",
  not_ready: "Checked, but the source hadn't loaded this date yet. It is checked again at the next run.",
  imported: "Loaded into the staging table before its due time.",
  late: "Loaded, but after its due time.",
  missing: "Past its due time and still not loaded. Check the source and the scheduler.",
  failed: "The load failed. Open the date for the error, fix the cause, then retry it.",
  rerun: "Set to load again: the next run reads it from the source and replaces its rows.",
};
export const DATE_LEGEND = (Object.keys(DATE_DESCRIPTION) as DateState[]).map((s) => ({ ...dateChip(s), description: DATE_DESCRIPTION[s] }));

/** A feed's scheduler (Monitoring's scheduler table). */
export const schedulerChip = statusChips<SchedulerState>({
  ok: ["healthy", "Running"],
  missed: ["missing", "Missed"],
  stuck: ["error", "Stuck"],
  lock_left: ["error", "Lock left"],
  connection_failing: ["failed", "Connection failing"],
  off: ["off", "Off"],
});
export const SCHEDULER_DESCRIPTION: Record<SchedulerState, string> = {
  ok: "Its runs start on time.",
  missed: "A run time passed 10 minutes ago and no run started. Check that the worker is running.",
  stuck: "A run stopped answering, or is taking longer than the feed allows.",
  lock_left: "A batch has been held for over 60 minutes by a run that stopped, so its date can't load. Release it.",
  connection_failing: "The last check couldn't reach the source database.",
  off: "Its scheduler is off: nothing runs on its own. Its dates are still watched from the history.",
};
export const SCHEDULER_LEGEND = (Object.keys(SCHEDULER_DESCRIPTION) as SchedulerState[]).map((s) => ({ ...schedulerChip(s), description: SCHEDULER_DESCRIPTION[s] }));

/** Scheduler states that are an issue (Monitoring's badge counts them). */
export const BAD_SCHEDULERS: readonly SchedulerState[] = ["missed", "stuck", "lock_left", "connection_failing"];

export const feedHref = (id: string) => `/imports/feeds/${encodeURIComponent(id)}`;
