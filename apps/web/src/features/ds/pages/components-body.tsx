"use client";

import {
  ActionCard, ActionMenu, Avatar, DropZone, FieldList, FormatExample, Inspector, InspectorSection, SwitchRow, ToggleChips, AvatarStack, BlockedButton, Breadcrumb, CategoryChip, Checkbox, ConfirmActionDialog, CountBadge, EmptyState, ErrorState, Field, PasswordChecks,
  EditorRow, Kbd, LiveCountBadge, Meter, NavigationPreview, PageZone, Panel, RouteTabs, SecretOnceDialog, Spec, StatusChip, StepItem, Stepper, TickMeter, type IndicatorStep,
} from "@starterkit/ui/ds";
import { HEALTH, type Health, toStatusTone } from "@starterkit/ui/lib/status";
import { Reveal } from "@starterkit/ui/motion";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { AddIcon, CloseIcon, EditIcon, ErrorIcon, ExportIcon, InfoIcon, RefreshIcon, RemoveIcon, UsersIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { PasswordInput } from "@starterkit/ui/ui/password-input";
import { Skeleton } from "@starterkit/ui/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@starterkit/ui/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@starterkit/ui/ui/tooltip";
import { useCallback, useState } from "react";
import { SortableList } from "@/components/sortable-list";
import { AffectGroup } from "../affect/gallery";
import { sample } from "../sample-toast";
import { useHashScroll } from "../use-hash-scroll";

/** Fixed, obviously fake sample for the one-time secret demo (the gallery has no backend). */
const SAMPLE_SECRET = "Sample-Pw-Not-Real-0000";
const HEALTHS = ["healthy", "progress", "degraded", "down", "stopped", "unknown"] as const satisfies readonly Health[];
const steps: IndicatorStep[] = [{ id: "team", label: "Team", status: "done" }, { id: "members", label: "Members", status: "current" }, { id: "review", label: "Review", status: "todo" }];

/** /ds/components below the header: the primitives with their two dialogs, the navigation samples, affectUI's actions. */
export function ComponentsSections() {
  useHashScroll();
  const [dialog, setDialog] = useState(false);
  const [secret, setSecret] = useState(false);
  const [tab, setTab] = useState("Profile");

  return (
    <>
      <div id="ds-primitives" className="grid scroll-mt-20 grid-cols-12 gap-gutter">
        {/* The page's h1 already says "Components": the block keeps its heading for the outline, not on screen. */}
        <h2 className="sr-only">Components</h2>
        <Panel title="Buttons and inputs" className="col-span-12 md:col-span-6">
          <div className="grid gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button>Save changes</Button><Button variant="secondary"><Icon icon={ExportIcon} />Export CSV</Button><Button variant="ghost">Clear filters</Button>
              <Button variant="destructive">Delete 2 users</Button><Button variant="secondary" disabled>Unlock</Button>
              <Button size="sm" variant="secondary">Compact 28</Button><Button size="icon" variant="secondary" aria-label="Refresh now"><Icon icon={RefreshIcon} /></Button>
              <Button variant="link">Forgot password?</Button>
            </div>
            {/* intents by verb (owner 24 Nov): Create / Add / New green (the page's main one solid), Edit blue, Delete /
                Remove red, whether a bin or an X; an X that closes stays ghost */}
            <div className="flex flex-wrap items-center gap-2" aria-label="Create, edit and remove intents" role="group">
              <Button variant="create-solid"><Icon icon={AddIcon} />Create recon</Button>
              <Button variant="create"><Icon icon={AddIcon} />Add a condition</Button>
              <Button variant="edit"><Icon icon={EditIcon} />Edit rule</Button>
              <Button variant="remove"><Icon icon={RemoveIcon} />Remove level</Button>
              <Button variant="remove" size="icon" aria-label="Remove condition 1"><Icon icon={RemoveIcon} /></Button>
              <Button variant="remove" size="icon" aria-label="Remove change 1"><Icon icon={CloseIcon} /></Button>
              <Button variant="ghost" size="icon" aria-label="Close panel"><Icon icon={CloseIcon} /></Button>
              {/* caution: a negative decision that changes data (Reject, Turn off, Cancel request), quieter than Danger */}
              <Button variant="caution"><Icon icon={ErrorIcon} />Reject request</Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5"><label htmlFor="ds-email" className="text-label text-fg-2">Email</label><Input id="ds-email" defaultValue="alex@example.com" /><span className="text-body-sm text-fg-3">Used to sign in and to reset the password.</span></div>
              <div className="grid gap-1.5"><label htmlFor="ds-otp" className="text-label text-fg-2">One-time code</label><Input id="ds-otp" defaultValue="12a4" aria-invalid="true" aria-describedby="ds-otp-e" /><span id="ds-otp-e" className="text-body-sm text-down-ink">Enter the 6-digit code from your authenticator app.</span></div>
              <Field id="ds-role" label="Role name" note="Field wires this note to the input for screen readers."><Input id="ds-role" defaultValue="Auditor" /></Field>
              <div className="grid gap-2">
                <Field id="ds-password" label="New password" note="Show password toggles the mask; a Caps Lock note appears while it is on."><PasswordInput id="ds-password" defaultValue="correct horse" autoComplete="off" aria-describedby="ds-password-checks" /></Field>
                <PasswordChecks id="ds-password-checks" checks={[{ label: "At least 12 characters", met: true }, { label: "The two passwords match", met: false }]} />
              </div>
              <Field id="ds-username" label="Username" note="Read-only: inset fill, still focusable and copyable."><Input id="ds-username" defaultValue="alex.rivers" readOnly className="font-mono" /></Field>
            </div>
          </div>
        </Panel>
        <Panel title="Chips, badges and tabs" className="col-span-12 md:col-span-6">
          <div className="grid gap-4">
            <div className="flex flex-wrap gap-2">{HEALTHS.map((h) => <StatusChip key={h} health={toStatusTone(h)} label={HEALTH[h].label} description={HEALTH[h].description} />)}<StatusChip health={toStatusTone("progress")} label="Starting" pending /></div>
            <div className="flex flex-wrap gap-2" data-status-static="">{HEALTHS.map((h) => <StatusChip key={h} health={toStatusTone(h)} label={HEALTH[h].label} strong />)}</div>
            <div className="flex flex-wrap items-center gap-2">
              <CategoryChip label="api" slot={1} /><CategoryChip label="web" slot={4} /><CategoryChip label="worker" slot={6} /><CategoryChip label="Simulated" slot="neutral" /><CountBadge>312</CountBadge>
            </div>
            <Tabs defaultValue="overview">
              <TabsList aria-label="Sample sections">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="sessions">Sessions <CountBadge>2</CountBadge></TabsTrigger>
                <TabsTrigger value="security">Security</TabsTrigger>
              </TabsList>
              <TabsContent value="overview" className="text-body-sm text-fg-3">Line tabs: the underline slides between tabs.</TabsContent>
              <TabsContent value="sessions" className="text-body-sm text-fg-3">Two active sessions.</TabsContent>
              <TabsContent value="security" className="text-body-sm text-fg-3">Two-factor authentication is on.</TabsContent>
            </Tabs>
          </div>
        </Panel>
        <Panel title="Meters, avatars and facts" className="col-span-12 md:col-span-6">
          <div className="grid gap-4">
            <Meter label="Load" ratio={0.52} value="52%" />
            <Meter label="Storage" ratio={0.86} value="17.2 GB / 20 GB" limitRatio={0.9} />
            <Meter label="Import" ratio={0.4} value="In progress" striped />
            <TickMeter label="Monthly quota" ratio={0.38} value="38%" ticks={40} threshold={0.8} />
            <div className="flex flex-wrap items-center gap-3">
              <Avatar name="Alex Rivers" size={32} /><Avatar name="Sam Hale" /><Avatar name="Robin Lund" size={24} />
              <AvatarStack names={["Alex Rivers", "Sam Hale", "Robin Lund", "Jamie Okafor", "Taylor Stone", "Morgan Quill"]} />
            </div>
            <Spec items={[{ label: "User", value: "alex.rivers" }, { label: "Sessions", value: "1 active" }, { label: "Role", value: "Admin" }]} />
          </div>
        </Panel>
        <RevealDemo />
        <DesignerBlocksSample />
        <Panel title="Empty and error" className="col-span-12 md:col-span-6" bodyClassName="grid gap-2 sm:grid-cols-2">
          <EmptyState icon={UsersIcon} title="No users yet" description="Users appear here after you create the first one." />
          <ErrorState title="Couldn't load metrics" cause="The metrics source isn't responding. Try again in a minute." lastGood={Date.UTC(2026, 9, 16, 7, 2)} onRetry={() => undefined} />
        </Panel>
        <Panel title="Menus, tooltips and dialogs" className="col-span-12 md:col-span-6">
          <div className="grid gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <ActionMenu label="Sample actions" actions={[{ id: "edit", label: "Edit user" }, { id: "delete", label: "Delete user", destructive: true }]} />
              <Tooltip>
                <TooltipTrigger asChild><Button variant="secondary"><Icon icon={InfoIcon} />Hover for a tooltip</Button></TooltipTrigger>
                <TooltipContent>Inverse tooltip: radius 10, 13 px text, at most 280 px wide.</TooltipContent>
              </Tooltip>
              <Button variant="remove" onClick={() => setDialog(true)}>Delete user</Button>
              <BlockedButton variant="secondary" reason="This is the last active Superadmin. Make another user Superadmin first.">Deactivate user</BlockedButton>
              <span className="inline-flex items-center"><Checkbox checked label="Checked sample" /><Checkbox checked="mixed" label="Mixed sample" /><Checkbox checked={false} label="Unchecked sample" /><Checkbox checked readOnly label="Read-only sample" /><Checkbox checked={false} reason="Your role doesn't hold this permission." label="Read-only with reason sample" /></span>
              <Button variant="secondary" onClick={() => setSecret(true)}>Show one-time secret</Button>
              <span className="inline-flex items-center gap-1.5 text-body-sm text-fg-3">Open the palette <Kbd keys={["⌘K"]} /></span>
            </div>
            <p className="text-body-sm text-fg-3">Dialog for risky actions: impact, a required reason and audit note, and the typed name.</p>
          </div>
        </Panel>
        {/* Page zones 40 px apart (gap-zone), panels 16 px apart inside one; actions as cards; editor rows on one grid */}
        <div className="col-span-12 grid gap-zone">
          <PageZone title="Act">
            <div className="grid gap-gutter md:grid-cols-3">
              <ActionCard title="Request posting" consequence="Sends the correcting entry to core banking once the approvers agree." meta="Two-level approval · Core banking" action={<Button onClick={sample}>Request posting</Button>} />
              <ActionCard title="Force match" consequence="Closes the item against the pair you pick, without a rule." action={<Button variant="secondary" onClick={sample}>Force match</Button>} />
              <ActionCard title="Write off" consequence="Closes the item and books the difference to the write-off account." meta="One approval" action={<BlockedButton variant="secondary" reason="Only a checker in this space can write off an item.">Write off</BlockedButton>} />
            </div>
          </PageZone>
          <PageZone title="Edit">
            <Panel title="Approval levels" tone="quiet">
              <div className="grid gap-3">
                <EditorRow lead={<span className="text-body-sm text-fg-2">Level 1</span>}><Input aria-label="Approvers of level 1" defaultValue="Config checker" /></EditorRow>
                <EditorRow lead={<span className="text-body-sm text-fg-2">Level 2</span>} trailing={<Button variant="remove" size="icon" aria-label="Remove level 2"><Icon icon={RemoveIcon} /></Button>}><Input aria-label="Approvers of level 2" defaultValue="Space admin" /></EditorRow>
              </div>
            </Panel>
            <SortableSample />
          </PageZone>
        </div>
      </div>

      <section id="ds-navigation" className="grid scroll-mt-20 gap-6" aria-label="Navigation patterns">
        <Panel title="Breadcrumb, route tabs and navigation tree" description="Grey fill marks the current route. Tree branches share the same curved connector as the app sidebar."><div className="grid gap-6"><Breadcrumb items={[{ id: "home", label: "Home", href: "#ds-navigation" }, { id: "settings", label: "Settings", href: "#ds-navigation" }, { id: "users", label: "Users", href: "#ds-navigation" }, { id: "detail", label: "Alex Morgan" }]} collapsed /><RouteTabs aria-label="Sample account tabs">{["Profile", "Security", "Sessions"].map(t => <a key={t} href="#ds-navigation" aria-current={t === tab ? "page" : undefined} onClick={e => { e.preventDefault(); setTab(t); }}>{t}</a>)}</RouteTabs><div className="w-full max-w-64"><p className="mb-2 px-2.5 text-label">Users</p><NavigationPreview items={[{ id: "all-users", label: "All users" }, { id: "active-users", label: "Active users" }, { id: "invited-users", label: "Invited users" }]} /></div><LiveCountSample /></div></Panel>
        <Panel title="Stepper layouts and states"><div className="grid gap-8"><Stepper steps={steps} label="Horizontal setup" /><div className="grid gap-6 md:grid-cols-2"><Stepper steps={steps} label="Vertical setup" layout="vertical" onStepSelect={sample} /><Stepper steps={steps} label="Compact setup" layout="compact" /></div><div className="grid gap-4 md:grid-cols-3">{(["todo", "current", "done", "error", "disabled"] as const).map((status, i) => <StepItem key={status} number={i + 1} step={{ id: status, label: status, status }} />)}<StepItem number={6} step={{ id: "optional", label: "Invite members", status: "todo", optional: true }} /></div></div></Panel>
      </section>

      <AffectGroup id="actions" />

      <ConfirmActionDialog open={dialog} onOpenChange={setDialog} title="Delete user alex.rivers?" description="The user can no longer sign in. Their activity log entries are kept." destructive
        impact={["1 active session ends", "The user is removed from every role"]} reasons={["Left the team", "Duplicate account", "Requested by the user"]}
        actionLabel="Delete user" confirmText="alex.rivers" onConfirm={async () => setDialog(false)} />
      {secret && (
        <SecretOnceDialog title="New password for Sam Hale" secret={SAMPLE_SECRET} label="new password" onClose={() => setSecret(false)}
          notes={["Shown once. Copy it now; the app doesn't store it and can't show it again.", "Give it to the user through a trusted channel, not email or chat."]} />
      )}
    </>
  );
}

const SAMPLE_COLUMNS = ["Reference", "Amount", "Value date", "Counterparty"];

/**
 * SortableList (`@/components/sortable-list`): every list ordered by hand. A row moves by its grip (drag, a long press
 * on touch) or, on the focused grip, Space, the arrow keys and Space again; Escape puts it back. Numbers follow.
 */
function SortableSample() {
  const [cols, setCols] = useState(SAMPLE_COLUMNS);
  return (
    <Panel title="Ordered list" tone="quiet" description="Drag a row by its grip, or focus the grip and press Space, then the arrow keys">
      <SortableList items={cols} getKey={(c) => c} noun="Column" label="Sample columns in order" className="gap-2" onReorder={setCols}
        itemClassName="flex items-center gap-2 rounded-md border border-line bg-card p-2"
        renderItem={(c, { index, handle }) => (
          <>
            {handle}
            <span className="min-w-0 flex-1 text-body-sm text-fg"><span className="mr-2 text-caption text-fg-3 tabular">{index + 1}</span>{c}</span>
            <Button variant="remove" size="icon" aria-label={`Remove ${c}`} disabled={cols.length === 1} onClick={() => setCols(cols.filter((x) => x !== c))}><Icon icon={RemoveIcon} /></Button>
          </>
        )} />
    </Panel>
  );
}

/** Loading → content crossfade: same box, no layout shift. "Reload" shows the skeleton for 1.2 s. */
function RevealDemo() {
  const [loading, setLoading] = useState(false);
  const reload = useCallback(() => { setLoading(true); setTimeout(() => setLoading(false), 1200); }, []);
  return (
    <Panel title="Loading → content crossfade" description="No layout shift" className="col-span-12 md:col-span-6"
      actions={<Button size="sm" variant="secondary" onClick={reload} disabled={loading}><Icon icon={RefreshIcon} />Reload</Button>}>
      <Reveal loading={loading} skeleton={<div className="grid gap-3"><Skeleton className="h-2.5 w-1/3" /><Skeleton className="h-7 w-1/2" /><Skeleton className="h-2.5 w-full" /><Skeleton className="h-2.5 w-2/3" /></div>}>
        <div className="grid gap-2">
          <span className="text-body-sm text-fg-2">Active sessions now</span>
          <span className="text-stat text-fg">3<span className="ml-1 text-body font-normal text-fg-3">of 24 users</span></span>
          <p className="text-body-sm text-fg-3">Alex Rivers, Sam Hale and Robin Lund are signed in.</p>
        </div>
      </Reveal>
    </Panel>
  );
}

/**
 * The sidebar's live counts (LiveCountBadge): neutral (Unmatch), progress (Approvals, waiting on you), down (Posting,
 * failed); "99+" past 99. Changing them pops each badge once while its number rolls; reduced motion fades.
 */
function LiveCountSample() {
  const [n, setN] = useState(0);
  const rows = [{ label: "Unmatch", value: 37 + n * 5, tone: "neutral" }, { label: "Approvals", value: 3 + n, tone: "progress" }, { label: "Posting", value: n % 2 ? 0 : 120, tone: "down" }] as const;
  return (
    <div className="grid w-full max-w-64 gap-2">
      <p className="px-2.5 text-label">Live counts</p>
      <div className="grid gap-0.5">
        {rows.map((r) => (
          <div key={r.label} className="flex h-8 items-center gap-2.5 rounded-md px-2.5 text-body-sm text-fg-2">
            <span className="min-w-0 flex-1 truncate">{r.label}</span>
            <LiveCountBadge value={r.value} tone={r.tone} format={(v) => (v > 99 ? "99+" : String(Math.round(v)))} />
          </div>
        ))}
      </div>
      <Button variant="secondary" size="sm" className="justify-self-start" onClick={() => setN((x) => x + 1)}>Change counts</Button>
    </div>
  );
}

/** The report designer's building blocks: the Data pane's field list, a drop zone, section chips, an inspector with a format example. */
function DesignerBlocksSample() {
  const [q, setQ] = useState("");
  const [on, setOn] = useState({ title: true, header: true, footer: false });
  const groups = [{ label: "Side A · KSEI file", fields: [{ ref: "a:ext_ref", label: "Reference", type: "text" as const, customer: false, used: true }, { ref: "a:account_ref", label: "Account", type: "text" as const, customer: true }, { ref: "a:amount_minor", label: "Amount", type: "number" as const, customer: false }] }];
  return (
    <Panel title="Report designer blocks" className="col-span-12 md:col-span-6" bodyClassName="grid gap-3 sm:grid-cols-2">
      <FieldList groups={groups} query={q} onQuery={setQ} onAdd={() => undefined} />
      <div className="grid content-start gap-3">
        <ToggleChips label="In the file" items={[{ key: "title", label: "Title", on: on.title }, { key: "header", label: "Header block", on: on.header }, { key: "footer", label: "Footer", on: on.footer }]}
          onToggle={(k) => setOn((x) => ({ ...x, [k]: !x[k] }))} />
        <DropZone active={false} label="Group by"><span>drag a field here</span></DropZone>
        <Inspector title="Column" meta="3 of 6"><InspectorSection title="Format"><FormatExample items={["(1.500)", "98.000.000"]} /><SwitchRow label="Page numbers" description="In a PDF only." checked={on.footer} onChange={() => setOn((x) => ({ ...x, footer: !x.footer }))} /></InspectorSection></Inspector>
      </div>
    </Panel>
  );
}
