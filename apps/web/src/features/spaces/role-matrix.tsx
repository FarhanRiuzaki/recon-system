import { Panel, ScrollFade } from "@starterkit/ui/ds";
import { ROLE_LABEL, SPACE_ACTION, SPACE_ROLES, type SpaceAction, type SpaceRole } from "@starterkit/shared/spaces";
import { DEFAULT_LEVELS } from "@starterkit/shared/workflows";

type Cell = "does" | "approves" | "views" | "none";
/**
 * A row's cells come from the role lists the API's space guards read (SPACE_ACTION): `does` and `approves` name one,
 * `approves: "chain"` is the default approval chain, `views` every member (the read guards are SPACE_ROLES), and
 * `covers` names a list the row's does + approves roles equal (role-matrix.test.ts checks it).
 */
type RowSpec = { action: string; does?: SpaceAction; approves?: SpaceAction | "chain"; views?: true; covers?: SpaceAction[] };
const CHAIN: readonly SpaceRole[] = [...new Set(DEFAULT_LEVELS.flatMap((l) => l.groups.flatMap((g) => g.spaceRoles)))];
const has = (list: readonly SpaceRole[] | undefined, r: SpaceRole) => !!list?.includes(r);
const row = (s: RowSpec) => ({
  ...s,
  cells: SPACE_ROLES.map((r): Cell => (has(s.does && SPACE_ACTION[s.does], r) ? "does"
    : has(s.approves === "chain" ? CHAIN : s.approves && SPACE_ACTION[s.approves], r) ? "approves" : s.views ? "views" : "none")),
});
const work = (action: string) => row({ action, does: "work" });

/**
 * What each space role may do. Read-only reference: the cells are the lists the API's space guards read
 * (SPACE_ACTION; apps/api/test/architecture/space-guards.test.ts), so the table can't disagree with the API.
 */
export const ROLE_MATRIX: readonly { group: string; rows: ReturnType<typeof row>[] }[] = [
  { group: "Daily work", rows: [
    row({ action: "View recons, today, unmatch items and operation result", views: true }),
    row({ action: "View postings and posting groups", views: true }),
    row({ action: "View a source's files, pulls and records", views: true }),
    row({ action: "View the dashboard of the spaces you are in", views: true }),
    row({ action: "See the sidebar counts", views: true }),
    row({ action: "See and download inbox files", does: "viewInbox" }),
    row({ action: "Upload a file to the inbox", does: "uploadInbox" }),
    work("Take an item and set its state"),
    row({ action: "Assign items to someone", does: "assign" }),
    row({ action: "Run a recon now", does: "runRecon" }),
    work("Match"), work("Request posting"), work("Force match"), work("Write-off"), work("Close without a match"), work("Undo match"),
    work("Work an item from Explain in operation result"),
    row({ action: "Approve requests", approves: "chain" }),
    row({ action: "Sign off a day", does: "signOff" }),
    row({ action: "See and download reports", does: "viewReports" }),
    row({ action: "Make a report for a date range", does: "generateReports" }),
    row({ action: "Download a report with full customer data", does: "downloadFullReports" }),
  ] },
  { group: "Setup", rows: [
    row({ action: "Set up recons", does: "editRecon", approves: "approveVersion" }),
    row({ action: "Run a simulation", does: "simulate" }),
    row({ action: "Preview a posting request", does: "previewPosting" }),
    row({ action: "Choose operation result columns", does: "resultColumns" }),
    row({ action: "Delete a recon", does: "deleteRecon" }),
    row({ action: "Set up sources", does: "editSource", approves: "approveVersion", covers: ["previewSource"] }),
    row({ action: "Connect a source and pull it", does: "connectSource" }),
    row({ action: "Manage inbox folders and delete files", does: "manageInbox" }),
    row({ action: "Set up workflows", does: "editWorkflows" }),
    row({ action: "Set up report templates", does: "editReports", approves: "approveVersion" }),
  ] },
  { group: "Space", rows: [row({ action: "Manage members", does: "manageMembers" }), row({ action: "Share a source with another space", does: "shareSource" })] },
];

