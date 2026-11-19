import { Panel } from "@starterkit/ui/ds";
import { ROLE_LABEL, SPACE_ROLES } from "@starterkit/shared/spaces";

type Cell = "does" | "approves" | "views" | "none";
const CODE: Record<string, Cell> = { D: "does", A: "approves", V: "views", "-": "none" };
/** One letter per role in SPACE_ROLES order (D does, A approves, V views, - not allowed). */
const row = (action: string, cells: string) => ({ action, cells: [...cells].map((c) => CODE[c]!) });

/**
 * What each space role may do: Figma "01 Space & shell" › RoleMatrix (7 roles × 16 actions), recon spec §11, §11b.
 * Read-only reference; the rules themselves live in the API.
 */
export const ROLE_MATRIX: readonly { group: string; rows: { action: string; cells: Cell[] }[] }[] = [
  { group: "Daily work", rows: [
    row("View recons, live day, breaks and explanations", "V-VVVVV"),
    row("Export CSV (summary, breaks, filtered results)", "D-DDDDD"),
    row("Assign, comment and set a reason on breaks", "----D--"),
    row("Manual match within tolerance", "----D--"),
    row("Force match outside tolerance", "----DA-"),
    row("Unmatch a group", "----DA-"),
    row("Write off, within the reviewer limit", "----DA-"),
    row("Write off, above the reviewer limit", "A---D--"),
    row("Prepare a day for sign-off", "-----D-"),
    row("Approve a day's sign-off", "A----A-"),
    row("Reopen a signed-off day", "A----D-"),
  ] },
  { group: "Configuration", rows: [
    row("Edit a config draft and run simulations", "--D----"),
    row("Publish a config version", "--DA---"),
    row("Declare source fields and mapping (source version)", "-DDA---"),
    row("Set up a source connection and credentials", "-D-----"),
  ] },
  { group: "Space", rows: [row("Add and remove members, change their roles", "D------")] },
];

// Tinted chips on *-soft / inset tokens (REC-D4), never opacity; "—" in fg-3 (5.35:1 on card), never fg-4.
const CHIP = "inline-flex h-5.5 items-center rounded-sm px-2 text-label text-fg";
function MatrixCell({ cell }: { cell: Cell }) {
  if (cell === "does") return <span className={`${CHIP} bg-inset`}>Does</span>;
  if (cell === "approves") return <span className={`${CHIP} bg-primary-soft`}>Approves</span>;
  if (cell === "views") return <span className="text-label text-fg-2">Views</span>;
  return <><span aria-hidden="true" className="text-fg-3">—</span><span className="sr-only">Not allowed</span></>;
}

const TITLE = "What each role can do";
const TH = "h-10 border-b border-line bg-tray px-3 text-label font-normal whitespace-nowrap text-fg-2";

// The Action column sticks to the card's left edge at every width while the role columns scroll (DataTable's sticky first column); opaque, with a hairline. The table is border-separate like ui/table: in a collapsed table the sticky cell's border stays on the grid and scrolls away.
// Below 1280 it is 160 px and wraps; from 1280 it is 340 px on one line (Figma 4:83). Sticky is harmless where the table doesn't overflow.
const STICK = "sticky left-0 z-1 w-40 min-w-40 border-r border-line xl:w-85 xl:min-w-85";

/** Scrolls sideways inside its card when the card is narrower than the table (160 + 7 × 108 px wide); the Action column stays. */
export function RoleMatrix() {
  return (
    <Panel flush className="min-w-0" title={TITLE} footnote={<>
      &ldquo;Does&rdquo; on an action with an approver means sending a request: nothing changes until someone else approves it.
      Source admin is granted and removed only by an app admin, not by a space admin.
      The approver can&apos;t be the preparer or anyone who resolved an item that day. Approving freezes the day.
    </>}>
      {/* Focusable, so a keyboard can scroll it where it is wider than the card (axe scrollable-region-focusable); relative,
          so the sr-only "Not allowed" spans (absolute) stay inside it instead of widening the page. */}
      <div tabIndex={0} role="region" aria-label={TITLE} className="scroll-quiet relative overflow-x-auto outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-primary">
        <table aria-label={TITLE} className="w-full min-w-229 xl:min-w-274 border-separate border-spacing-0 text-body-sm">
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
      </div>
    </Panel>
  );
}
