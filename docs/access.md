# Access

Who may do what in an instance: roles, members' access per area and project, and how the API checks it. Decided with the user on 18 November 2026. Code: `apps/api/src/access/`, `apps/web/src/lib/access.ts`.

It is built in two parts:

| Part                                                         | Status |
| ------------------------------------------------------------ | ------ |
| A. Roles, grants, the one check, the dashboard hiding        | Built  |
| B. Members page, invitations, reset links, owner setup pages | Built  |
| C. Account email, with SMTP set up                           | Built  |

## Roles

Each dashboard user has one role (`dashboard_users.role`):

- **Owner.** Exactly one per instance; a partial unique index allows no second. The owner can do everything: the instance's settings (name, timezone, and automatic location data updates, with the location data's status), scheduled backups and the backup key, the Server log, handing ownership to another user, and everything an admin can do, including to admins.
- **Admin.** Everything except the instance's settings and anything that touches the owner:
  - every project and area;
  - creating, changing, and deleting projects;
  - project keys and settings (allowed sites, retention, replay mode, blocked addresses and referrers, and the rest), and deleting spam visits;
  - notification channels;
  - the Members page: inviting members, changing a member's access, removing a member, and making a member's reset link.

  Only the owner invites, promotes, demotes, removes, or resets admins.

- **Member.** Only what they have been granted.

## A member's access

A member's access has two parts (`dashboard_member_access`, `dashboard_member_projects`):

- **Projects:** all of them, including projects created later, or a chosen list. A project deleted from the instance leaves the list with it.
- **Areas:** each none, view, or manage. An area with nothing to change takes only none or view; a check constraint refuses manage for it.

| Area                | Pages                                                                 | View                        | Manage                                                                           |
| ------------------- | --------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------- |
| `web_analytics`     | Analytics, Speed, Heatmaps                                            | All three pages             | (none)                                                                           |
| `product_analytics` | Events, Funnel, Retention, and the goals on the Analytics page        | Every report, saved funnels | Saving, renaming, and deleting funnels; adding and deleting goals                |
| `errors`            | Errors, an error's page                                               | Groups, occurrences, stacks | Resolving and reopening; assigning; deleting source maps                         |
| `replays`           | Replays, a replay's page, the player, the replay in an error's dialog | Every replay                | (none)                                                                           |
| `users`             | Users, a user's page (identified end users and their activity)        | Both pages                  | (none)                                                                           |
| `monitoring`        | Traces, Logs, Metrics, Services, Databases, Hosts                     | Every page                  | (none)                                                                           |
| `ai`                | AI, AI calls, a call's and a conversation's pages                     | Every page                  | (none)                                                                           |
| `uptime_alerts`     | Uptime, Alerts                                                        | Checks, rules, alerts       | Creating, changing, and deleting checks and alert rules; choosing their channels |

Replays and users are areas of their own because they show individual people.

AI is apart from monitoring so that someone can see AI costs without monitoring (migration 0022 gave each member and pending invitation AI at their monitoring level). The AI area shows AI calls, including the calling service's name, the release, and the trace and span IDs as text. Traces, logs, metrics, and the other services need monitoring, and so does a call's link to its trace. AI model prices are instance settings (`projects`), not part of the area.

