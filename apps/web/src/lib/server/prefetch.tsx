import { filterQueryValues } from "@starterkit/shared/filter-selection";
import "server-only";
import { type DehydratedState, dehydrate, QueryClient, type QueryKey } from "@tanstack/react-query";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import type { z } from "zod";
import { Hydrate } from "@/lib/client/hydrate";
import { ApprovalListQuery } from "@starterkit/shared/contracts/approvals";
import { ActivityQuery, AuthLogQuery } from "@starterkit/shared/contracts/audit";
import { BreakListQuery } from "@starterkit/shared/contracts/breaks";
import { SessionListQuery } from "@starterkit/shared/contracts/me";
import { ProjectListQuery } from "@starterkit/shared/contracts/projects";
import { ReconActivityQuery, ReconListQuery, ReconRunItemQuery, ReconVersionListQuery } from "@starterkit/shared/contracts/recon";
import { IngestListQuery, RecordListQuery, SourceListQuery, SourceVersionListQuery } from "@starterkit/shared/contracts/sources";
import { SpaceMemberListQuery } from "@starterkit/shared/contracts/spaces";
import { PermissionListQuery, RoleListQuery } from "@starterkit/shared/contracts/rbac";
import { UserListQuery } from "@starterkit/shared/contracts/users";
import {
  ACTIVITY, APPROVALS, AUTH_LOG, BREAKS, activityEntry, dashboardRead, ME_KEY, MY_SESSIONS, PERMISSIONS_TABLE, projectDetail, PROJECTS, SPACE_MEMBERS, spaceDetail, spaceOptions, roleKey, roleOptions, roleUrl, ROLES, SUPERADMINS,
  draftSimulations, reconActivity, reconDetail, reconRun, reconLive, reconRunItems, reconRunsFirst, reconTrend, RECONS, reconVersion, reconVersions, sideSourceOptions, spaceToday,
  sourceActivity, sourceDetail, sourceFiles, sourcePullsFirst, sourceQuarantine, sourceRecords, SOURCES, sourceSnapshots, sourceSummary, sourceVersion, sourceVersions,
  type TableDef, userDetail as userDetailQuery, USERS, userSessions as userSessionsTable, userSpaces as userSpacesQuery,
} from "@/lib/shared/queries";
import { readTable, tableRequest } from "@/lib/shared/table-state";
import { backendJson, v1Path } from "./backend";
import { getSession } from "./session";

/**
 * One first-page read of a screen: the browser hook's query key and the `/api/...` URL the hook fetches (null = the
 * request would be the route's 400: nothing to prefetch).
 */
export type Read = { key: QueryKey; path: string | null };

export type SearchParams = Record<string, string | string[] | undefined>;
/** Next's `searchParams` prop → URLSearchParams (`get` = the first value, as in the browser). */
export function toSearch(sp: SearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) for (const x of Array.isArray(v) ? v : v == null ? [] : [v]) out.append(k, x);
  return out;
}

/**
 * The first page of a server table at the URL state `sp`: the key and request useTableQuery builds (tableRequest).
 * A request the route's schema would reject (400) reads nothing.
 */
export function table<F extends Record<string, string>, Q>(def: TableDef<F>, sp: URLSearchParams, schema: z.ZodType<Q>): Read {
  const { url } = tableRequest(def.path, readTable(sp, def.spec), def.spec, def.params, { search: sp, keys: def.rawFilters ?? [] });
  const ok = schema.safeParse(filterQueryValues(new URL(url, "http://local").searchParams)).success;
  return { key: [def.key, url], path: ok ? url : null };
}

