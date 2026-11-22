# Copy Guide

Binding for every user-facing string in `apps/web` and `packages/ui`: labels, headings, buttons, tooltips, empty
states, errors, confirmations, aria-labels, CSV headers, page titles. All UI copy is English, written to a
professional enterprise standard.

## 1. Who we are writing for

- **Administrators** manage users, roles and permissions day to day. They scan, compare, act, and want exact
  numbers and next steps.
- **Everyone else** signs in, manages their own profile, password, two-factor method and sessions. They want plain
  outcomes, not internals.

Both are busy and competent. The app is an instrument panel, not a marketing site. Every word must earn its place.

## 2. Voice

| We are | We are not |
|---|---|
| Precise: "3 sessions active", "Quota 82% of 20 GB" | Vague: "Some activity", "Storage high" |
| Calm and factual, including when something is down | Alarmist ("Critical failure!"), cute ("Oops!"), apologetic ("Sorry") |
| Direct: imperative verbs, active voice | Passive or hedged ("It may be possible to…") |
| Consistent: one term per concept, everywhere | Synonym-hopping (session / connection / login) |
| Respectful of the reader's time: front-load the point | Preamble ("Please note that…", "In order to…") |

Tone shifts with the stakes, the voice does not. Routine: neutral. Degraded: specific and measured. Down or
destructive: short, explicit about impact, never dramatic.

## 3. Mechanics

- **Sentence case** everywhere: titles, buttons, tabs, column headers, menu items ("Export CSV", "Last sign-in").
  Proper nouns keep their case (Google, LDAP).
- **No terminal period** in labels, buttons, headers, chips, tooltips of one phrase. Use periods in full sentences
  (descriptions, empty-state bodies, errors).
- **Numerals always** ("3 sessions", not "three"). Units with a space: "20 GB", "350 ms", "2.4K tokens".
- **Dates/times**: `16 Oct 2026`, `14:05 WIB`, `16 Oct 2026, 14:05 WIB`; relative "3 min ago", "2 h ago",
  "Yesterday", always with the absolute time in a tooltip. Under 1 minute (and future timestamps from clock skew)
  → "Just now". Relative phrases are standalone strings; never splice them mid-sentence. Ranges with an en dash: "1–25 of 312".
- **Contractions** allowed in body text ("can't", "isn't"); avoid them in labels and buttons.
- **"You"** sparingly, never "we"/"our" for the system. The app is not a character. Prefer the object as the subject:
  "The session ended", not "We ended your session".
- **American spelling** (authorization, canceled, color, behavior).
- **No exclamation marks, no emoji, no ALL CAPS** in source strings (except acronyms). The `eyebrow` overline style may render uppercase via CSS; its source text stays sentence case.
- **Placeholders** show format, never act as labels: label "Search", placeholder "Name or email".

## 4. Patterns

**Page title + description.** Title is a noun ("Users", "Roles", "Activity log"). Description is one sentence stating
scope and freshness: "Every user account, with status and last sign-in."

**Buttons.** Verb + object, specific: "Create user", "Export CSV", "Revoke 2 sessions", "Load more".
Never "OK", "Yes", "Submit", "Click here". The primary action names its result.

**Confirmations.** Title asks with the action + target; body states impact; buttons repeat the verb.
> **Revoke 2 sessions for Rina Wulandari?**
> She is signed out on those devices immediately. Her account stays active.
> [Cancel] [Revoke sessions]

Never "Are you sure?".

Destructive actions on a named account ask for the name typed exactly (`Type rina to continue`); a generated secret
(password, recovery code) shows once in a dialog titled `New password for <name>` with a Copy button and "Close and clear".

**Errors.** What happened + why (if known) + what to do. No blame, no codes as the headline (codes go in detail).
> **Couldn't load users**
> The server didn't respond within 5 s. Try again in a minute.
> [Try again]

Field errors sit under the field and say how to fix: "Enter the 6-digit code from your authenticator app."
Never clear the user's input on error.

**Empty states.** Say why it's empty and when data will appear; offer the next step if there is one.
> **No sign-ins in the last 24 hours**
> Sign-ins appear here when a user signs in. Try a longer time range.

Filtered-empty is different from truly empty: "No users match "status:inactive"." + [Clear filters].

**Loading.** Skeletons, not words. Where text is needed: "Loading sessions…" (with ellipsis character).

**Stale / partial data.** State age and source plainly: "Showing data from 14:02 WIB. The activity feed isn't
responding; values may be out of date."

**Disabled actions.** Always explain why, in a tooltip, menu label, or helper text: "The activity log
isn't responding, so changes are off until it returns." / "The account isn't locked."

**Numbers and status in sentences.** Lead with the number: "4 of 6 users active", "12 sign-ins failed today".

**KPI tiles.** The label names the metric only: "Users", "Sign-ins", "Failed sign-ins".
The period and the comparison go in the caption under the value, number first in the pill:
> **Sign-ins** 12,840 [↑ +15%] — Last 7 days · vs previous 7 days

