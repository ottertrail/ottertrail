# Access

Who may do what in an instance: roles, members' access per area and project, and how the API checks it. Decided with the user on 18 November 2026. Code: `apps/api/src/access/`, `apps/web/src/lib/access.ts`.

It is built in two parts:

| Part                                                         | Status |
| ------------------------------------------------------------ | ------ |
| A. Roles, grants, the one check, the dashboard hiding        | Built  |
| B. Members page, invitations, reset links, owner setup pages | Built  |

## Roles

Each dashboard user has one role (`dashboard_users.role`):

- **Owner.** Exactly one per instance; a partial unique index allows no second. The owner can do everything: the instance's settings (name, timezone, and automatic location data updates, with the location data's status), handing ownership to another user, and everything an admin can do, including to admins.
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
| `web_analytics`     | Analytics, Speed                                                      | Both pages                  | (none)                                                                           |
| `product_analytics` | Events, Funnel, Retention, and the goals on the Analytics page        | Every report, saved funnels | Saving, renaming, and deleting funnels; adding and deleting goals                |
| `errors`            | Errors, an error's page                                               | Groups, occurrences, stacks | Resolving and reopening; deleting source maps                                    |
| `replays`           | Replays, a replay's page, the player, the replay in an error's dialog | Every replay                | (none)                                                                           |
| `users`             | Users, a user's page (identified end users and their activity)        | Both pages                  | (none)                                                                           |
| `monitoring`        | Traces, Logs, Metrics, Services, Databases, Hosts                     | Every page                  | (none)                                                                           |
| `uptime_alerts`     | Uptime, Alerts                                                        | Checks, rules, alerts       | Creating, changing, and deleting checks and alert rules; choosing their channels |

Replays and users are areas of their own because they show individual people.