/** What each screen reads first (app/(main)/** page.tsx lists its own), each the GET its browser hook sends. */
export const reads = {
  dashboard: (sp = new URLSearchParams()): Read => dashboardRead(sp),
  me: (): Read => ({ key: ME_KEY, path: "/api/me" }),
  mySessions: (sp: URLSearchParams) => table(MY_SESSIONS, sp, SessionListQuery),
  users: (sp: URLSearchParams) => table(USERS, sp, UserListQuery),
  roleOptions: (): Read => ({ key: roleOptions().key, path: roleOptions().url }),
  superadmins: (): Read => ({ key: SUPERADMINS.key, path: SUPERADMINS.url }),
  user: (id: string): Read => ({ key: userDetailQuery(id).key, path: userDetailQuery(id).url }),
  userSessions: (id: string, sp: URLSearchParams) => table(userSessionsTable(id), sp, SessionListQuery),
  userSpaces: (id: string): Read => ({ key: userSpacesQuery(id).key, path: userSpacesQuery(id).url }),
  roles: (sp: URLSearchParams) => table(ROLES, sp, RoleListQuery),
  role: (id: string): Read => ({ key: roleKey(id), path: roleUrl(id) }),
  permissions: (sp: URLSearchParams) => table(PERMISSIONS_TABLE, sp, PermissionListQuery),
  activityEntry: (id: string): Read => ({ key: activityEntry(id).key, path: activityEntry(id).url }),
  activity: (sp: URLSearchParams) => table(ACTIVITY, sp, ActivityQuery),
  authLog: (sp: URLSearchParams) => table(AUTH_LOG, sp, AuthLogQuery),
  projects: (sp: URLSearchParams) => table(PROJECTS, sp, ProjectListQuery),
  project: (id: string): Read => ({ key: projectDetail(id).key, path: projectDetail(id).url }),
  spaceOptions: (): Read => ({ key: spaceOptions().key, path: spaceOptions().url }),
  space: (id: string): Read => ({ key: spaceDetail(id).key, path: spaceDetail(id).url }),
  spaceMembers: (id: string, sp: URLSearchParams) => table(SPACE_MEMBERS(id), sp, SpaceMemberListQuery),
  sources: (spaceId: string, sp: URLSearchParams) => table(SOURCES(spaceId), sp, SourceListQuery),
  sourceSummary: (spaceId: string): Read => ({ key: sourceSummary(spaceId).key, path: sourceSummary(spaceId).url }),
  source: (spaceId: string, id: string): Read => ({ key: sourceDetail(spaceId, id).key, path: sourceDetail(spaceId, id).url }),
  sourceFiles: (spaceId: string, id: string, sp: URLSearchParams) => table(sourceFiles(spaceId, id), sp, IngestListQuery),
  sourceSnapshots: (spaceId: string, id: string, sp: URLSearchParams) => table(sourceSnapshots(spaceId, id), sp, IngestListQuery),
  sourceQuarantine: (spaceId: string, id: string, sp: URLSearchParams) => table(sourceQuarantine(spaceId, id), sp, IngestListQuery),
  sourcePulls: (spaceId: string, id: string): Read => ({ key: sourcePullsFirst(spaceId, id).key, path: sourcePullsFirst(spaceId, id).url }),
  sourceRecords: (spaceId: string, id: string, sp: URLSearchParams) => table(sourceRecords(spaceId, id), sp, RecordListQuery),
  sourceVersions: (spaceId: string, id: string, sp: URLSearchParams) => table(sourceVersions(spaceId, id), sp, SourceVersionListQuery),
  sourceActivity: (spaceId: string, id: string, sp: URLSearchParams) => table(sourceActivity(spaceId, id), sp, IngestListQuery),
  sourceVersion: (spaceId: string, id: string, versionId: string): Read => ({ key: sourceVersion(spaceId, id, versionId).key, path: sourceVersion(spaceId, id, versionId).url }),
  approvals: (spaceId: string, sp: URLSearchParams) => table(APPROVALS(spaceId), sp, ApprovalListQuery),
  breaks: (spaceId: string, sp: URLSearchParams) => table(BREAKS(spaceId), sp, BreakListQuery),
  recons: (spaceId: string, sp: URLSearchParams) => table(RECONS(spaceId), sp, ReconListQuery),
  recon: (spaceId: string, id: string): Read => ({ key: reconDetail(spaceId, id).key, path: reconDetail(spaceId, id).url }),
  reconVersions: (spaceId: string, id: string, sp: URLSearchParams) => table(reconVersions(spaceId, id), sp, ReconVersionListQuery),
  reconActivity: (spaceId: string, id: string, sp: URLSearchParams) => table(reconActivity(spaceId, id), sp, ReconActivityQuery),
  reconVersion: (spaceId: string, id: string, versionId: string): Read => ({ key: reconVersion(spaceId, id, versionId).key, path: reconVersion(spaceId, id, versionId).url }),
  draftSimulations: (spaceId: string, id: string, versionId: string): Read => ({ key: draftSimulations(spaceId, id, versionId).key, path: draftSimulations(spaceId, id, versionId).url }),
  reconRun: (spaceId: string, id: string, runId: string): Read => ({ key: reconRun(spaceId, id, runId).key, path: reconRun(spaceId, id, runId).url }),
  reconRunItems: (spaceId: string, id: string, runId: string, sp: URLSearchParams, passes: readonly { accept: string; cardinality: string }[]) =>
    table(reconRunItems(spaceId, id, runId, passes), sp, ReconRunItemQuery),
  spaceToday: (spaceId: string): Read => ({ key: spaceToday(spaceId).key, path: spaceToday(spaceId).url }),
  reconLive: (spaceId: string, id: string): Read => ({ key: reconLive(spaceId, id).key, path: reconLive(spaceId, id).url }),
  reconTrend: (spaceId: string, id: string): Read => ({ key: reconTrend(spaceId, id).key, path: reconTrend(spaceId, id).url }),
  reconRunsFirst: (spaceId: string, id: string): Read => ({ key: reconRunsFirst(spaceId, id).key, path: reconRunsFirst(spaceId, id).url }),
  sideSourceOptions: (spaceId: string): Read => ({ key: sideSourceOptions(spaceId).key, path: sideSourceOptions(spaceId).url }),
};

