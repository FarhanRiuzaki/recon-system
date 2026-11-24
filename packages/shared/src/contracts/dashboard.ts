import { z } from "zod";
import { ActivityDto } from "./audit";
import { MAX_RANGE_DAYS, rangeProblem } from "../audit";

import { isTimeExpression, timeRangeProblem, MAX_TIME_RANGE_DAYS } from "@starterkit/ui/lib/time-range";

export const DashboardQuery = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional(), start: z.string().max(100).refine(isTimeExpression).optional(), end: z.string().max(100).refine(isTimeExpression).optional() })
  .refine((q) => rangeProblem(q.from, q.to) === null && timeRangeProblem(q, Date.now()) === null, { message: `Choose both dates in order, up to ${MAX_RANGE_DAYS} days.` });
export type DashboardQuery = z.infer<typeof DashboardQuery>;

/** Days in `loginsPerDay`. */
export const DASHBOARD_DAYS = 14;

/**
 * GET /api/dashboard (any signed-in user). Audit-derived detail needs `audit.view`: without it `failedLogins24h`,
 * `failedLoginsPrev24h`, `recent` and every day's `failed` count are null (successful sign-ins stay). `loginsPerDay` = sign-in outcomes for the 14 calendar days in the app time zone ending today,
 * oldest first, every day present (0 when nothing happened).
 */
export const DashboardDto = z.object({
  activeUsers: z.number().int(),
  /** Users created in the last 7 × 24 hours. */
  newUsers7d: z.number().int(),
  /** Users created in the 7 × 24 hours before those: the tile's comparison. */
  newUsersPrev7d: z.number().int(),
  /** `login_failed` entries in the last 24 hours. */
  failedLogins24h: z.number().int().nullable(),
  /** `login_failed` entries in the 24 hours before those: the tile's comparison. */
  failedLoginsPrev24h: z.number().int().nullable(),
  /** Live store sessions of active users. */
  activeSessions: z.number().int(),
  loginsPerDay: z.array(z.object({ date: z.iso.date(), success: z.number().int(), failed: z.number().int().nullable() })).min(1).max(MAX_TIME_RANGE_DAYS + 1),
  /** Present for an explicitly selected range. Snapshot counts and recent activity keep their own scope. */
  period: z.object({
    from: z.iso.date(), to: z.iso.date(), start: z.iso.datetime().optional(), end: z.iso.datetime().optional(), newUsers: z.number().int(), previousNewUsers: z.number().int(),
    failedSignIns: z.number().int().nullable(), previousFailedSignIns: z.number().int().nullable(),
  }).optional(),
  /** The 5 newest activity entries. */
  recent: z.array(ActivityDto).max(5).nullable(),
});
export type DashboardDto = z.infer<typeof DashboardDto>;

/**
 * GET /api/dashboard/recon: `space` one of the viewer's spaces (else every space they hold a role in; a Superadmin every
 * space), `recon` one recon of those, `from`/`to` business dates (Asia/Jakarta; both or neither, at most MAX_RANGE_DAYS;
 * neither = the last RECON_DASHBOARD_DAYS days ending today).
 */
export const ReconDashboardQuery = z.object({ space: z.uuid().optional(), recon: z.uuid().optional(), from: z.iso.date().optional(), to: z.iso.date().optional() })
  .refine((q) => rangeProblem(q.from, q.to) === null, { message: `Choose both dates in order, up to ${MAX_RANGE_DAYS} days.` });
export type ReconDashboardQuery = z.infer<typeof ReconDashboardQuery>;
/** The default period of the recon dashboard. */
export const RECON_DASHBOARD_DAYS = 7;

/** Amounts per currency (minor units as text, absolute), never summed across currencies; `items` behind each. */
const Amounts = z.array(z.object({ currency: z.string(), amountMinor: z.string(), items: z.number().int() }));
const Dates = z.object({ from: z.iso.date(), to: z.iso.date() });
const AGE_KEYS = ["d0_1", "d2_3", "d4_7", "gt7"] as const;
const CLOSED_KEYS = ["auto", "late", "manual", "force", "posted", "written_off", "closed"] as const;

/**
 * The recon dashboard (docs/superpowers/plans/2026-11-24-recon-dashboard.md "Number definitions"): period numbers from
 * the daily rollup (records and Operation result rows of the period's business dates), live "now" numbers (open
 * unmatch, its age and reasons, waiting approvals) and live period numbers of posting runs and approvals. `prev*` = the
 * same number over `previous`. `computedAt` = the oldest rollup row read (null when none).
 */
export const ReconDashboardDto = z.object({
  period: Dates, previous: Dates,
  spaces: z.array(z.object({ id: z.string(), name: z.string() })),
  recons: z.array(z.object({ id: z.string(), name: z.string(), spaceId: z.string() })),
  /** rows = Operation result rows of status matched (the list the tile opens); matched / records = the rate, by records. */
  autoRate: z.object({ rows: z.number().int(), matched: z.number().int(), records: z.number().int(), prevMatched: z.number().int(), prevRecords: z.number().int() }),
  open: z.object({ count: z.number().int(), amounts: Amounts, pastCarryOver: z.number().int(), broke: z.number().int(), prevBroke: z.number().int() }),
  resolved: z.object({ rows: z.number().int(), prevRows: z.number().int(), medianMinutes: z.number().nullable() }),
  posting: z.object({ posted: z.number().int(), finished: z.number().int(), failed: z.number().int(), prevPosted: z.number().int(), prevFinished: z.number().int() }),
  approvals: z.object({
    waiting: z.number().int(), oldestAt: z.string().nullable(), requested: z.number().int(), prevRequested: z.number().int(),
    decided: z.number().int(), rejected: z.number().int(), medianMinutes: z.number().nullable(),
  }),
  days: z.array(z.object({ date: z.iso.date(), auto: z.number().int(), manual: z.number().int(), broke: z.number().int(), matched: z.number().int(), records: z.number().int() })),
  age: z.array(z.object({ key: z.enum(AGE_KEYS), count: z.number().int(), amounts: Amounts })),
  reasons: z.array(z.object({ reason: z.string(), count: z.number().int() })),
  closed: z.array(z.object({ key: z.enum(CLOSED_KEYS), rows: z.number().int() })),
  writtenOff: Amounts,
  bySpace: z.array(z.object({ id: z.string(), name: z.string(), open: z.number().int(), amounts: Amounts, matched: z.number().int(), records: z.number().int(), writtenOff: Amounts })),
  rows: z.array(z.object({
    id: z.string(), name: z.string(), spaceId: z.string(), spaceName: z.string(), records: z.number().int(), matched: z.number().int(),
    open: z.number().int(), amounts: Amounts, oldest: z.iso.date().nullable(), postingFailed: z.number().int(),
    lastRun: z.object({ status: z.enum(["queued", "running", "succeeded", "failed"]), at: z.string() }).nullable(),
  })),
  computedAt: z.string().nullable(),
  /** Dates of the period (`days`) and of the one before (`prevDays`) that hold results whose rollup row is not written yet: their period numbers are not final. */
  pending: z.object({ days: z.number().int(), prevDays: z.number().int() }),
});
export type ReconDashboardDto = z.infer<typeof ReconDashboardDto>;