// Tinted chips on *-soft / inset tokens (REC-D4), never opacity; "—" in fg-3 (5.35:1 on card), never fg-4.
const CHIP = "inline-flex h-5.5 items-center rounded-sm px-2 text-label text-fg";
function MatrixCell({ cell }: { cell: Cell }) {
  if (cell === "does") return <span className={`${CHIP} bg-inset`}>Does</span>;
  if (cell === "approves") return <span className={`${CHIP} border border-control-border bg-card`}>Approves</span>;
  if (cell === "views") return <span className="text-label text-fg-2">Views</span>;
  return <><span aria-hidden="true" className="text-fg-3">—</span><span className="sr-only">Not allowed</span></>;
}

const TITLE = "What each role can do";
const TH = "h-10 border-b border-line bg-tray px-3 text-label font-normal whitespace-nowrap text-fg-2";

// The Action column sticks to the card's left edge at every width while the role columns scroll (DataTable's sticky first column); opaque, with a hairline. The table is border-separate like ui/table: in a collapsed table the sticky cell's border stays on the grid and scrolls away.
// Below 1280 it is 160 px and wraps; from 1280 it is 18rem (M2: 288 + 7 × 108 px fits the 1440 content width, no
// sideways scroll there). Sticky is harmless where the table doesn't overflow.
const STICK = "sticky left-0 z-1 w-40 min-w-40 border-r border-line xl:w-72 xl:min-w-72";

/** Scrolls sideways inside its card when the card is narrower than the table (160 or 288 + 7 × 108 px wide); the Action column stays. */
export function RoleMatrix() {
  return (
    <Panel flush className="min-w-0" title={TITLE}>
      {/* Focusable, so a keyboard can scroll it where it is wider than the card (axe scrollable-region-focusable); relative,
          so the sr-only "Not allowed" spans (absolute) stay inside it instead of widening the page. */}
      <ScrollFade tabIndex={0} role="region" aria-label={TITLE} className="relative overflow-y-hidden outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-primary">
        <table aria-label={TITLE} className="w-full min-w-229 xl:min-w-261 border-separate border-spacing-0 text-body-sm">
          <thead>
            <tr>
              <th scope="col" className={`${TH} ${STICK} z-2 text-left`}>Action</th>
              {SPACE_ROLES.map((r) => <th key={r} scope="col" className={`${TH} w-27 text-center`}>{ROLE_LABEL[r]}</th>)}
            </tr>
          </thead>
          {ROLE_MATRIX.map((g) => (
            <tbody key={g.group}>
              <tr><th scope="rowgroup" className={`${STICK} h-9 border-b bg-card px-3 text-left eyebrow text-fg-3`}>{g.group}</th><td colSpan={SPACE_ROLES.length} className="border-b border-line" /></tr>
              {g.rows.map((r) => (
                <tr key={r.action}>
                  <th scope="row" className={`${STICK} h-10 border-b bg-card px-3 py-2 text-left font-normal text-fg xl:whitespace-nowrap`}>{r.action}</th>
                  {r.cells.map((c, i) => <td key={SPACE_ROLES[i]} className="h-10 border-b border-line px-2 text-center"><MatrixCell cell={c} /></td>)}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </ScrollFade>
      {/* the rules behind the cells, at body size under the table (audit 2: an 11 px footnote over 3 lines) */}
      <ul className="grid list-disc gap-1 border-t border-line px-4 py-3 pl-8 text-body-sm text-fg-2">
        <li>&ldquo;Does&rdquo; on an action with an approver means sending a request: nothing changes until someone else approves it.</li>
        <li>Each change&apos;s workflow names who approves it; without one, a Reviewer or a Space admin does.</li>
        <li>Source admin is granted and removed only by an app admin, not by a space admin.</li>
        <li>The approver can&apos;t be the preparer or anyone who resolved an item that day. Approving freezes the day.</li>
        {/* app roles (Roles screen) add to the space roles: the API lets these permissions in on the routes named */}
        <li>A Superadmin holds every role in every space.</li>
        <li>Open API: Integration view reads connectors and their call log, Integration debug also shows a call in full, Integration manage edits connectors.</li>
        <li>Workflows: Workflow view reads every space&apos;s workflows, Workflow manage edits them as a space admin does.</li>
        <li>Spaces: Space view lists every space and its members, Space manage creates spaces and manages any space&apos;s members.</li>
      </ul>
    </Panel>
  );
}