Members never see project keys, project settings, notification channels (beyond their names, for choosing a rule's), the Members page, or the instance's settings.

### Presets

The Members page fills in the areas from a preset, which can then be changed:

| Preset      | Areas                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------ |
| Viewer      | View on everything except replays and users                                                      |
| Engineering | Manage errors and uptime and alerts; view monitoring and replays; view web and product analytics |
| Marketing   | View web analytics; manage product analytics; nothing else                                       |
| Custom      | Any other mix                                                                                    |

`PRESETS` in `apps/api/src/access/areas.ts` holds the first three.

## How the API checks it

All in one place, `apps/api/src/access/access.ts`:

- Every route on a project runs `requireProjectAccess(db, need)`. `need` is an area and a level (`{ area: "errors", level: "manage" }`), the "projects" permission (the project's keys, settings, and deletion), or only the project itself (its name).
- Every other dashboard route runs `requirePermission(db, permission)`: `settings` and `ownership` (the owner), `members`, `channels`, or `projects` (the owner and admins), or `signed_in` for routes that show each user only what they may reach (`GET /api/me`, `GET /api/projects`).
- Both read the user's role and grants from PostgreSQL on every request, so a change applies on the next click. Deleting a user deletes their sessions with them (a foreign key), which signs them out at once.
- A project the member is not granted answers exactly as a project that does not exist: 404 with `{ "error": "not_found", "message": "No project has this ID." }`. A member cannot tell the two apart.
- A granted project without the area or level answers 403 with `{ "error": "forbidden", "message": "You don't have access to this." }`. So does an instance route without the permission.
- Not signed in answers 401, as before.

Fastify checks a route's parameters and body before the access check runs, so a malformed request answers 400 even where access would be refused. A 400 says nothing about the project.

### Each route's need

| Route                                                                                                                                                        | Needs                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| `GET /api/me`, `GET /api/projects`                                                                                                                           | Signed in                  |
| `GET`, `PATCH /api/settings`, `GET /api/settings/location-data`                                                                                              | `settings` (the owner)     |
| `/api/members…`, `/api/invitations…` (seven routes)                                                                                                          | `members`                  |
| `POST /api/members/:userId/ownership`                                                                                                                        | `ownership` (the owner)    |
| `POST /api/projects`, `GET /api/client-address` (the requester's own address, for blocked addresses)                                                         | `projects`                 |
| `/api/channels…` (all eight)                                                                                                                                 | `channels`                 |
| `GET /api/projects/:id`                                                                                                                                      | The project                |
| `PATCH`, `DELETE /api/projects/:id`, `POST …/public-key`, `POST …/secret-key`, `DELETE …/replays`, `POST …/spam-visits/preview`, `POST …/spam-visits/delete` | `projects`                 |
| `…/analytics`, `…/analytics/list`, `…/speed`                                                                                                                 | `web_analytics` view       |
| `…/events`, `…/events/:name`, `…/funnel`, `…/retention`, `GET …/goals`, `GET …/funnels`                                                                      | `product_analytics` view   |
| `POST`, `DELETE …/goals`, `POST`, `PUT`, `DELETE …/funnels`                                                                                                  | `product_analytics` manage |
| `GET …/errors`, `GET …/errors/:fingerprint`, `GET …/source-maps`, `…/source-maps/files`                                                                      | `errors` view              |
| `PATCH …/errors/:fingerprint`, `DELETE …/source-maps`                                                                                                        | `errors` manage            |
| `GET …/replays`, `…/replays/list`, `…/replays/:replayId`, `…/timeline`, `…/player`                                                                           | `replays` view             |
| `…/users`, `…/users/:userId`                                                                                                                                 | `users` view               |
| `…/traces…`, `…/logs…`, `…/metrics…`, `…/services…`, `…/databases…`, `…/hosts…`                                                                              | `monitoring` view          |
| `GET …/checks…`, `GET …/alert-rules…`, `…/alerts`, `…/alerts/firing`, `…/alert-channels`                                                                     | `uptime_alerts` view       |
| `POST`, `PATCH`, `DELETE …/checks…` and `…/alert-rules…`                                                                                                     | `uptime_alerts` manage     |
| `GET`, `PUT`, `DELETE …/overview/layout` (the user's own layout)                                                                                             | The project                |
| `…/overview/attention`, `…/overview/uptime`                                                                                                                  | `uptime_alerts` view       |
| `…/overview/errors`                                                                                                                                          | `errors` view              |
| `…/overview/services`                                                                                                                                        | `monitoring` view          |
| `…/overview/speed`, `…/overview/traffic`, `…/overview/sources`                                                                                               | `web_analytics` view       |
| `…/overview/main-goal`, `…/overview/goals`, `…/overview/users`                                                                                               | `product_analytics` view   |

`GET /api/projects/:id/alert-channels` lists the instance's channels by ID, name, and kind only, for the rule form. A rule may name any of the instance's channels.

### Alert rules and the areas they watch

A rule shows what it watches: an error rule shows error groups and messages, a telemetry rule services, routes, and metrics. So each kind also needs the area it watches, at view (`sourceAreaOf` in `apps/api/src/alerts/kinds.ts`):

| Kinds                                                 | Also needs        |
| ----------------------------------------------------- | ----------------- |
| `check_down`, `certificate_expiring`                  | Nothing more      |
| `error_new`, `error_regressed`, `error_spike`         | `errors` view     |
| `route_latency`, `route_failures`, `metric_threshold` | `monitoring` view |

- Creating a rule, or changing one to another kind, of a kind the user may not see answers 403.
- The rule list, the alerts, and the firing alerts hold only the kinds the user may see. A rule of another kind answers as a missing rule (404 `rule_not_found`) to reading it, its history, changing it, and deleting it.
- The warning that a telemetry rule's service, route, or metric has not reported goes only to users with monitoring at view. It tells whether they exist.
- The rule form offers only the kinds the user may add, and a link that opens it for another kind does not open it.

Some answers show less to a user without another area:

- `GET /api/projects` and `GET /api/projects/:id` answer only the ID, name, creation time, and last event to users without the `projects` permission: no keys and no settings, among them the blocked addresses and blocked referrers ([web analytics](web-analytics.md#blocked-addresses)). The list holds only the projects the user may reach.
- The analytics page's answer has no goals without `product_analytics`.
- The overview's signed-in users widget names the newest users only to users with `users` (`newest` is null otherwise). Its firing alerts hold only the kinds the user may see, as the Alerts page's do.
- An error's occurrences and a user's events carry no replay, and a user's page no replays, without `replays`.
- The replay and source map overviews (`GET …/replays`, `GET …/source-maps`) leave out `instance`, what all projects store together against the instance's limit, for users without the `projects` permission.

### Public routes

These need no session, and declare nothing: health, collection with a project's key (`/api/events`, `/api/server-events`, `/api/replays`, `PUT /api/source-maps`, `/v1/traces`, `/v1/logs`, `/v1/metrics`), the scripts (`/t.js`, `/v.js`, `/r.js`, `/replay-player.js`), the dashboard's files, sign-in (`/api/auth/*`), setup (`/api/setup`), accepting an invitation (`POST /api/invite/preview`, `POST /api/invite/accept`), and a reset link (`POST /api/reset-password/preview`, `POST /api/reset-password`). The last four take the token in the body and are limited per client address, an IPv6 address by its /64: 10 at once, then one a minute, as setup is.

### Tests

- `apps/api/tests/access-routes.test.ts` builds the app with every feature on and walks every registered route (Fastify's `onRoute`). It fails when a route outside the public list declares no need, when a route declares one of the wrong scope, when a public route stops existing, or when a route's need differs from the table above.
- `apps/api/tests/access.test.ts` creates members directly in the database. For each area, a member without it is refused with 403 on every route of the area, and a member with view is refused on its manage routes and reaches its view routes. It also checks: every project route of a project the member is not granted answers exactly as an unknown project; members never see keys and cannot reach project settings, channels, or the instance's settings; "all projects" includes a project created later and a list does not; admins manage projects and channels but not the instance's settings; `/api/me`; a change applies on the next request; a deleted user is signed out; goals are left out without product analytics; one owner only. Then: alert rules, alerts, and firing alerts of each kind by the areas the user has, and the warning; the storage totals; no replay in errors and a user's activity without replays; `/alert-channels` answering three fields; `setUserAccess`; invitation emails in lower case; and rolling back the migration.
- `apps/api/tests/members.test.ts` covers invitations (the link and its hash, the role rules, an email with an account, inviting again, accepting with a deleted project dropped, a double submit, signing in after, every link that no longer works getting one message, revoking and renewing), members (the list, changing access within the role rules, a demoted admin's invitations revoked, removing and signing out, data kept, a removed admin's invitations gone), reset links (the role rules, one per user, the old password until used, sessions deleted, expiry), ownership (the password, the roles after), and the links' rate limit. It also forces the races the role checks guard against (a target promoted while an admin acts on them; an heir deleted during a handover), and checks that links outlive no right: a member's link dies when they are promoted, so it cannot take over the ownership; a removed or demoted admin's links and invitations die; a surviving link is refused at use; an invitation is refused when its inviter has lost the right; an admin cannot replace the owner's admin invitation; a handover revokes the old owner's admin invitations and limits password tries. `apps/api/tests/auth.test.ts` covers setup's confirmation, timezone, and email status.
- `apps/web/tests/browser/access.test.tsx` checks what the dashboard hides; `members.test.tsx` the Members page; `links.test.tsx` the invitation, reset, and setup pages.

## The dashboard

`GET /api/me` answers the user, the instance's name and timezone, their projects and areas, and their permissions. The dashboard reads it on each page (`useAccess`, `meQuery`):

- The project menu lists only the areas the user has, and the project's Settings only for the owner and admins. The workspace menu shows Settings only to the owner and admins.
- A page the user cannot open shows "You don't have access" (`NoAccess`). Each project route names what it needs (`staticData.access` in `router.tsx`), and `ProjectLayout` checks it.
- Opening a project, or the home page, goes to the project's overview when the user has one of its areas (uptime and alerts, errors, monitoring, web analytics, product analytics), and otherwise to the first area the user has, in the menu's order. The overview shows only the widgets of the user's areas ([dashboard](dashboard.md#overview)).
- The project list hides "New project" and allowed sites from members.
- The Settings page shows the instance's name and timezone, and the location data, to the owner, and the channels to the owner and admins. A member gets "You don't have access". The workspace menu's Members link, to `/settings/members`, shows to the owner and admins.
- Where one area's page links into another, the link shows only when the user has that area: an error's user, trace, and replay; a user's errors and replays; a replay's error and user; the alert rules on an error's page; "Add an alert rule" on the monitoring pages; links to the project's settings.
- Buttons that change something show only with manage: Resolve and Reopen; adding, editing, pausing, and deleting checks and rules (the rules' switches are disabled); saving, renaming, and deleting funnels; adding and deleting goals.

The API refuses all of these regardless. Hiding them only saves the user a refusal.

## Invitations

Code: `apps/api/src/access/invitations.ts` and `member-routes.ts`; `apps/web/src/features/settings/members-page.tsx` and `access-editor.tsx`; `apps/web/src/features/auth/invite-page.tsx`.

There is no email: Docker installs are not expected to have SMTP. The inviter copies a link and sends it.

- On the Members page (`/settings/members`), the owner or an admin enters an email address and picks a role (admin only for the owner) or a member's access (a preset, the areas, and the projects). They get a link to copy.
- The link carries a random 32-byte token in its fragment, `/invite#token=…`, as the setup link does. Only a SHA-256 hash of the token is stored (`dashboard_invitations`).
- The link works for 7 days. Pending invitations show on the Members page (email, access, who invited, expiry), where they can be revoked. "New link" replaces the token, since the plain token cannot be shown again.
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

`setUserAccess` (`apps/api/src/access/grants.ts`) is the one place that changes a user's role and grants, for the Members page and invitations. An admin keeps no grants rows. A member gets exactly the areas and projects given; "all projects" clears the project list; projects deleted meanwhile are dropped. So no old grant comes back when a role or access changes. It never changes the owner.

## Members

Code: `apps/api/src/access/members.ts` and `member-routes.ts`; `apps/web/src/features/settings/members-page.tsx`.

- The Members page lists everyone, the owner first: name, email, role or a summary of their access ("Member: Viewer, all projects"), and last sign-in (`dashboard_users.last_sign_in_at`, set on each sign-in). Each row has the actions the signed-in user may take on it: Change access, Reset link, Remove, and for the owner, Make owner.
- The owner and admins, within the role rules, change access and remove members, through `setUserAccess`. Nobody acts on themselves or on the owner there; an admin acts on members only, and makes no admins. Removing deletes the account and its sessions, and their pending invitations and the reset links they made; demoting an admin deletes both too. The only other column that names a dashboard user, `error_resolutions.resolved_by`, is set to null.
- Each change locks the target's row before checking their role, in one transaction, and deletes only a user whose role is still the one checked. So an admin cannot act on someone the owner is promoting at the same moment.
- The owner hands ownership to another user after entering their password again; the old owner becomes an admin. The owner cannot be removed and cannot demote themselves. The password may be tried 5 times, then once a minute, per user. The heir's row is locked first, and if promoting them changes nothing (they were deleted meanwhile), the whole handover rolls back, so the instance always has its owner.

## Password reset links

Code: `apps/api/src/access/password-resets.ts`, `apps/api/scripts/reset-password.ts`, `apps/web/src/features/auth/reset-password-page.tsx`.

- From the Members page, a one-time reset link for a user, within the role rules: admins reset members; the owner resets anyone else.
- A link outlives no right. Any change to a user's role or access (`setUserAccess`), and a handover for both users, deletes their pending reset link. A user's links go when they are removed or demoted. Using a link checks again, in its transaction: a link a user made works only while that user exists and may still reset the target as they are now. A link from the server's command is marked as such (`made_by_command`), and works for anyone.
- It works for 24 hours. A user has one at most (`dashboard_password_resets`, keyed by user): a new one replaces the old. Only a hash is stored.
- The `/reset-password#token=…` page asks for a new password and its confirmation. Using it sets the password with Better Auth's hash and deletes all that user's sessions. The old password works until then. The page then signs them in.
- For the owner, or any account, from the server: `vp run reset-password -- <email>` in development, `node dist/reset-password.mjs <email>` built. It prints a link that works for one hour.

## Owner setup

The setup command stays. The setup page has:

- a confirm-password field, checked in the browser and by the API;
- the timezone, chosen on the page, with the browser's preselected and checked as the settings page checks it. The `TIMEZONE` setting is gone; the instance is in UTC until setup;
- a line saying whether alert email (`SMTP_URL`) is set up, with a hint on how to set it when not (`GET /api/setup` answers `emailConfigured`). Nothing is sent.

## Known limits

- An error occurrence still shows the ID of the user it happened to, as text, to members without the users area. So do a replay's row and page. The links to the user's page are hidden, and the API refuses that page.
- A user's page lists the user's errors, as text, to members without the errors area; the links are hidden.
- An invitation or reset link is shown once, to whoever made it, and sent by them: anyone who sees it before it is used can use it. Links expire (7 days, 24 hours, or one hour from the command), and a new one replaces the old.
- The rule form's suggestions (services, routes, metrics, hosts) come from the monitoring routes. A member who manages alerts without monitoring gets no suggestions, and types the names.
- Deleting source maps needs errors at manage, but the dashboard shows source maps only on the project's settings page, which members do not see. Only the owner and admins can delete them from the dashboard.
- Deleting every replay of a project is a project setting (`projects`), beside the replay mode on the same card.
- The project's name and creation time are visible to any member granted it, whatever their areas.
- Traces, logs, and server exceptions carry the end user's ID when the app's OpenTelemetry attributes hold one (`user.id`, `enduser.id`). So members with monitoring, or errors, see those user IDs without the users area.
- `GET …/replays/list?userId=` lets a member with replays filter replays by an end user's ID, and so find whether that user has any, without the users area.

## Rolling back

Before migration 0006, every signed-in user could do everything. So its `down()` deletes every user but the owner, with their sessions: a member or admin left behind would get full access from the older code.