Today-counters say when "today" starts: "Today, since 00:00 WIB"; a detail tile may add one fact: "Today · 945
sign-ins". A tile without a comparison still states its period ("Last 24 hours"); "Same as 7 days ago" when nothing changed.

**Chart and panel descriptions.** Period, then granularity, after the title's middot: "Last 24 hours · per hour,
WIB", "Last 7 days · per day, WIB", "Last 30 days". Rankings say their size: "Top 10", "By sign-ins". The
summary under a ranking: "Top 5 total", "Share of all sign-ins", "Share of all failures".

**Bytes.** Table cells "16.4 GB / 20 GB"; tiles and prose "19 GB of 20 GB · 95%"; cards "95% of 20 GB". Always GB
(base 1024 via `formatBytes`), never GiB.

**Tooltips & status descriptions.** One sentence, present tense, states meaning + threshold + what to do when relevant:
> **Degraded** — Running, but a resource is above its warning threshold or a check is failing. Review the reason
> on the card.

State the real thresholds from `packages/ui/src/lib/status.ts` (the glossary is the single source); never copy
numbers from examples.

**Source wizard and versions** (Figma page 02, Build notes 02; `apps/web/src/features/sources/`). Steps: "Connection",
"Fields and mapping", "Review and submit"; Next reads "Next: fields and mapping", "Next: review", "Submit for approval".
- Step 1 (Figma 02 v1.0.5) runs in stages: Server → Sign in → **Connect** → Data (database and table). The stage's
  action is "Connect" (a file inbox: "Check folder"); Enter runs it. While it runs: "Connecting…". After it passes,
  Server and Sign in fold into one line with "Change server": "PostgreSQL 18.6 · recon_ro@db.bank.local:5432 ·
  TLS on". A file inbox's answer is one line naming the pattern: "Folder readable · 3 files match act*.txt" (no
  separate "1 file matches." note).
- A failed connect is an error on the field that caused it, one fact and one step, naming what was typed (never the
  password; for a stored connection never its values) — `apps/api/src/modules/sources/rules.ts` `testFailure`:
  Password: "Password rejected for {user}." · Host: "Can't reach {host}:{port} in 8 s." / "Can't reach
  {host}:{port}. Check the host and port." · TLS: "This server doesn't offer TLS. Ask IT to turn it on for the
  server." / "The server's certificate isn't trusted by this install. Ask IT to add your bank's CA." · Database:
  "Database {name} wasn't found. Check the name." (Oracle: "Service …"). Focus moves to that field. "Can't reach"
  only when the host really didn't answer; a failure on the app's side never blames the typed host.
- TLS starts on, off only for a local host (localhost, 127.0.0.1, host.docker.internal). Turning it off for any other
  host asks first: title "Turn off TLS for {host}?", body "The password and the data travel unencrypted. This is
  recorded in the activity log.", actions "Turn off TLS" (danger) · "Keep TLS"; closing it returns focus to the switch.
