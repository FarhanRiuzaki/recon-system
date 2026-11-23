import { Panel, ScrollFade } from "@starterkit/ui/ds";
import { ROLE_LABEL, SPACE_ROLES } from "@starterkit/shared/spaces";

type Cell = "does" | "approves" | "views" | "none";
const CODE: Record<string, Cell> = { D: "does", A: "approves", V: "views", "-": "none" };
/** One letter per role in SPACE_ROLES order (D does, A approves, V views, - not allowed). */
const row = (action: string, cells: string) => ({ action, cells: [...cells].map((c) => CODE[c]!) });

/**
 * What each space role may do, as the API's space guards allow it today (engine, approvals, recon, sources and spaces
 * controllers; audit M2). Read-only reference; the rules themselves live in the API.
 */
export const ROLE_MATRIX: readonly { group: string; rows: { action: string; cells: Cell[] }[] }[] = [
  { group: "Daily work", rows: [
    row("View recons, today and unmatch items", "VVVVVVV"),
    row("Take an item and set its state", "D---DD-"),
    row("Assign items to someone", "D----D-"),
    row("Run a recon now", "D-D-D--"),
    row("Match", "D---DD-"),
    row("Request posting", "D---DD-"),
    row("Force match", "D---DD-"),
    row("Write-off", "D---DD-"),
    row("Close without a match", "D---DD-"),
    row("Undo match", "D---DD-"),
    row("Approve requests", "A----A-"),
    row("Sign off a day", "D----D-"),
  ] },
  { group: "Setup", rows: [
    row("Set up recons", "--DA---"),
    row("Set up sources", "-DDA---"),
    row("Connect a source and pull it", "-D-----"),
    row("Set up workflows", "D------"),
  ] },
  { group: "Space", rows: [row("Manage members", "D------"), row("Share a source with another space", "D------")] },
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
      </ul>
    </Panel>
  );
}
