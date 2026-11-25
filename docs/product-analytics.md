# Product analytics

What people do in an app, beyond which pages they open: the events a site sends, filtered by their properties, an ordered funnel, and a retention report. Part of stage 2 ([roadmap](roadmap.md)).

| Part                                         | Status |
| -------------------------------------------- | ------ |
| Definitions                                  | Done   |
| Events, with property breakdowns and filters | Done   |
| One ordered funnel                           | Done   |
| One retention report                         | Done   |
| Saved goals                                  | Done   |
| Saved funnels                                | Done   |
| A funnel's breakdown by one dimension        | Done   |
| Who dropped off, for signed-in users         | Done   |

## Definitions

The spec asks for these before any report: each report below counts by them.

**Product events** are the events a site sends itself: `window.ottertrail.track(name, properties)` in the browser, and [server-side events](web-analytics.md#server-side-events). The tracker's own events are not product events: `pageview`, `engagement` (time on page), `error` with an error's details, and `vitals`. (An `error` a site sent itself before errors existed, without details, stays a product event.) A funnel can still use a page as a step: a pageview of that path.

**Properties** are the flat details an event carries, at most 30, each a string up to 500 characters, a number, `true` or `false`, or `null` ([web analytics](web-analytics.md#the-request)). A filter compares one property with one value, as text: a string as it is, and a number, `true`, `false`, or `null` as JSON writes it (`3`, `true`). An event without the property never matches, even a filter for an empty value. Several filters must all hold.

**Who did it** is counted two ways:

- **Visitors:** the cookieless daily visitor ID ([web analytics](web-analytics.md#the-visitor-id)). It is the same for one browser and address within one day in the instance's timezone, and new the next day, by design. So a visitor is "one browser on one day": a person who comes back tomorrow counts again, and anything that needs the same person across days cannot use visitors.
- **Users:** the site's own ID for its signed-in user ([known users](web-analytics.md#known-users)), the same on every day and device. Only events sent while someone was signed in have one.

**Days and weeks** are the instance's: a day starts at midnight in its timezone, and a week on Monday, as ISO weeks do. Ranges are whole days, as on the analytics page.

**Late events:** the API accepts an event up to 24 hours after it happened, and reports place it when it happened (`occurred_at`), not when it arrived. So the last day of a report can still grow for a day, and a week for a day after it ends. Events reach the reports as soon as ClickHouse has written them, before the API answers.

**Environments:** every report reads one environment, production unless another is chosen, as the other pages do.

**Funnel:** two to five ordered steps, each an event name or a page path (up to 500 characters), with at most one property filter each. Two steps in a row must not be able to match the same event: the same page, or the same event name unless both filter one property by different values. One event would count for both, so such a funnel always converts; put another step between, such as a page. Someone reaches step _k_ if they did steps 1 to _k_ in that order, other events in between allowed, all within the conversion window that starts at their step 1; a step 1 in the report's range starts a funnel. Counted by visitors, the window can reach at most to the end of that visitor's day; counted by users, up to 30 days.

**Retention:** signed-in users only, since visitor IDs change daily. A user's cohort is the week of their first event in the environment, over all the time the project keeps. They are retained in week _n_ if they did anything themselves (any event but time on page and Web Vitals) in the _n_-th week after it. Week 0 is everyone, 100%; the current week is marked as not over.

## Goals

Code: `apps/api/src/goals/`. A goal is a named conversion a project saves: a page viewed, or a product event with an optional property filter, the same shape as a funnel step (`product/steps.ts`), checked by the same rules. A project has at most 20, each with its own name. They live in PostgreSQL (`goals`); nothing about them is stored in ClickHouse, so a goal added today counts past events too, and deleting one loses only its definition.

The web analytics page counts them, in the same visits and filters as the rest of the page: for each goal, the **visitors** who reached it (daily visitor IDs, as the summary counts them), how many **times** it happened, and its **conversion rate**, those visitors as a share of the page's visitors. A filtered page counts the goals among its own visits only. Counting by visitors means an event goal counts browser events only: an event from the site's server has no visitor.

```text
GET    /api/projects/:id/goals
POST   /api/projects/:id/goals           { "name": "Signed up", "step": { "type": "event", "name": "signup" } }
DELETE /api/projects/:id/goals/:goalId
```

The analytics answer carries them as `goals`, with their counts. Adding or deleting needs the dashboard's origin, as every change does; a name already taken or a 21st goal answers 409.

## Events

Code: `apps/api/src/product/events.ts`. The product events of a range and environment, most frequent first (the top 100), each with its events, visitors, and users. One event adds its events per day and its properties: the 30 most frequent property names, each with its 10 most frequent values. Filters narrow all of it; one that matches nothing gives zeros, not an error.

Properties are stored as each event's JSON (`properties`), so a breakdown reads every event of the range with that name and splits its properties (`JSONExtractKeysAndValuesRaw`), once for names and values together. A property that is an ID, different on every event, makes that count as large as the event count. Fine for what a small team sends; a project with millions of one event a month will want the properties in columns of their own, not built.

## Funnel

Code: `apps/api/src/product/funnel.ts`. ClickHouse's `windowFunnel` follows each visitor or user through the steps: it finds the longest chain of steps in order, each within the window from that chain's step 1. The query reads events from the range's start to its end plus the window, so a funnel started near the end can finish, and only a step 1 inside the range starts one. A page step is a pageview of exactly that path; an event step is a product event of that name, with its property filter if it has one.

Choices: count by visitors (the default) or users, and a window of 5 or 30 minutes, 1 hour, 1 day (the default), or, for users, 7, 14, or 30 days. Visitors are refused longer windows: their IDs change at midnight, so a visitor's funnel ends with their day whatever the window says. A person counts once, at the furthest step they reached; times between steps are not shown yet. Two steps in the same millisecond count in either order.

The answer also counts the period before (`previous`: its days, `until`, and each step's `reached`), chosen as the Web analytics summary and the Overview choose it (`previousDays` in `reports/reports.ts`): the same number of days just before, in the instance's timezone, and while the period is still running, only up to the same time of day. Later steps of the period before are read only up to the moment that matches the period's own reading end (`previousReadEnd`): its end plus the window, or now if that comes first, moved back by the period's length. So a running period, whose later steps can only have happened up to now, compares with a period before whose later steps stop at the same point. The dashboard shows each count's change in percent and the overall conversion's in percentage points, and none when fewer than 20 people are counted in both periods, as the summary does.

### Breakdown

A funnel can be split by one dimension (`GET /api/projects/:id/funnel/breakdown`, the funnel's own parameters and `by`): the device type, browser, operating system, country, or release, named as the Web analytics page names them (`deviceType`, `browser`, `os`, `country`, `release`), or, when step 1 is an event, a property of that event (`p.<name>`, checked as a step filter's name is: 1 to 100 characters, no NUL). Anything else answers 400. The columns come from a fixed list in `funnel.ts` (`BREAKDOWN_COLUMNS`) and a property name goes to ClickHouse as a parameter, so `by` never becomes SQL.

Each person counts once, under the value on their first step 1 event in the range (`argMinIf` beside `windowFunnel`, in the same pass over the events), so the rows add up to the funnel. The answer is the five values with the most people at step 1 (ties by name), then Other for the rest of the values, then Unknown for no value (an unrecognized browser, no location, an event without the property): at most seven rows, `{ kind, value, reached[] }` each, whatever the dimension holds. A property is compared as text, as a step filter compares it. The query runs through the dashboard's query limit, like the saved funnels' results. There is no period before for a breakdown.

The visit's source and campaign are not offered: an event's own referrer is the page before it in the site, and its UTM tags those of its own page, so on a step 1 that is not the visit's first page they would read as "Direct". Splitting by them needs the visit's first event, not built.

### Who dropped off

For a funnel counted by users, `GET /api/projects/:id/funnel/people` (the funnel's parameters, `step`, and `outcome`) lists the users whose furthest step is `step`: `dropped` for steps 1 to _n_ - 1, those who did it and not the next; `converted` for the last step. Any other pairing, or a funnel of visitors, answers 400: a daily visitor ID is not a person anyone can look up. The list holds at most 100 user IDs, most recent first by the last time they did that step (step 1's inside the range), with `total`, the count of all of them, from the same query (`count() OVER ()`, before the `LIMIT`). It runs through the dashboard's query limit.

It shows user IDs, so it needs the `users` area as well as `product_analytics` ([access](access.md#each-routes-need)); without it the answer is 403, and the dashboard shows the counts without the lists.

### Each saved funnel's result

The saved funnels list shows each funnel's overall conversion, and the people at its first and last steps, for the page's period and environment. One request counts them all (`GET /api/projects/:id/funnels/results`): it reads the project's saved funnels from PostgreSQL and runs each one's funnel query through the dashboard's query limit (`telemetry/dashboard-limit.ts`), at most 2 at once for the request and 4 for the process. One request per funnel would have sent up to 50 at once, each with its own queries and no limit, and filled the browser's connections ahead of the rest of the page. The list's answer has no period before. Opening a saved funnel shows the list's counts at once, dimmed, until the funnel's own answer brings the comparison. A saved funnel whose stored steps no longer pass the checks gets no result. If the request fails, each row says so, with a Retry that asks again for all of them.

### Saved funnels

Code: `apps/api/src/funnels/`. A project can name a funnel to open it again: its steps, who it counts, and its window, checked by the same rules as the funnel report's, so a saved funnel is always one the report can count. The period and the environment are the page's, not the funnel's. A project has at most 50, each with its own name, listed by name. They live in PostgreSQL (`saved_funnels`), the steps as the report's JSON; nothing is stored in ClickHouse, so a funnel saved today counts past events too, and deleting one loses only its definition. Changing one replaces its name and definition together, and names the version it was read at (`updatedAt`): if the funnel was changed since, such as by someone else or in another tab, the change is refused (409 `funnel_changed`) rather than undoing theirs without a word. `updated_at` is kept in whole milliseconds, as JSON carries it, and moves forward with every change.

The funnel page's address still holds the steps, the count, and the window, so a link shows what was viewed even after the saved funnel changes; it also names the saved funnel it was opened from (`funnel=<id>`), so the page can tell when the shown funnel differs from it.

## Retention

Code: `apps/api/src/product/retention.ts`. For each signed-in user: the Monday of the week of their first event in the environment (their cohort), and every week they did something themselves, any event but time on page and Web Vitals. The report shows the cohorts whose week holds a day of the range, the latest 13, each with up to 12 weeks after, until the current week, which is not over yet and so can only grow.

A user's first week is over all the time the project keeps, so a cohort leaves out users seen before it, even long ago: the query reads every signed-in event of the environment up to the last cohort's last shown week, after which nothing can change the table. A user's cohort can move later when retention deletes their first events.

```text
GET /api/projects/:id/events?period=7d&environment=production
GET /api/projects/:id/events/:name?period=7d&p.plan=team&p.seats=5
GET /api/projects/:id/funnel?period=7d&steps=[{"type":"page","path":"/pricing"},{"type":"event","name":"signup"}]&count=visitors&window=86400
GET /api/projects/:id/funnel/breakdown?(the funnel's parameters)&by=deviceType
GET /api/projects/:id/funnel/breakdown?(the funnel's parameters)&by=p.plan
GET /api/projects/:id/funnel/people?(the funnel's parameters, count=users)&step=2&outcome=dropped
GET /api/projects/:id/retention?period=90d

GET    /api/projects/:id/funnels
GET    /api/projects/:id/funnels/results?period=7d&environment=production
POST   /api/projects/:id/funnels             { "name": "Pricing to signup", "steps": [{"type":"page","path":"/pricing"},{"type":"event","name":"signup"}], "count": "visitors", "window": 3600 }
PUT    /api/projects/:id/funnels/:funnelId   (the same, and "updatedAt": the version it was read at)
DELETE /api/projects/:id/funnels/:funnelId
```

Like every project route, each runs the access check first. Saving, changing, or deleting a funnel also needs the dashboard's origin; a name already taken, a 51st funnel, or a change from an older version answers 409, and steps the report would refuse answer 400 with the report's own error.

## Not done yet

- Goals by signed-in user instead of visitor, and a goal's trend over time.
- Time between funnel steps.
- A funnel's breakdown by the visit's source or campaign, and by more than one dimension.
- Retention by a chosen event instead of any event, and by day or month.
- Property filters on the web analytics page, and other comparisons than "equals".
- A time limit for report queries, and stopping a query when the browser stops waiting: a long range on a large project runs to its end.