- Next on Connection is blocked until the connection passes for the values on screen; after a change: "The connection
  changed since you connected. Connect again." (a file inbox: "The folder changed since the last check. Check it
  again."); a picker list that is out of date: "The connection changed. Connect again to refresh this list." A folder
  outside the inbox roots, on the Folder field: "Use a folder inside the inbox folders this install allows." (never an
  environment variable's name). Never add "Nothing was saved": the source is saved at Next.
- Username hint: "Use a read-only account."
  A stored credential field: "Stored. Enter a new value to replace it." (never the value).
- A watermark or id column that allows NULL is offered disabled with "can be empty" after its name; SQL Server float and real: "SQL Server sends float and real in scientific notation (1.5E+2).
  Keep it as text, or cast it to decimal in a custom SELECT."
- A field the API refuses is named on the field: the API's "Check <field>: <reason>" shows its reason under that
  control.
- Version page, Approve and Reject (designer's final copy, 20 Nov 2026), buttons "Approve version {n}" and "Reject",
  the reason as the BlockedButton's description: "You submitted this version. Another config checker approves it." /
  "You worked on this version. A config checker who didn't work on it approves it." / "Only a config checker of this
  space approves source versions." / "This version is no longer waiting for approval." Reject uses the same sentences
  with "rejects" / "rejects source versions". A reject without a comment: "Enter a comment to reject: say what the
  maker should change."
- Version states: Draft, Sent back, In review (neutral), Published (healthy), Retired (stopped). A sent-back version's
  subtitle: "Draft · sent back by a config checker · version {n} stays published" (the last part only when one is
  published), the comment in a Notice ("Sent back by a config checker: {comment}"), the page action "Edit version
  {n}"; the Versions tab adds "Sent back by {name}". The decision panel is on a version in review only; anyone who
  may not decide sees one line ("A config checker other than you approves or rejects this version.") and the blocked
  Approve.
- Activity tab: one sentence per event, never a hash or a raw before/after: "{name} created the source.", "{name} set
  the connection." / "{name} replaced the connection.", "{name} started version {n} from version {m}.", "{name}
  edited version {n}.", "{name} submitted version {n}.", "{name} approved version {n}; version {m} retired.", "{name}
  sent version {n} back: “{comment}”", "{name} shared the source with {space}.".
- Delete a draft source (a source admin's, for a source never submitted or shared): action "Delete draft source";
  dialog title "Delete this draft source?", body "{name} was never submitted, so nothing was pulled or ingested. Its
  connection and draft settings are removed. This can't be undone.", confirm "Delete draft source"; toast "Deleted the
  draft source {name}."
- The connection panel's option reads "Connect timeout for scheduled pulls"; a test always waits 8 s at most.
- A count of changes: "1 change", "3 changes".
- Stored as: a checkbox "{column} is stored" and the stored name, the column's own name to start; a bad name:
  "Use a-z, 0-9 and _, starting with a letter, up to 63 characters."; a taken one: "Another column is stored as
  {name}. Use a different name." A sent-back Notice names the checker: "Sent back by {name}: {comment}". A database
  preview says "Quarantined rows don't stop the pull." ("… the file." for a file).
- "New source" for anyone but a source admin: "Only a source admin of this space adds sources."; "Edit source" for
  anyone but a source admin or config maker: "Only a source admin or a config maker of this space changes a source."

- Help text (an ⓘ beside a field label or a table header; owner, 21 Nov: short, plain, like a professional product):
  one or two sentences, at most about 30 words. First what the thing is, in the reader's terms; then what it changes
  or what happens when it is off ("A row whose value doesn't fit goes to quarantine with the reason."). One concrete
  example when it helps ("such as yyyy-MM-dd"). No "This column…", no "Here you can…", no marketing words, no
  internal names (CEL, row_hash, attrs). Example: Stored as: "The name the value is kept under with each record, so
  recons can match and filter on it. Untick to leave the column out."

## 5. Glossary (use exactly these terms)

| Use | Not | Notes |
|---|---|---|
| user | member, account holder, person | A person with an account. "Account" only for the signed-in user's own ("Your account") |
| role | group, profile, level | A named set of permissions |
| permission | right, privilege, access | One capability, named `<resource>.<action>` (`user.view`, `role.edit`) |
| session | connection, login | One signed-in browser or device |
| match / unmatch | break, exception, open item | A recon's item is Match (paired) or Unmatch (not yet paired: data still moving, checked again by its carry over). The queue and nav are "Unmatch"; one row is an "item" or "unmatch item" (owner, 22 Nov) |
| undo match | unmatch (for the action), reverse | Undoing a matched pair; rare |
| request posting | post, book | An unmatch sent through the posting workflow to the bank; closes as Posted |
| activity log | history, audit trail | Who changed what: every create, edit and delete |
| sign-in log | login history, access log | Every sign-in attempt and its result |
| sign in / sign out | log in, log out, login (verb) | "Sign-in" as noun/adjective: "Last sign-in", "Sign-in log" |
| one-time code | OTP, token (in UI copy) | Field label "One-time code"; "OTP" only in technical detail |
| two-factor authentication | 2FA, MFA (in headings) | "2FA" is fine in a tight label |
| recovery code | backup code | Shown once; never display it again |
| active / inactive | enabled / disabled, on / off | A user's state; an inactive user can't sign in |
| Healthy / Degraded / Down / Stopped / Unknown | OK, Warning, Error, Offline, N/A | The five health states |
| Dashboard, Today, Unmatch, Approvals, Posting, Recons, Sources, Members, Workflows, Users, Roles, Permissions, Open API, Activity log, Sign-in log, Profile (Projects and Design system are not listed in the navigation; their routes work) | Home, Admin, History, Account | The navigation labels: a new module adds its own (a plural noun, sentence case) to this row. Sessions live at /me/sessions and on a user's detail page, not in the nav. An item of a later release is shown disabled with a "Soon" tag; one caption per group under its label, built from the group's soon items ("Exports arrives in a later release." for one, "Exports and Reports arrive in a later release." for two); none is soon now. Today, Unmatch, Approvals and Posting open the current space's page. Recons, Sources and Workflows, like Members, open the current space's page (/recons → /spaces/<id>/recons, /sources → /spaces/<id>/sources); the 64 px rail shows a dot on the icon and the tooltip "Arrives in a later release." (on hover, focus and press) |
| Overview, Foundations, Components, Forms, Feedback, Data display, Illustrations, Motion | | The submenu labels under Design system, one per page; each is also its page's title, except Overview, whose page title is "Design system" |

## 6. Words to avoid

Sorry, oops, please (except in rare requests to wait), simply, just (except the fixed phrase "Just now"), easily, successfully (say what happened),
utilize (use), in order to (to), at this time (now), unable to (can't), invalid (say what's wrong),
error occurred (say what failed), N/A (use the en dash "–" for a missing value, with a tooltip when the reason is known, or "Not available").

## 7. Review checklist

1. Can a busy admin act on it in one read?
2. Is every term from the glossary, and is it used consistently?
3. Sentence case, no stray periods, no exclamation marks?
4. Does every error say what, why, and what next? Does every empty state say when data appears?
5. Does every status chip and disabled control explain itself?
6. Are numbers, units, dates, and times in the house format?
7. Would this read well in front of the team that owns the product?