Monitoring shows span and log attributes as servers sent them, but never AI prompts or completions: the API drops them when it receives them ([telemetry](telemetry.md#ai-prompts-and-completions-are-not-stored)).

Members never see project keys, project settings, notification channels (beyond their names, for choosing a rule's), the Members page, or the instance's settings.

### Presets

The Members page fills in the areas from a preset, which can then be changed:

| Preset      | Areas                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| Viewer      | View on everything except replays and users                                                           |
| Engineering | Manage errors and uptime and alerts; view monitoring, AI, and replays; view web and product analytics |
| Marketing   | View web analytics; manage product analytics; nothing else                                            |
| Custom      | Any other mix                                                                                         |

`PRESETS` in `apps/api/src/access/areas.ts` holds the first three.

## How the API checks it

All in one place, `apps/api/src/access/access.ts`:

- Every route on a project runs `requireProjectAccess(db, need)`. `need` is an area and a level (`{ area: "errors", level: "manage" }`), the "projects" permission (the project's keys, settings, and deletion), or only the project itself (its name).
- Every other dashboard route runs `requirePermission(db, permission)`: `settings` and `ownership` (the owner), `members`, `channels`, or `projects` (the owner and admins), or `signed_in` for routes that show each user only what they may reach (`GET /api/me`, `GET /api/projects`, the notifications inbox) or change only their own account (`/api/account…`) or stars (`/api/starred-projects…`).
- The heatmap overlay's read (`GET /api/heatmap-overlay/:projectId/heatmap`), called from the customer's own site, has no cookie: it runs `requireOverlayAccess(db, need)`, which takes an overlay session token as `Authorization: Bearer` and then decides as `requireProjectAccess` does, through the same function (`checkProjectAccess`), for the user the token names ([Heatmap overlay tokens](#heatmap-overlay-tokens)).
- All three read the user's role and grants from PostgreSQL on every request, so a change applies on the next click. Deleting a user deletes their sessions with them (a foreign key), which signs them out at once.
- A project the member is not granted answers exactly as a project that does not exist: 404 with `{ "error": "not_found", "message": "No project has this ID." }`. A member cannot tell the two apart.
- A granted project without the area or level answers 403 with `{ "error": "forbidden", "message": "You don't have access to this. Ask the instance's owner or an admin if you need it." }`. So does an instance route without the permission.
- Not signed in answers 401, as before.

Fastify checks a route's parameters and body before the access check runs, so a malformed request answers 400 even where access would be refused. A 400 says nothing about the project.

### Each route's need

| Route                                                                                                                                                                                                          | Needs                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `GET /api/me`, `GET /api/projects`                                                                                                                                                                             | Signed in                           |
| `PATCH /api/account`, `POST /api/account/email`, `POST /api/account/password` (the user's own account)                                                                                                         | Signed in                           |
| `GET`, `DELETE /api/account/sessions`, `DELETE /api/account/sessions/:id` (the user's own sessions)                                                                                                            | Signed in                           |
| `GET /api/starred-projects`, `PUT`, `DELETE /api/starred-projects/:projectId` (the user's own stars; `PUT` also checks the project, as below)                                                                  | Signed in                           |
| `GET /api/notifications`, `GET …/unread-count`, `PATCH …/:notificationId`, `POST …/read-all` (the user's own inbox, [below](#notifications))                                                                   | Signed in                           |
| `PUT`, `DELETE /api/account/avatar` (the user's own avatar, [below](#avatars))                                                                                                                                 | Signed in                           |
| `GET /api/avatars/instance/:file`, `…/users/:userId/:file`, `…/projects/:projectId/:file` (a project's also checks the project, [below](#avatars))                                                             | Signed in                           |
| `PUT`, `DELETE /api/settings/avatar` (the instance's icon)                                                                                                                                                     | `settings` (the owner)              |
| `GET`, `PATCH /api/settings`, `GET /api/settings/location-data`                                                                                                                                                | `settings` (the owner)              |
| `/api/members…`, `/api/invitations…` (seven routes)                                                                                                                                                            | `members`                           |
| `POST /api/members/:userId/ownership`                                                                                                                                                                          | `ownership` (the owner)             |
| `POST /api/projects`, `GET /api/client-address` (the requester's own address, for blocked addresses)                                                                                                           | `projects`                          |
| `GET /api/settings/storage` (what fills the disk, and the storage warnings)                                                                                                                                    | `projects`                          |
| `PATCH /api/settings/storage` (the channels that get storage warnings)                                                                                                                                         | `channels`                          |
| `GET /api/settings/ai-models`, `PUT …/price`, `PUT …/price-as`, `POST …/reset` (the AI model prices)                                                                                                           | `projects`                          |
| `/api/settings/backups…` (ten routes: settings, Test connection, Back up now, Test restore, the list, the key, its file, saved, replace)                                                                       | `settings` (the owner)              |
| `GET /api/settings/server-log` (the Server log's stream, [dashboard](dashboard.md#server-log))                                                                                                                 | `settings` (the owner)              |
| `POST /api/settings/backups/key`, `…/key/file`, and a `PATCH` that turns backups off                                                                                                                           | `settings` and the current password |
| `/api/channels…` (all eight), `POST /api/channels/email-test` (a test email to the user's own address)                                                                                                         | `channels`                          |
| `GET /api/projects/:id`                                                                                                                                                                                        | The project                         |
| `PATCH`, `DELETE /api/projects/:id`, `POST …/public-key`, `POST …/secret-key`, `DELETE …/replays`, `POST …/spam-visits/preview`, `POST …/spam-visits/delete`, `GET …/ingest-activity`                          | `projects`                          |
| `PUT`, `DELETE /api/projects/:id/avatar` (the project's icon)                                                                                                                                                  | `projects`                          |
| `…/analytics`, `…/analytics/list`, `…/speed`, `…/heatmaps`, `…/heatmaps/pages`, `POST …/heatmaps/overlay-link`, `…/heatmaps/snapshots`, `…/heatmaps/snapshots/:device` (`DELETE` too), `…/player`, `…/heatmap` | `web_analytics` view                |
| `GET /api/heatmap-overlay/:projectId/heatmap`, `POST …/snapshot` (an overlay session token, no cookie)                                                                                                         | `web_analytics` view                |
| `…/events`, `…/events/:name`, `…/funnel`, `…/retention`, `GET …/goals`, `GET …/funnels`                                                                                                                        | `product_analytics` view            |
| `POST`, `DELETE …/goals`, `POST`, `PUT`, `DELETE …/funnels`                                                                                                                                                    | `product_analytics` manage          |
| `GET …/errors`, `GET …/errors/:fingerprint`, `GET …/source-maps`, `…/source-maps/files`                                                                                                                        | `errors` view                       |
| `PATCH …/errors/:fingerprint`, `PUT …/errors/:fingerprint/assignee`, `GET …/error-assignees`, `DELETE …/source-maps`                                                                                           | `errors` manage                     |
| `GET …/replays`, `…/replays/list`, `…/replays/:replayId`, `…/timeline`, `…/player`                                                                                                                             | `replays` view                      |
| `…/users`, `…/users/:userId`                                                                                                                                                                                   | `users` view                        |
| `…/traces…`, `…/logs…`, `…/metrics…`, `…/services…`, `…/databases…`, `…/hosts…`                                                                                                                                | `monitoring` view                   |
| `…/ai`, `…/ai/chart`, `…/ai/calls` (the AI page, [AI usage](ai-usage.md#the-report))                                                                                                                           | `ai` view                           |
| `…/ai/call-list`, `…/ai/calls/:callId`, `…/ai/conversations…` (the AI calls list, [AI usage](ai-usage.md#the-calls-list)); a call's user and the `user` filter also need `users` view                          | `ai` view                           |
| `GET …/checks…`, `GET …/alert-rules…`, `…/alerts`, `…/alerts/firing`, `…/alert-channels`                                                                                                                       | `uptime_alerts` view                |
| `POST`, `PATCH`, `DELETE …/checks…` and `…/alert-rules…`                                                                                                                                                       | `uptime_alerts` manage              |
| `GET`, `PUT`, `DELETE …/overview/layout` (the user's own layout)                                                                                                                                               | The project                         |
| `…/overview/attention`, `…/overview/uptime`                                                                                                                                                                    | `uptime_alerts` view                |
| `…/overview/errors`                                                                                                                                                                                            | `errors` view                       |
| `…/overview/services`                                                                                                                                                                                          | `monitoring` view                   |
| `…/overview/ai-cost`                                                                                                                                                                                           | `ai` view                           |
| `…/overview/speed`, `…/overview/traffic`, `…/overview/sources`                                                                                                                                                 | `web_analytics` view                |
| `…/overview/main-goal`, `…/overview/goals`, `…/overview/users`                                                                                                                                                 | `product_analytics` view            |

`GET /api/projects/:id/alert-channels` lists the instance's channels by ID, name, and kind only, for the rule form. A rule may name any of the instance's channels.

### Alert rules and the areas they watch

A rule shows what it watches: an error rule shows error groups and messages, a telemetry rule services, routes, and metrics, an AI rule models and features. So each kind also needs the area it watches, at view (`sourceAreaOf` in `apps/api/src/alerts/kinds.ts`):

| Kinds                                                 | Also needs        |
| ----------------------------------------------------- | ----------------- |
| `check_down`, `certificate_expiring`                  | Nothing more      |
| `error_new`, `error_regressed`, `error_spike`         | `errors` view     |
| `route_latency`, `route_failures`, `metric_threshold` | `monitoring` view |
| `ai_cost`, `ai_failures`, `ai_latency`                | `ai` view         |

- Creating a rule, or changing one to another kind, of a kind the user may not see answers 403.
- The rule list, the alerts, and the firing alerts hold only the kinds the user may see. An alert counts by the kind its rule had when it fired (`alert_history.kind`, migration 0021), since a rule can change kind and keep its history: an error rule changed into a check rule does not show its error alerts, nor when it last fired (`lastFiredAt`), to a user with uptime and alerts only. A rule of another kind answers as a missing rule (404 `rule_not_found`) to reading it, its history, changing it, and deleting it.
- The warning that a telemetry rule's service, route, or metric has not reported goes only to users with monitoring at view, and an AI rule's (no AI call arrived) only to users with AI at view. It tells whether they exist.
- The rule form offers only the kinds the user may add, and a link that opens it for another kind does not open it.

Some answers show less to a user without another area:

- `GET /api/projects` and `GET /api/projects/:id` answer only the ID, name, creation time, and last event to users without the `projects` permission: no keys and no settings, among them the blocked addresses and blocked referrers ([web analytics](web-analytics.md#blocked-addresses)). The list holds only the projects the user may reach.
- The analytics page's answer has no goals without `product_analytics`.
- The heatmap reports answer the project's allowed hostnames (`siteHostnames`) to users with Web analytics, for "Open on your site": the addresses of the project's own sites, not its keys or other settings.
- The AI page's breakdown by user, and the user of each of its latest calls, go only to users with `users`: otherwise `users` is null and `usersHidden` true ([AI usage](ai-usage.md#the-report)). The AI routes' `user` filter needs `users` too, and is refused with 403 without it.
- The overview's signed-in users widget names the newest users only to users with `users` (`newest` is null otherwise). Its firing alerts hold only the kinds the user may see, as the Alerts page's do.
- An error's occurrences and a user's events carry no replay, and a user's page no replays, without `replays`.
- The users routes (`…/users`, `…/users/:userId`) answer whether the project requires signed user IDs (`signedUserIdsRequired`) to anyone with `users` view, the one project setting they show without the `projects` permission: the pages say when the IDs they list could be made up ([web analytics](web-analytics.md#signed-user-ids)).
- The replay and source map overviews (`GET …/replays`, `GET …/source-maps`) leave out `instance`, what all projects store together against the instance's limit, for users without the `projects` permission.

### Public routes

These need no session, and declare nothing: health, collection with a project's key (`/api/events`, `/api/server-events`, `/api/ai-calls`, `/api/replays`, `/api/heatmaps`, `PUT /api/source-maps`, `/v1/traces`, `/v1/logs`, `/v1/metrics`), the scripts (`/t.js`, `/v.js`, `/r.js`, `/h.js`, `/o.js`, `/s.js`, `/replay-player.js`), the dashboard's files, sign-in (`/api/auth/*`), setup (`/api/setup`), accepting an invitation (`POST /api/invite/preview`, `POST /api/invite/accept`), and a reset link (`POST /api/reset-password/preview`, `POST /api/reset-password`). The last four take the token in the body and are limited per client address, an IPv6 address by its /64: 10 at once, then one a minute, as setup is. Also "Forgot password?" (`POST /api/reset-password/request`, an email address in the body), which answers the same for every address, is limited per client address and per email address, and only queues an email ([Account email](#account-email)). Also the heatmap overlay's exchange (`POST /api/heatmap-overlay/session`, a link token in the body, limited per client address: 10, then one every 30 seconds) and the browser's preflights for its read and its save (`OPTIONS /api/heatmap-overlay/:projectId/heatmap`, `…/snapshot`).

### Tests

- `apps/api/tests/access-routes.test.ts` builds the app with every feature on and walks every registered route (Fastify's `onRoute`). It fails when a route outside the public list declares no need, when a route declares one of the wrong scope, when a public route stops existing, or when a route's need differs from the table above.
- `apps/api/tests/access.test.ts` creates members directly in the database. For each area, a member without it is refused with 403 on every route of the area, and a member with view is refused on its manage routes and reaches its view routes. It also checks: every project route of a project the member is not granted answers exactly as an unknown project; members never see keys and cannot reach project settings, channels, or the instance's settings; "all projects" includes a project created later and a list does not; admins manage projects and channels but not the instance's settings; `/api/me`; a change applies on the next request; a deleted user is signed out; goals are left out without product analytics; one owner only. Then: alert rules, alerts, and firing alerts of each kind by the areas the user has, an error rule changed into a check rule keeping its old alerts and when it last fired from check-only readers, and the warning; the storage totals; no replay in errors and a user's activity without replays; `/alert-channels` answering three fields; `setUserAccess`; invitation emails in lower case; rolling back the migration; and migration 0022 giving members and invitations AI at their monitoring level, and moving AI alerts in the inbox from monitoring to AI.
- `apps/api/tests/heatmap-overlay.test.ts` checks the overlay's tokens: minting needs Web analytics at view and the dashboard's origin, and keeps only a hash for 5 minutes; a link works once (one of three at once), expires, and needs the project's site; a session lasts 30 minutes, is for its project only, and a revoked grant, a removed member, or a deleted project fails on the next read; neither the public key, a link, nor the cookie reads; CORS only for the project's allowed hostnames once it is known (refusals after it too), none before it, never with credentials; `no-store`; the limits per client address and the links per user; signing out, a password reset, and the dashboard session's end ending the overlay's tokens; and malformed requests refused by an app whose databases cannot be reached.
- `apps/api/tests/account.test.ts` checks the user's own account ([Your account](#your-account)): the name; the email changed with the password, signing in with the new one at once (in any case) and not the old, the sessions and the role kept; a wrong password, an address another account uses, an address sign-in refuses, the same address, and malformed bodies refused; an address with a pending invitation refused (and the invitation still working), and an account taking an invitation's address during accepting answering as a used link; the one bucket of password tries per user, shared with ownership, one user's not spending another's; the password changed with the current one, other sessions kept or ended, and this browser's new session; Better Auth's own routes for these, and for deleting the account or unlinking its password, answering 404 (with a trailing slash, in other letter case, and with deleting turned on); listing only the user's sessions, a three-day-old one too, with the User-Agent and no address or token; revoking one (not another user's, not the current one) or all the others; and a revoked session ending the overlay links made in it.
- `apps/api/tests/storage.test.ts` checks that the owner and admins read the storage and choose its channels, and members and anyone signed out cannot.
- `apps/api/tests/members.test.ts` covers invitations (the link and its hash, the role rules, an email with an account, inviting again, accepting with a deleted project dropped, a double submit, signing in after, every link that no longer works getting one message, revoking and renewing), members (the list, changing access within the role rules, a demoted admin's invitations revoked, removing and signing out, data kept, a removed admin's invitations gone), reset links (the role rules, one per user, the old password until used, sessions deleted, expiry), ownership (the password, the roles after), and the links' rate limit. It also forces the races the role checks guard against (a target promoted while an admin acts on them; an heir deleted during a handover), and checks that links outlive no right: a member's link dies when they are promoted, so it cannot take over the ownership; a removed or demoted admin's links and invitations die; a surviving link is refused at use; an invitation is refused when its inviter has lost the right; an admin cannot replace the owner's admin invitation; a handover revokes the old owner's admin invitations and limits password tries. `apps/api/tests/auth.test.ts` covers setup's confirmation, timezone, and email status.
- `apps/api/tests/account-email.test.ts` checks account email ([below](#account-email)): "Forgot password?" answering the same status and body for an account's address and an unknown one, its request doing only one insert either way (no link is made and no account looked up before the worker runs), and the worker emailing the account and sending nothing for the unknown address; the link working once, for an hour, from `PUBLIC_URL`, with an HTML version; a new request replacing the earlier emailed link but not an admin's, and using one voiding both; the reset ending every session and queueing the "password changed" email; malformed bodies and addresses sign-in refuses refused, also by an app whose databases cannot be reached; the limits per email address (for an account's address and an unknown one alike) and per client address (an IPv6 address by its /64); invitations emailed with the inviter and the instance, New link sending again, revoking dropping an email not sent; "Email it to them"; the notice to an old address; the worker retrying and giving up, deleting the row, and giving up without a mailer; the test email's access, origin, limit, and error wording (never the URL); and, without SMTP, nothing queued or sent and both public answers saying why. Then the security review's fixes, each checked by breaking it once: a flood of reset requests not holding back an invitation, one request waiting per address in any case and spacing, the indexes, the instance's limit (and a request it refuses not counting against its address, and 10,001 other addresses not resetting a victim's count), case and spaces counting against one address's limit, the per-client limit before the body is read, two workers never taking one email, two uses of one token setting the password once, a retry sending the first attempt's link, the links sealed in the queue, an email change voiding every reset link (one the owner emailed and sent, and one only copied) and a reset request the worker takes as the email changes sending no working link and a link used as the email changes refused without a deadlock (both races forced), a remade reset link dropping the earlier one's email, the per-actor limit on emailed invitations, and a worker without SMTP keeping the rows. `account-email.test.tsx` also checks the Account page's email line both ways. `apps/web/tests/browser/account-email.test.tsx` checks the sign-in page with and without SMTP, the Forgot password page's answer, limit, and no-email message, the invitation and reset-link dialogs emailing, and the test email's success and failure.
- `apps/api/tests/project-stars.test.ts` checks starred projects ([dashboard](dashboard.md#starred-projects)): starring a project the user may not reach, or none, answers 404 as the access check does; a member's change of projects (by `setUserAccess`, and through the Members page) deletes their stars on the others, and a star given back does not return; a star left on a project the user cannot reach is not listed; each user sees only their own.
- `apps/api/tests/notifications-inbox.test.ts` checks the inbox ([below](#notifications)) and error assignment: every route needs a session, changes the dashboard's origin, and bodies and queries are refused before anything else; a member sees a project's alerts with uptime and alerts, an error rule's also with errors, a telemetry rule's also with monitoring, an AI rule's also with AI (not monitoring), only for granted projects, and none from before their account; the storage and backup items for the owner and admins only; a project or area taken away hides its items at once, and marking one answers as an unknown item; read and unread per user, Mark all read, the unread filter, pages, and the 90-day clean-up with the reads; an alert firing twice makes one item and resolving its own, an error rule's item needing errors too, and a test send none. For assignment: the people offered are those who see the project's errors, choosing needs errors at manage, anyone else is refused, the assignee gets an item and an email (none for assigning themselves, none again for the same person), the list's assignee and its Everyone, Assigned to me and Unassigned filter, resolving keeping the assignee, a regression telling the assignee once, and losing the project or the area, or being removed, clearing their assignments. `storage.test.ts` and `backups.test.ts` check the storage warnings' and backup notices' items.
- `apps/api/tests/avatars.test.ts` and `favicons.test.ts` check avatars ([below](#avatars)).
- `apps/web/tests/browser/access.test.tsx` checks what the dashboard hides; `members.test.tsx` the Members page; `links.test.tsx` the invitation, reset, and setup pages.

## The dashboard

`GET /api/me` answers the user (with their avatar's address), the instance's name, timezone, and icon, their projects and areas, their permissions, and whether avatars can be uploaded. The dashboard reads it on each page (`useAccess`, `meQuery`):

- The project menu lists only the areas the user has, and the project's Settings only for the owner and admins. The workspace menu shows Settings only to the owner and admins.
- A page the user cannot open shows "You don't have access" (`NoAccess`). Each project route names what it needs (`staticData.access` in `router.tsx`), and `ProjectLayout` checks it.
- Opening a project, or the home page, goes to the project's overview when the user has one of its areas (uptime and alerts, errors, monitoring, AI, web analytics, product analytics), and otherwise to the first area the user has, in the menu's order. The overview shows only the widgets of the user's areas ([dashboard](dashboard.md#overview)).
- The project list hides "New project" and allowed sites from members.
- The Settings page's General, Location data, Backups, and Server log tabs show to the owner, and its Storage, AI models, and Notification channels tabs to the owner and admins. A member gets "You don't have access". The workspace menu's Members link, to `/settings/members`, shows to the owner and admins.
- Where one area's page links into another, the link shows only when the user has that area: an error's user, trace, and replay; a user's errors, replays, and AI usage (which needs AI); an AI call's trace (which needs monitoring: without it, the trace ID shows as text and the latest calls have no trace column); a replay's error and user; the alert rules on an error's page; "Add an alert rule" on the monitoring pages; links to the project's settings.
- Buttons that change something show only with manage: Resolve and Reopen; adding, editing, pausing, and deleting checks and rules (the rules' switches are disabled); saving, renaming, and deleting funnels; adding and deleting goals.

The API refuses all of these regardless. Hiding them only saves the user a refusal.

## Invitations

Code: `apps/api/src/access/invitations.ts` and `member-routes.ts`; `apps/web/src/features/settings/members-page.tsx` and `access-editor.tsx`; `apps/web/src/features/auth/invite-page.tsx`.

Without SMTP, the inviter copies a link and sends it: most self-hosted installs have no mail server. With SMTP, Ottertrail also emails it ([Account email](#account-email)), and the inviter still gets the link to copy, in case the email is lost.

- On the Members page (`/settings/members`), the owner or an admin enters an email address and picks a role (admin only for the owner) or a member's access (a preset, the areas, and the projects). They get a link to copy; with SMTP the answer says `emailed`, and the email is queued.
- The link carries a random 32-byte token in its fragment, `/invite#token=…`, as the setup link does. Only a SHA-256 hash of the token is stored (`dashboard_invitations`).
- The link works for 7 days. Pending invitations show on the Members page's Invitations tab (email, role, access, who invited, when made, expiry), where they can be revoked, after a confirmation. "New link" replaces the token, since the plain token cannot be shown again, and with SMTP emails the new link (an email of the old one not yet sent is dropped, and so is one of a revoked invitation).
- Inviting an email that already has an account is refused. Inviting a pending email again replaces the old invitation (one per email). Emails are stored in lower case; a check constraint refuses any other.
- The accept page (`/invite`) shows who invited them and to which instance; not the role or the access, which the person sees once signed in. Its preview (`POST /api/invite/preview`) sends only the email, the inviter's name, and the instance's name, so whoever holds a link does not learn the instance's project names. Accept reveals name, password, and confirm-password fields; the email is fixed. Submitting does everything in one transaction:
  - use up the token: delete its one row, so a double submit or a second tab finds nothing;
  - check the email has no account;
  - create the user and their credential, with Better Auth's password hash;
  - store the grants with `setUserAccess`, which drops projects deleted since.

  Then it signs them in, as the setup page does. Nothing is saved before the password is set, so closing the page after Accept leaves the invitation pending and the link still works.

- A signed-in visitor is asked to sign out first.
- Expired, revoked, used, and unknown links all get one message: "This invitation link no longer works. Ask for a new one." It reveals nothing else.
- When the inviter is removed, their pending invitations go with them (a foreign key). When the inviter loses admin, the code revokes them. A handover revokes the old owner's admin invitations, which an admin could not make.
- Accepting checks the inviter again, in the transaction, on their locked row: they must still exist and still be allowed to give the role. Otherwise the link gets the one message.
- Inviting a pending email again is refused when the pending invitation is one the inviter could not make: an admin cannot replace the owner's admin invitation.
- The accept routes are rate-limited per client address, as sign-in is.

## Changing a user's access

`setUserAccess` (`apps/api/src/access/grants.ts`) is the one place that changes a user's role and grants, for the Members page and invitations. An admin keeps no grants rows. A member gets exactly the areas and projects given; "all projects" clears the project list; projects deleted meanwhile are dropped. A member given a list of projects loses their stars on the others. So no old grant comes back when a role or access changes. Error groups assigned to the user in projects whose errors they can no longer see go back to Unassigned, in the same transaction ([errors](errors.md#assignment)). It never changes the owner.

## Members

Code: `apps/api/src/access/members.ts` and `member-routes.ts`; `apps/web/src/features/settings/members-page.tsx`.

- The Members page's Members tab lists everyone, the owner first: name, email, role, a summary of their access ("Viewer · All projects"; "Everything" for the owner and admins), and last sign-in (`dashboard_users.last_sign_in_at`, set on each sign-in). Each row's menu holds only the actions the signed-in user may take on that person: Change access (a sheet with Save), Make reset link, Remove, and for the owner, Make owner ([dashboard](dashboard.md#members)).
- The owner and admins, within the role rules, change access and remove members, through `setUserAccess`. Nobody acts on themselves or on the owner there; an admin acts on members only, and makes no admins. Removing deletes the account and its sessions, their pending invitations and the reset links they made, the error groups assigned to them, their notifications and reads, and their avatar in the object store; demoting an admin deletes the invitations and links too. `error_resolutions.resolved_by` and `error_assignments.assigned_by`, the other columns that name a dashboard user, are set to null.
- Each change locks the target's row before checking their role, in one transaction, and deletes only a user whose role is still the one checked. So an admin cannot act on someone the owner is promoting at the same moment.
- The owner hands ownership to another user after entering their password again; the old owner becomes an admin. The owner cannot be removed and cannot demote themselves. The password may be tried 5 times, then once a minute, per user, counted with the email and password changes on the Account page ([Your account](#your-account)). The heir's row is locked first, and if promoting them changes nothing (they were deleted meanwhile), the whole handover rolls back, so the instance always has its owner.

## Your account

Code: `apps/api/src/account/routes.ts`; `apps/web/src/features/account/account-page.tsx` ([dashboard](dashboard.md#account-settings)).

Every signed-in user changes their own name, email, and password, and sees and ends their own sessions. Nobody changes another user's here; the Members page holds what the owner and admins do to others.

- **The name** (`PATCH /api/account`, `{ name }`): 1 to 200 characters with something other than spaces, trimmed.
- **The email** (`POST /api/account/email`, `{ email, password }`) checks the current password every time, against Better Auth's hash, then changes the address at once. No confirmation email is sent to the new address, because most self-hosted servers have no mail set up (decided with the user, 20 November 2026). With SMTP, a notice goes to the old address, so a change its owner did not make is noticed ([Account email](#account-email)). The address must pass sign-in's own check (`canSignInWith`, as setup and invitations), is stored in lower case, as sign-in looks it up, and must differ from the current one. The unique index on `dashboard_users.email` decides whether another account has it, so two users cannot take one address at once: 409 `email_in_use`. An address with a pending invitation belongs to its invitee, so taking it answers 409 `email_invited`, which says to enter another address or have the invitation revoked: otherwise someone could take an invited admin's address, the real invitation would fail, and the impostor could pass for the invitee. The check is part of the update (`where not exists` an invitation for the address), so no invitation can arrive between a check and the change. Accepting an invitation whose address an account takes meanwhile answers as a link that no longer works, not a server error (the unique index's refusal, in `acceptInvitation`). Only the address and `updated_at` change: the role, the grants, and the sessions (this one and the others) stay. In the same transaction, every reset link of the user stops working, since one may have gone to the old address, whose mailbox may be someone else's now: the emailed "Forgot password?" link, and the link an owner or admin made, whether they emailed it or only copied it (once an email is sent, nothing records where it went, and the user, who just entered their password, needs no link; an owner or admin makes a new one in a moment). Queued reset emails to the old address are dropped. The worker makes a "Forgot password?" link with the account's row locked and found again by the address, so an email change at the same moment either comes first, and the old address gets nothing, or waits, and voids the link. Sign-in takes the new address on the next attempt, and the old one no longer.
- **The password** (`POST /api/account/password`, `{ currentPassword, password, confirmPassword, revokeOtherSessions }`) passes to Better Auth's `changePassword`, which checks the current password and hashes the new one (12 to 128 characters, as everywhere). With `revokeOtherSessions`, Better Auth deletes every session of the user and signs this browser in again: the answer sets the new cookie. A wrong current password answers 403 `wrong_password`, as handing over ownership does.
- **Better Auth's own routes for these** (`/api/auth/update-user`, `/api/auth/change-email`, `/api/auth/change-password`) are turned off (`disabledPaths` in `auth/auth.ts`) and answer 404, with a trailing slash or in other letter case too, so the checks above cannot be gone around. So are deleting the account (`/api/auth/delete-user`, and its callback) and unlinking its password (`/api/auth/unlink-account`), which Ottertrail does not offer, even were deleting turned on in Better Auth. Better Auth's freshness rule (a session at most a day old for its sensitive routes) stays at its default.
- **Limits:** every route that checks the user's current password (the email change, the password change, and handing over ownership) spends from one bucket per user: 5 tries, then one a minute, across all three (`PASSWORD_TRY_LIMIT` in `auth/password-tries.ts`; the app makes one limiter and gives it to each); then 429 with `Retry-After`. So a stolen session gets 5 quick guesses, not 5 per route. All three need a session, so the user is the key; nothing reaches them without one. Fastify checks the body against its schema before the session is read; the address's format, the same address, and the confirmation are checked before the password is, and before any write. The request log has the method and URL only, so neither passwords nor addresses are logged.
- **Every change comes from the dashboard:** the routes that change something need the dashboard's `Origin`, as every such route does.

### Sessions

The Sessions tab uses Ottertrail's own routes, which act on the user's own sessions only, by their ID. No token reaches the page: the session's token is what its cookie carries.

- `GET /api/account/sessions` lists the user's unexpired sessions, the most recently active first: the ID, when it signed in (`createdAt`), when its row was last renewed (`lastActiveAt`, at most once a day), its User-Agent, and `current` for this browser's. No address: Ottertrail never stores IP addresses (a check constraint on `dashboard_sessions.ip_address`). Every session is listed, however old.
- `DELETE /api/account/sessions/:id` deletes one other session (`where user_id` is the user's): another user's session ID deletes nothing and answers 404 `session_not_found`; the current session answers 400 `current_session`, since Sign out ends it.
- `DELETE /api/account/sessions` deletes all the user's sessions but this one, and answers how many.

Better Auth's own session routes under `/api/auth/*` (`list-sessions`, `revoke-session`, `revoke-other-sessions`) still exist, for the user's own sessions, under Better Auth's freshness rule; the dashboard does not use them.

A revoked session's cookie stops working on its next request. Heatmap overlay links and overlay sessions are tied to the dashboard session they were made in (`heatmap_overlay_tokens.session_id`, deleted with it), so revoking a session, signing out the other devices with a password change, or signing out ends the overlays opened from it ([below](#heatmap-overlay-tokens)).

## Heatmap overlay tokens

Code: `apps/api/src/access/overlay-tokens.ts`, `requireOverlayAccess` in `access.ts`, `apps/api/src/heatmaps/overlay-routes.ts`. What the overlay does with them: [web analytics](web-analytics.md#the-overlay-on-your-site).

- **A link** (`POST /api/projects/:id/heatmaps/overlay-link`, Web analytics at view, from the dashboard's origin, 20 a minute per user, then 429) is made only when "Open on your site" is pressed, and shown once. It works once, within 5 minutes, and carries the token in the address's fragment. It names the page it opens (`{ path }`, migration 0023), which its session may save a view of.
- **A session** is what the overlay gets for the link, once (`POST /api/heatmap-overlay/session`): it lasts 30 minutes, and the overlay keeps it in memory only.
- Both are 32 random bytes, kept only as their SHA-256 hash (`heatmap_overlay_tokens`, migration 0012) and found by it, never compared as text. Each is bound to the user who made it, the project, the scope `heatmap:read`, and the dashboard session the link was made in, and goes with the user, the project, or that session (foreign keys): signing out and a password reset, which delete the user's sessions, end them, and a dashboard session past its end ends them on their next use.
- **A token names a user; it grants nothing itself.** The exchange checks that user's access as the dashboard does, and so does every read (`requireOverlayAccess`). A member removed, a grant revoked, or a project deleted fails on the next read: 401 `session_expired` when the user is gone or the session ended, 404 for a project no longer granted, 403 without Web analytics. A session for one project cannot read another's.
- They read the heatmap aggregates of one project, any of its pages: no keys, settings, events, replays, or anything about one visitor. A session may also save a view of its link's page, and of no other (`POST /api/heatmap-overlay/:projectId/snapshot`, 403 `wrong_page` for another; [saved views](web-analytics.md#saved-views)), with the same check of the user's access. Saving writes; the scope keeps its name, `heatmap:read`, as Web analytics at view is what both need. The public key never reads or saves anything.
- Their answers are readable only by a page on the allowed hostnames of the project they concern, once it is known (from the link, or the read's address): the data, and the refusals after it (a link used up, no access, a session ended). An answer before it is known (a limit, a malformed or unknown token) is readable by none. Never with credentials, and never cached (`no-store`).
- Links used or expired are kept a day after they expire, so the overlay can say a link is used up; older rows are deleted whenever a token is made.

## Password reset links

Code: `apps/api/src/access/password-resets.ts`, `apps/api/scripts/reset-password.ts`, `apps/web/src/features/auth/reset-password-page.tsx`.

- From the Members page, a one-time reset link for a user, within the role rules: admins reset members; the owner resets anyone else. With SMTP, "Email it to them" makes the link and emails it to the user as well (`POST /api/members/:userId/reset-link` with `{ "email": true }`); the dialog still shows it to copy. Making a link again drops a queued email of the earlier one, whether or not the new one is emailed.
- With SMTP, from the sign-in page: "Forgot password?" emails a link that works for one hour ([Account email](#account-email)).
- A link outlives no right. Any change to a user's role or access (`setUserAccess`), and a handover for both users, deletes their pending reset link. An email change deletes all the user's links ([Your account](#your-account)). A user's links go when they are removed or demoted. Using a link checks again, in its transaction: a link a user made works only while that user exists and may still reset the target as they are now. A link from the server's command is marked as such (`made_by_command`), and works for anyone.
- It works for 24 hours. A user has at most one link made by a person or the command, and one emailed from "Forgot password?" (`dashboard_password_resets`, keyed by user and `emailed`, migration 0013): a new one replaces the old of its sort, so a stranger asking for an email never voids a link an admin made, nor the other way round. Using either deletes both. Only a hash is stored.
- The `/reset-password#token=…` page asks for a new password and its confirmation. Using it sets the password with Better Auth's hash and deletes all that user's sessions. The old password works until then. The page then signs them in. With SMTP, the user gets the "Your password was changed" email.
- For the owner, or any account, from the server: `vp run reset-password -- <email>` in development, `node dist/reset-password.mjs <email>` built. It prints a link that works for one hour.

## Account email

Code: `apps/api/src/notifications/account-emails.ts` (the queue, the messages, and the worker's sender), `access/member-routes.ts`, `account/routes.ts`; `apps/web/src/features/auth/forgot-password-page.tsx`. Decided with the user on 20 November 2026.

Only when the instance has SMTP set up (`SMTP_URL` and `EMAIL_FROM`, [deployment](deployment.md#email)). Without it, nothing below is queued or sent, and the dashboard works as before: links are copied and sent by hand.

| Email                          | Sent when                                                           | To                  | Link, and how long it works |
| ------------------------------ | ------------------------------------------------------------------- | ------------------- | --------------------------- |
| Reset your password            | Someone asks with "Forgot password?" and an account has the address | The account         | A reset link, one hour      |
| Reset your password            | An owner or admin chooses "Email it to them" on the Members page    | The user            | A reset link, 24 hours      |
| Your password was changed      | A reset link is used (any of the three sorts)                       | The user            | None                        |
| Invitation from …              | An owner or admin invites someone, or makes a New link              | The invited address | An invitation link, 7 days  |
| Your account email was changed | A user changes their email in Account settings                      | The old address     | None                        |
| … assigned you an error        | Someone else assigns an error group to the user                     | The assignee        | The error's page            |

The wording is in `account-emails.ts` (`accountEmailMessage`), from the chosen copy.

**The queue.** The API writes a row to `account_emails` (migration 0013) and answers; the worker sends due rows every few seconds, at most 5 at once, with the alert deliveries' retries (30 seconds, then up to 20 minutes, for about an hour), each row taken by one worker (`FOR UPDATE SKIP LOCKED`). Invitations, reset links, and notices are taken before "Forgot password?" requests, so a flood of requests cannot hold them back. A row is deleted when its email is sent, when it is given up, and in any case a day after it was made (an index on `created_at` serves that delete). Account emails are their own table: they never show among a channel's deliveries, and a channel's hourly cap never holds them back.

**Links in the queue.** An invitation (7 days) or a reset link an owner or admin emails (24 hours) sits in its row until it is sent: seconds usually, up to about an hour through every retry, and a day at most if the worker is stuck or has no SMTP. So the link is sealed: AES-256-GCM with a key derived from `AUTH_SECRET` by HKDF, bound to the email's kind and address (`notifications/link-sealer.ts`), and a dump of the database alone holds no working link. The trade-off: whoever has both the dump and `AUTH_SECRET` can open them; changing `AUTH_SECRET` while emails wait makes them unreadable, and they are given up (it signs everyone out anyway); and the API and the worker must share `AUTH_SECRET`, as they share the database.

**Without SMTP on the worker.** If the API has SMTP but the worker has not, the worker takes nothing, keeps the rows (a day at most), and logs once at start that account emails wait and that the worker needs `SMTP_URL` and `EMAIL_FROM` too; once it has them, it sends them.

**Messages.** Plain text, with a simple HTML version in which every value is escaped. The subject starts with the instance's name; names put into a subject are put on one line and cut at 200 characters. No header comes from a request: the recipient is an account's address, an invited address, or the address typed on "Forgot password?", which must pass sign-in's own check (`canSignInWith`). Links start with `PUBLIC_URL`, as copied links do, never with a request's `Host`.

**"Forgot password?"** On the sign-in page, a link on the Password label's row opens `/forgot-password` when `GET /api/setup` says `emailConfigured` (the only other thing it tells is whether an owner exists). Without SMTP, the same control opens a dialog explaining that email isn't set up and to ask the person who runs the instance for a reset link. Close returns focus to the trigger. An owner locked out needs the server's command. The page asks for the address, and `POST /api/reset-password/request` (`{ email }`):

- answers 202 with the same body for every address: "If an account uses that email, we'll send a reset link. Check your inbox and spam folder.";
- does the same work for every address: one insert of the address, in lower case. The worker looks the account up when it sends, makes the link then (`createPasswordReset` with `emailed`, one hour, its hash stored), and sends nothing when no account has the address. So the answer's time does not depend on whether the account exists;
- is limited per client address (an IPv6 address by its /64), 5 per 15 minutes, before the body is read; then for the whole instance, 30 at once and then 600 an hour, far below what the worker sends; then per email address, 3 an hour, counted the same way whether or not an account has it, after the address is trimmed and put in lower case. The email limit's key is the address's SHA-256 hash, so the limiter holds no address. All three answer 429 with the same body, "Too many reset requests. Wait a little, then try again.", and `Retry-After`;
- adds nothing while a request for the same address waits (a partial unique index on the address of `password_reset` rows, and `on conflict do nothing`), so one address never queues more than one;
- refuses a malformed body (400) before any database work, and an address sign-in refuses (400, the usual message);
- answers 404 `email_not_set_up` without SMTP, saying to ask the person who runs the instance for a reset link.

Each new request, once the earlier one is sent, replaces the user's earlier emailed link, but not a link an owner or admin made. The worker makes the link on the first attempt and seals it into the row, so a retry after a timeout sends the same link, and an email that did arrive still works.

The per-address limit is kept in memory, by address hash. Instead of counting in PostgreSQL (rows are deleted once sent, so counting them would need a table of requests of its own), the limiter keeps up to 100,000 addresses, and the instance's limit comes first: at most about 630 new addresses an hour reach it, and an address's bucket is full again an hour after its last request, so a flood of other addresses cannot push one out while it still counts.

**Invitations by email** are limited per owner or admin: 20 at once, then 20 an hour, counting Invite and New link; past it, 429 says how many were sent in the last hour, that this one wasn't made or sent, and in about how many minutes to try again. A refused invitation (an address with an account, no right) spends none. Using any reset link deletes the user's others, signs out every session, and with SMTP sends "Your password was changed".

**The test email.** `POST /api/channels/email-test` (the `channels` permission, from the dashboard's origin) sends one email to the signed-in user's own address through the instance's SMTP server while the request waits: it is not queued. It answers "The mail server accepted a test email for {email}. Check your inbox.", or 502 with "The test email could not be sent. Check the server's email settings, then try again. Error: …" and the server's refusal in `mailError`'s words, which never hold `SMTP_URL`. 5 per user in 10 minutes, then 429 with the wait. Without SMTP, 409 `email_not_set_up`.

**Logs.** Neither the API nor the worker logs an address or a link: the request log has the method and URL only, and the worker logs a failed or given-up email by its kind and attempt.

## Notifications

Code: `apps/api/src/notifications/inbox.ts` and `inbox-routes.ts`, `reachOf` in `access/access.ts`; migration 0016. The dashboard: [Notifications](dashboard.md#notifications). Decided with the user on 20 November 2026.

**One row per event, filtered when read.** `notifications` holds one row for each thing that happened, written in the transaction that records it, with what a reader needs to see it: the project (null for the instance), the areas of the project needed at view (`areas`), the instance permission needed (`permission`, for the instance's items), and for a personal item its one user (`user_id`). `notification_reads` holds a row for each item a user has read; no row is unread. The routes read the user's role and grants as every route does, turn them into what the user reaches (`reachOf`: the projects, the areas at view, the permissions), and filter in SQL. Copying each item to each user when it is made was the other way; it was not taken because access changes after an item is made: the copies would have to be deleted when a grant goes, and made when one comes. Filtering when read follows the grants as they are now, with nothing to keep in step: a member who loses a project or an area stops seeing its items on the next request. At a few thousand items over 90 days and dozens of users it is cheap: the list reads the newest rows by `created_at` and checks each; the unread count stops at 1,000. Items from before a user's account was made are left out, so a new member does not start with 90 days of unread alerts.

| Item                                                                                                                  | Made by                                                 | Who sees it                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| An alert rule firing and resolving: a check down and up, a certificate, an error new, regressed or spiking, telemetry | `notifyIn`, with the alert's state (`alerts/fire.ts`)   | Uptime and alerts at view, and the area the rule's kind watches ([above](#alert-rules-and-the-areas-they-watch)) |
| A rule's held-back summary                                                                                            | The same                                                | The same                                                                                                         |
| A storage warning raised, made critical, or cleared                                                                   | `notifyIn`, with the warning (`storage/warning-job.ts`) | The owner and admins (`projects`, as the Storage tab)                                                            |
| A backup's own warning (a failed or late backup) raised or cleared                                                    | The same                                                | The owner (`settings`, as the Backups tab)                                                                       |
| The backup key shown or downloaded, where backups go changed, backups turned off                                      | `notifyIn`, with the change (`backups/routes.ts`)       | The owner (`settings`)                                                                                           |
| An error group assigned to the user by someone else                                                                   | `assignError` (`errors/assignments.ts`)                 | The assignee, while they see the project's errors                                                                |
| The user's assigned group regressed                                                                                   | The worker, each minute (`tellAssigneesOfRegressions`)  | The assignee, while they see the project's errors                                                                |

- **Once each.** An item from a channel notification keeps that notification's ID (`source_id`, unique), and alerts are recorded once already (the rule's lock and state): an alert that fires again for the same key makes nothing, and resolving makes its own item. A rule's or warning's item is made whether or not it has channels. An alert that a rule's hourly cap holds back makes no item, as it sends nothing; the summary after the hour does. The channels' test sends make none.
- **The routes** need only a session (`signed_in`), since each user has an inbox; they show and change only the items the user reaches now. `PATCH /api/notifications/:notificationId` with `{ "read": true | false }` answers 404 `notification_not_found` for an item the user may not see, as for one that does not exist. `POST /api/notifications/read-all` marks every item the user sees. Changes need the dashboard's `Origin`; bodies and queries are checked first.
- **Email.** Items are not emailed: what goes to channels already reaches them there. Only an assignment emails the assignee, with SMTP ([Account email](#account-email)).
- **Kept** 90 days: the worker deletes older items with their reads, hourly with the alert history.

## Avatars

Code: `apps/api/src/avatars/` (`routes.ts`, `avatars.ts`, `images.ts`, `favicons.ts`); migration 0017. What the dashboard does with them: [dashboard](dashboard.md#avatars). Decided with the user on 20 November 2026.

- **Who changes what.** The instance's icon: the owner (`settings`, as `PATCH /api/settings`). A user's avatar: that user only, through `/api/account/avatar`, which acts on the signed-in user and takes no user ID. A project's icon: the owner and admins (`projects`, as `PATCH /api/projects/:id`). Every change needs the dashboard's `Origin`. None is part of setup.
- **What an upload must be.** The body is the PNG itself, `Content-Type: image/png`, at most 512 KiB (the route's body limit; past it 413 `image_too_large`). Its bytes must start with PNG's signature and an IHDR chunk whose width and height are 1 to 512. Anything else, SVG and other types included, answers 400 `invalid_image`, after the access check and before the object store or the avatar's row is touched. The routes take every content type as bytes, so a wrong one gets that same answer.
- **Limits.** 10 uploads per user, then one a minute, across the three `PUT` routes (`DEFAULT_AVATAR_UPLOAD_LIMIT`); then 429 with `Retry-After`.
- **Without an object store,** every change answers 409 `object_store_not_set_up`: "Uploads need object storage. Set OBJECT_STORE_URL on the server, then restart it." `GET /api/me` says `avatarUploads: false`.
- **Storing.** Each image goes under a new random name (`avatars/instance/<uuid>.png`, `avatars/users/<user>/<uuid>.png`, `avatars/projects/<project>/<uuid>.png`), so its address changes when it is replaced. The row (`instance_settings`, `dashboard_users`, or `projects`.`avatar_key`, each with a check constraint on the form) is locked and pointed at the new key; then the old object is deleted, and a failure there is logged, not answered. Remove clears the row, then deletes the object. Removing a member deletes everything under their prefix; deleting a project deletes its prefix with its other files (the worker's purge).
- **Who sees them.** `GET /api/avatars/…` needs a session. The instance's icon and users' avatars show to any signed-in user of the instance: colleagues' names show already (the assignee picker, the Members page for the owner and admins), and an instance belongs to one customer. A project's icon and favicon show only to users who reach the project; any other user gets 404, as for no avatar. Each route's parameters must match the key's form exactly (a UUID, then `<uuid>.png`, or `favicon-<uuid>.<png|ico|jpg|webp|gif>` for a project), and the key must be the one a row holds now; anything else answers 400 or 404 before the store is read.
- **Serving.** The bytes with `Content-Type` from the key's extension, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, and `Cache-Control: private, max-age=31536000, immutable`.
- **Where URLs appear.** `GET /api/me` answers the user's and the instance's `avatarUrl`; `GET /api/settings` the instance's; `GET /api/projects` and the project routes a project's `avatarUrl` (to everyone who reaches it) and `iconUrl` (to those who manage projects); error groups' assignees and `GET …/error-assignees` each person's `avatarUrl`.
- **Favicons** are fetched by the worker (requester `favicons`), never by a viewer's browser, and never from a private or internal address, even with `UPTIME_ALLOW_PRIVATE_ADDRESSES` on (`faviconPolicy`) ([deployment](deployment.md#avatars-and-favicons)).

`apps/api/tests/avatars.test.ts` checks: uploading, serving with the headers, replacing (the old object deleted, its address 404), removing; the owner alone for the instance (admins and members 403), each user their own, an outsider 404 for a project's; the dashboard's `Origin`; no object store (409, `avatarUploads` false); bodies that are not a PNG, the wrong type, SVG, ICO, too large (413), and IHDR sizes 0 and 513; the limit; a removed member's avatar deleted; a project's favicon shown without an icon, and a deleted project's icon and favicon purged; addresses of another form or another user refused. `favicons.test.ts` checks the link parsing (the choice, relative addresses, `<base href>`, SVG left out, only the head's first 64 KiB, hostile pages of unclosed tags in well under a second), the magic bytes and each format's declared size (oversized PNG, JPEG, GIF, WebP, and ICO refused, small ones kept), private addresses refused by the worker's rules even with the opt-in on, fetching from a local server (the best icon, `/favicon.ico` after a redirect and a bad link, SVG and oversize refused, loopback refused unless the test's rules allow it, a redirect to the metadata address refused), and the worker's job (none without a store, once, weekly, again on a new first site, the old object deleted, also when the store refuses the new site's favicon).

## Owner setup

The setup command stays. The setup page has:

- a confirm-password field, checked in the browser and by the API;
- the timezone, chosen on the page, with the browser's preselected and checked as the settings page checks it. The `TIMEZONE` setting is gone; the instance is in UTC until setup;
- a line saying whether email (`SMTP_URL` and `EMAIL_FROM`) is set up, which covers alerts and account email (invitations, reset links, Forgot password, notices; [Account email](#account-email)), with a hint on how to set it when not (`GET /api/setup` answers `emailConfigured`, which the sign-in page also reads). Nothing is sent.

### Scheduled backups

The Backups tab's routes (`apps/api/src/backups/routes.ts`) need `settings`: admins and members get 403. Changes check Origin, and bodies are checked before any database work. Where backups go is the worker's `BACKUP_S3_*`, which the API never reads: no route can change it. The backup key is returned only by `POST /api/settings/backups/key` and `…/key/file`, with the current password in the body and `Cache-Control: no-store`, and each logs that the key was shown or downloaded, with the user's ID, never the key. Those two, and turning backups off, need the current password (the shared limiter in `auth/password-tries.ts`), and each notifies the storage-warning channels (`backups.changed`) and, with SMTP, emails the owner (`backup_changed` in the account email queue). `key/replace` writes only over the key it read, so two at once cannot each show a different key. Test connection (10 in 10 minutes), Back up now, and Test restore (3 an hour each) are limited per user ([deployment](deployment.md#scheduled-backups)).

### Server log

`GET /api/settings/server-log` needs `settings`: admins and members get 403, and anyone signed out 401. A request another site's page makes is refused with 403 too (a `Sec-Fetch-Site` other than `same-origin`, or an `Origin` not the dashboard's), so a page on a sibling subdomain can't hold its few places while the owner visits it. It shows the API's and the worker's log lines, which name projects, routes, and errors across the whole instance, so it is the owner's alone. An open stream checks the session and the permission again every 30 seconds and closes when either is gone, so signing out, a deleted session, or handing over ownership ends it within that time. Secrets and personal data are masked in the logger before a line reaches stdout or the stream ([dashboard](dashboard.md#server-log)). In the hosted service ([multi-tenancy](multi-tenancy.md)) it shows one deployment's lines for every organization, so it becomes the operator's, not an organization owner's; that change is the one permission this route checks.

## Known limits

- An error occurrence still shows the ID of the user it happened to, as text, to members without the users area. So do a replay's row and page. The links to the user's page are hidden, and the API refuses that page.
- A user's page lists the user's errors, as text, to members without the errors area; the links are hidden.
- An error group's assignee (ID and name) shows to everyone who sees the project's errors, in the list and on the group's page, though only those with errors at manage can list the people to choose from. The assignee is someone who sees those errors too.
- An invitation or reset link is shown once, to whoever made it, and sent by them or emailed: anyone who sees it before it is used can use it, and so can anyone who reads the recipient's mailbox. Links expire (7 days, 24 hours, or one hour from the command or "Forgot password?"), and a new one replaces the old.
- An emailed invitation or reset link waits in `account_emails` until the worker sends it: seconds usually, up to about an hour of retries, and a day at most. It is sealed with a key from `AUTH_SECRET`, so a dump with the secret opens it ([Links in the queue](#account-email)). A "Forgot password?" row holds only the address until its first attempt, then its link, sealed.
- The instance's limit on "Forgot password?" is shared by everyone: a flood from many addresses can use it up, and real requests are refused until it refills (minutes). It bounds the queue, so invitations and notices still go out.
- "Forgot password?"'s limits are kept in the API process's memory, as every limit is: they start again when it restarts, and several API processes would each allow the full rate.
- Whether an account email was delivered shows nowhere in the dashboard: an owner or admin who emailed a link sees only that it was queued. The worker logs a give-up with the kind of email, never the address. The link to copy is the fallback.
- A heatmap overlay link is in the address of the page it opens until the tracker removes it; a script of the page that runs first can read it. Whoever uses it first gets the session (30 minutes of that project's heatmap aggregates). Its `Origin` check binds it to the project's sites only in browsers.
- The rule form's suggestions (services, routes, metrics, hosts) come from the monitoring routes. A member who manages alerts without monitoring gets no suggestions, and types the names.
- Deleting source maps needs errors at manage, but the dashboard shows source maps only on the project's settings page, which members do not see. Only the owner and admins can delete them from the dashboard.
- Deleting every replay of a project is a project setting (`projects`), beside the replay mode on the same card.
- The project's name and creation time are visible to any member granted it, whatever their areas.
- Traces, logs, and server exceptions carry the end user's ID when the app's OpenTelemetry attributes hold one (`user.id`, `enduser.id`). So members with monitoring, or errors, see those user IDs without the users area.
- An email change says when another account has the address (409 `email_in_use`), so a signed-in user can learn whether an address has an account here: with their own password, within the shared password tries.
- An email change refuses an address with a pending invitation (409 `email_invited`), so a signed-in user can learn whether an address has been invited, as `email_in_use` tells whether it has an account: with their own password, within the shared password tries. An invitation made for an address at the moment someone takes it can still lose: accepting then answers that the link no longer works.
- Changing the password with "Sign out of my other devices" starts a new session, which the Members page counts as a sign-in (`last_sign_in_at`).
- The Sessions tab's "Last active" is when Better Auth last renewed the session's row, at most once a day, not the session's last request.
- `GET …/replays/list?userId=` lets a member with replays filter replays by an end user's ID, and so find whether that user has any, without the users area.
- The people offered as an error's assignee (`GET …/error-assignees`) are named to anyone with errors at manage on the project, including people they would not otherwise see on the Members page: their name and ID, no email or role.
- Inbox items made before migration 0022 that sum up what an AI rule held back (`alert.held_back`) still need monitoring, not AI. The inbox row keeps no rule ID, and its title and link do not tell an AI rule from a route or metric rule, so the migration cannot move them. New ones need AI.
- A notification's title is written when it is made: a member who sees the item later reads what it said then (an error's message, a check's name), as the alert history does.

## Rolling back

Before migration 0006, every signed-in user could do everything. So its `down()` deletes every user but the owner, with their sessions: a member or admin left behind would get full access from the older code.