type SpecHolder = { id?: string; spec?: { sides?: { source_id: string }[] }; draft?: SpecHolder | null; published?: SpecHolder | null };
/**
 * What a recon page shows beside the recon (the recon, or its version `versionId`): read once on the server to learn
 * which sources the spec names, so the builder's field names render filled on the first paint; on the recon's own
 * page also its open draft with the names of the people it names (the maker beside "Draft vN").
 */
export async function reconSourceReads(spaceId: string, configId: string, versionId?: string): Promise<Read[]> {
  const s = await getSession();
  const path = v1Path(versionId ? reconVersion(spaceId, configId, versionId).url : reconDetail(spaceId, configId).url);
  if (!s.token || !path) return [];
  const { data } = await backendJson<SpecHolder>(path, { token: s.token, req: { headers: await headers() } });
  const sides = (data?.spec ?? data?.draft?.spec ?? data?.published?.spec)?.sides;
  // the open draft: its people, and its latest simulation for the simulation bar
  const draft = !versionId && data?.draft?.id ? [reads.reconVersion(spaceId, configId, data.draft.id), reads.draftSimulations(spaceId, configId, data.draft.id)] : [];
  return [...sourceReads(spaceId, sides), ...draft];
}
/** The sources a spec's sides read, once each. */
const sourceReads = (spaceId: string, sides: { source_id: string }[] = []) => [...new Set(sides.map((x) => x.source_id))].map((id) => reads.source(spaceId, id));


/**
 * What a run's page shows: the run, its version (the passes name the tabs and decide the table's request) with its
 * sides' sources, and the items of the tab in the URL. Read once on the server for the version id and its passes.
 */
export async function reconRunReads(spaceId: string, configId: string, runId: string, sp: URLSearchParams): Promise<Read[]> {
  const s = await getSession();
  const path = v1Path(reconRun(spaceId, configId, runId).url);
  if (!s.token || !path) return [];
  const req = { headers: await headers() };
  const { data: run } = await backendJson<{ versionId: string }>(path, { token: s.token, req });
  if (!run) return [reads.reconRun(spaceId, configId, runId)];
  const vPath = v1Path(reconVersion(spaceId, configId, run.versionId).url);
  const { data: v } = vPath
    ? await backendJson<{ spec?: { passes?: { accept: string; cardinality: string }[]; sides?: { source_id: string }[] } }>(vPath, { token: s.token, req }) : { data: null };
  return [
    reads.reconRun(spaceId, configId, runId), reads.reconVersion(spaceId, configId, run.versionId),
    reads.reconRunItems(spaceId, configId, runId, sp, v?.spec?.passes ?? []), ...sourceReads(spaceId, v?.spec?.sides),
  ];
}

/**
 * Sends every read to the API (`/api/x` → `/v1/x`) with the session token, all at once, and puts each 200 answer under
 * its key in a dehydrated React Query cache. Anything else (403, 404, the API down) is left out: the browser then
 * fetches it and shows its own forbidden, not-found or error state.
 */
export async function prefetchState(token: string, list: readonly Read[], req?: { headers: Headers }): Promise<DehydratedState> {
  const client = new QueryClient();
  const answers = await Promise.all(list.map((r) => {
    const path = r.path && v1Path(r.path);
    return path ? backendJson(path, { token, req }) : null;
  }));
  answers.forEach((a, i) => {
    if (a?.status === 200) client.setQueryData(list[i]!.key, a.data);
  });
  return dehydrate(client);
}

/**
 * Server half of the no-flicker standard: a page wraps its screen in `<Prefetch reads={[…]}>`, so its first data is
 * read on the server from the same API endpoints the browser hooks call and handed to React Query; the page renders
 * filled on the first paint and the browser doesn't fetch it again. Without a full session nothing is read (the
 * layout sends the browser to sign-in).
 */
export async function Prefetch({ reads: list, children }: { reads: readonly Read[]; children: ReactNode }) {
  const s = await getSession();
  const state = s.token && s.csrf ? await prefetchState(s.token, list, { headers: await headers() }) : undefined;
  return <Hydrate state={state}>{children}</Hydrate>;
}
