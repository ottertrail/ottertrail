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

**Funnel:** two to eight ordered steps ([steps](#steps)). Someone reaches step _k_ if they did steps 1 to _k_ in that order, other events in between allowed, all within the conversion window that starts at their step 1; a step 1 in the report's range starts a funnel. Counted by visitors, the window can reach at most to the end of that visitor's day; counted by users, up to 30 days.

**Retention:** signed-in users only, since visitor IDs change daily. A user's cohort is the week of their first event in the environment, over all the time the project keeps. They are retained in week _n_ if they did anything themselves (any event but time on page and Web Vitals) in the _n_-th week after it. Week 0 is everyone, 100%; the current week is marked as not over.

## Steps

Code: `apps/api/src/product/steps.ts`, shared by funnels and goals. A step is a page or a product event.

- **A page:** a path of up to 500 characters, matched against a pageview's path, which is stored without its query or fragment. In a path, `*` matches any run of characters, none included, `/` included: `/docs/*` matches `/docs/`, `/docs/a`, and `/docs/a/b`, not `/docs`; `/*/settings` matches every page called settings one or more levels down. A path without `*` matches only itself. ClickHouse reads a pattern with `LIKE`, `\`, `%`, and `_` escaped so they stay literal, and a path without `*` with `=`. A literal `*` cannot be matched.
- **An event:** a product event's name, with at most one property filter. The filter compares the property's text (as in [Definitions](#definitions)) with a value: it equals it, it does not equal it (`"operator": "notEquals"`), or it contains it (`"operator": "contains"`). Not equals and contains are case-sensitive, as equals is. A filter without `operator` is equals, so steps saved or linked before operators existed mean what they did.
- **A missing property matches no filter, "not equals" included.** "plan does not equal free" means "has a plan, and it is not free": an event without a plan is not counted. This keeps one rule for every filter, and an event the site sent without the property is usually a different event.

```json
[
  { "type": "page", "path": "/docs/*" },
  {
    "type": "event",
    "name": "signup",
    "filter": { "key": "plan", "value": "free", "operator": "notEquals" }
  }
]
```

**Two steps in a row must not be able to match the same event.** `windowFunnel` would count that one event for both, so the funnel would always convert. The check is exact: it refuses two steps only when some event could match both, and the editor says so before asking, with the same rule (`features/product/funnel-steps.ts`).

- Two pages: two paths without `*` when they are the same; a pattern and a path when the pattern matches the path; two patterns when one's text before its first `*` starts the other's, or the other way round, and one's text after its last `*` ends the other's, or the other way round. The `*`s between can then take up the rest: `/a/*/b` and `/a/x*` both match `/a/x/b`; `/a/*/b` and `/a/x*/c` cannot both match anything.
- Two events of one name, filtered by one property: two equals only on the same value; equals and not equals only on different values; equals and contains when the value contains the text; every other pair can both match. Without a filter on either, or filtered by different properties, they can.
- A page and an event, or two events of different names, never match the same event.

Put another step between two that overlap, such as a page.

**Saved goals as steps:** the funnel editor's "Copy from a goal" menu on each step copies a saved goal's definition into the step. It is a copy, not a reference by ID: deleting the goal leaves the step, and a saved funnel, as they are.

## Goals

Code: `apps/api/src/goals/`. A goal is a named conversion a project saves: a page viewed, or a product event with an optional property filter, the same shape as a funnel step (`product/steps.ts`), checked and matched by the same rules ([steps](#steps)): a path may be a pattern such as `/docs/*`, and a filter may say "not equals" or "contains". `goals.filter_operator` holds the operator, null for equals. A project has at most 20, each with its own name. They live in PostgreSQL (`goals`); nothing about them is stored in ClickHouse, so a goal added today counts past events too, and deleting one loses only its definition.

The web analytics page counts them, in the same visits and filters as the rest of the page: for each goal, the **visitors** who reached it (daily visitor IDs, as the summary counts them), how many **times** it happened, and its **conversion rate**, those visitors as a share of the page's visitors. A filtered page counts the goals among its own visits only. So filtering the page by a source or campaign shows each goal's conversions from it: a goal event on the visit's third page counts under the source of its first. Counting by visitors means an event goal counts browser events only: an event from the site's server has no visitor.

```text
GET    /api/projects/:id/goals
POST   /api/projects/:id/goals           { "name": "Signed up", "step": { "type": "event", "name": "signup" } }
DELETE /api/projects/:id/goals/:goalId
```

The analytics answer carries them as `goals`, with their counts. A goal, or a custom event by name, can also be the page's goal filter (`goal=<id>`, `goalEvent=<name>`): it leaves the visits as they are and adds each list's converted visitors and rate ([web analytics](web-analytics.md#the-goal-filter)). Adding or deleting needs the dashboard's origin, as every change does; a name already taken or a 21st goal answers 409.

## Events

Code: `apps/api/src/product/events.ts`. The product events of a range and environment, most frequent first (the top 100), each with its events, visitors, and users. One event adds its events per day and its properties: the 30 most frequent property names, each with its 10 most frequent values. Filters narrow all of it; one that matches nothing gives zeros, not an error.

The list takes `search`: only the names that contain it, in any case (`positionCaseInsensitiveUTF8`), up to 200 characters without control characters, as a name may be. The top 100 are then the top 100 of those, so an event outside the top 100 can still be found.

**The period before:** the list and one event also count the same figures in the period before (`previous`), chosen as the funnel and the Web analytics summary choose it (`previousDays` in `reports/reports.ts`): the same number of days just before, in the instance's timezone, and while the period runs, only up to the same time of day. An event has no window, so the funnel's later cut-off (`previousReadEnd`) does not apply. Both periods come from one query: it reads from the period before's start to the period's end, `project_id` first, and counts each with `countIf` and `uniqExactIf` on the event's time, so the comparison costs one pass, not a second query per event. The list's answer has `previous: { firstDay, lastDay, until }` and each event its own `previous: { events, visitors, users }`; one event's `previous` holds both. An event only in the period before is not listed. The dashboard shows each figure's change in percent, "New" when the period before had none, and nothing when both periods count fewer than 20, as the funnel does.

There is no trend line per event in the list: the only small line the dashboard has is the Metrics page's, which loads one request per row; a line per event would need a second query by name and day, and the change already answers which events grew.

The event's page also counts it by the lists of the Analytics page (`GET /api/projects/:id/events/:name/breakdowns`, the same range and filters): its visit's source and campaign (see [Source and campaign](#source-and-campaign)), and its own country, region, city, device type, browser, operating system, and release, the columns every event has, named and written as on that page (`Munich, DE`). For each, the 10 values with the most visitors, `{ value, visitors, events }`, where `null` is no value (an event without a visit, no location) and a campaign of `""` a visit without one. One query reads the matching events once and counts each under every dimension (`ARRAY JOIN`). It is its own request, so the rest of the page does not wait for it.

**Its filters:** the event's page, and its lists, take the same names as filters (`source`, `utmCampaign`, `country`, `region`, `city`, `deviceType`, `browser`, `os`, `release`; at most 2,048 characters, no NUL), beside `p.<property>`; several must all hold. `""` is unknown, as on the Analytics page, except for `utmCampaign`, where it is a visit without a campaign. A filter by a source or campaign works out the visits of the visitors who sent the event, as the lists do; the others compare the event's own column. Both requests run within the dashboard's query limit.

Properties are stored as each event's JSON (`properties`), so a breakdown reads every event of the range with that name and splits its properties (`JSONExtractKeysAndValuesRaw`), once for names and values together. A property that is an ID, different on every event, makes that count as large as the event count. Fine for what a small team sends; a project with millions of one event a month will want the properties in columns of their own, not built.

## Source and campaign

Code: `apps/api/src/visits/visit-source.ts`. An event's own referrer is the page before it in the site, and its UTM tags are those of its own page, so a signup on a visit's second page would read as "Direct / none". Instead, an event is credited to its **visit's** source and campaign: those of the visit's first page, as the Analytics page counts a visit. Nothing is stored for it: the visits are worked out when the report runs, by the same code and rules as the Analytics page (`visitsSql`, [web analytics](web-analytics.md)), and the source is named by the same expression as its Sources list (`visitSourceSql`): `utm_source`, else the referrer's host without `www.`, else "Direct / none", with a referrer on one of the project's own hostnames counting as direct. The campaign is `utm_campaign`, and a visit without one is "No campaign", as on the Analytics page. The values match that page's lists for the same period and environment, so they can be checked against each other.

An event belongs to the visit of its visitor ID that started last at or before it, if the event came before that visit ended (an `ASOF LEFT JOIN` on visitor ID and time). An event without a visit has no source: a server's event without a visitor ID, an event counted by user on a device with no visit, or an error event (errors are not part of visits). Those count as Unknown.

Cost: working out visits sorts every event of the visitors involved, so the query reads only what it needs. It filters by project and environment first, then time, and works out the visits of only the visitor IDs that sent a counted event in the range (for a funnel, a step 1; for the Events page, that event with its filters). A visit lasts at most 25 hours, because visitor IDs change daily, so it reads those visitors' events from 50 hours before the range (25 hours for a visit that started before the range, 25 more to find where it started) to 25 hours after. Its memory grows with those visitors' events, not the project's. When step 1 is something almost every visitor does, such as viewing the home page, that is close to the whole Analytics page's visit count for the period. Both reports run through the dashboard's query limit (at most 300 MB and 15 seconds a query, `DASHBOARD_SETTINGS`), so a project too large for it gets an error, not a slow instance. Not measured on a large project yet: the development machine is too small for the benchmark in [storage-benchmark.md](storage-benchmark.md).

## Funnel

Code: `apps/api/src/product/funnel.ts`. ClickHouse's `windowFunnel` follows each visitor or user through the steps: it finds the longest chain of steps in order, each within the window from that chain's step 1. The query reads events from the range's start to its end plus the window, so a funnel started near the end can finish, and only a step 1 inside the range starts one. A page step is a pageview of exactly that path; an event step is a product event of that name, with its property filter if it has one.

Choices: count by visitors (the default) or users, and a window of 5 or 30 minutes, 1 hour, 1 day (the default), or, for users, 7, 14, or 30 days. Visitors are refused longer windows: their IDs change at midnight, so a visitor's funnel ends with their day whatever the window says. A person counts once, at the furthest step they reached. Two steps in the same millisecond count in either order.

The answer also counts the period before (`previous`: its days, `until`, and each step's `reached`), chosen as the Web analytics summary and the Overview choose it (`previousDays` in `reports/reports.ts`): the same number of days just before, in the instance's timezone, and while the period is still running, only up to the same time of day. Later steps of the period before are read only up to the moment that matches the period's own reading end (`previousReadEnd`): its end plus the window, or now if that comes first, moved back by the period's length. So a running period, whose later steps can only have happened up to now, compares with a period before whose later steps stop at the same point. The dashboard shows each count's change in percent and the overall conversion's in percentage points, and none when fewer than 20 people are counted in both periods, as the summary does.

### Breakdown

A funnel can be split by one dimension (`GET /api/projects/:id/funnel/breakdown`, the funnel's own parameters and `by`): step 1's visit's source or campaign (`source`, `utmCampaign`, see [Source and campaign](#source-and-campaign)), the device type, browser, operating system, country, or release, named as the Web analytics page names them (`deviceType`, `browser`, `os`, `country`, `release`), or, when step 1 is an event, a property of that event (`p.<name>`, checked as a step filter's name is: 1 to 100 characters, no NUL). Anything else answers 400. The names come from a fixed list in `funnel.ts` (`BREAKDOWN_NAMES`) and a property name goes to ClickHouse as a parameter, so `by` never becomes SQL.

Each person counts once, under the value on their first step 1 event in the range (`argMinIf` beside `windowFunnel`, in the same pass over the events), so the rows add up to the funnel. The answer is the five values with the most people at step 1 (ties by name), then Other for the rest of the values, then Unknown for no value (an unrecognized browser, no location, an event without the property, a step 1 without a visit): at most seven rows, `{ kind, value, reached[] }` each, whatever the dimension holds. A property is compared as text, as a step filter compares it. The query runs through the dashboard's query limit, like the saved funnels' results. There is no period before for a breakdown.

By source or campaign, each person counts under the visit of their first step 1 in the range, wherever in the visit it happened. A visit without a campaign is the value `""` ("No campaign"), not Unknown: Unknown is a step 1 without a visit, such as a server's event in a funnel that counts users. The medium is not offered, as the Analytics page has no list of it.

### Conversion over time

`GET /api/projects/:id/funnel/trend` (the funnel's own parameters) answers the overall conversion per day of each person's first step 1 in the range, in the instance's timezone, or per week (from Monday) when the period is longer than 60 days (`TREND_DAILY_DAYS`). Each point is `{ day, started, converted }`: the people whose first step 1 fell on that day or in that week, and how many of them reached the last step. It is one pass, the funnel's own query with `minIf(occurred_at, step 1 in the range)` beside `windowFunnel`, grouped by that day, so each person counts once and the points add up to the funnel. A day on which nobody did step 1 has no point, rather than a 0% one. The period bounds it: at most 366 days, so at most 366 points. It runs through the dashboard's query limit. The dashboard draws it under the result as a line, with gaps for the days without a point, and leaves it out for a single day.

### Time between steps

`GET /api/projects/:id/funnel/times` (the funnel's own parameters) answers, for each step after the first, the median and 75th percentile time from the step before (`between`, step 1 to 2 first), and from step 1 to the last step (`overall`), with how many people each is measured on, in seconds; `null` when nobody reached the step. Only the people who reached a step count for it.

`windowFunnel` gives only a person's furthest step, not when they did each one, so the same pass over the events also collects each person's matching events in time order and folds over them the way `windowFunnel` follows them (`arrayFold`): a new step 1 starts a new chain, a later step joins the chain at the step before while it is within the window of that chain's step 1, and the first chain to reach the last step ends the search. A step repeated in the same chain keeps its first time. Each person's times come from the chain at their furthest step, the level `windowFunnel` gives, so someone who repeats step 1 is measured from the latest step 1 that led on. The quantiles are exact (`quantilesExactInclusive`, interpolated between the two middle values). It reads what the funnel reads, filtered the same way, and runs through the dashboard's query limit.

### Who dropped off

For a funnel counted by users, `GET /api/projects/:id/funnel/people` (the funnel's parameters, `step`, and `outcome`) lists the users whose furthest step is `step`: `dropped` for steps 1 to _n_ - 1, those who did it and not the next; `converted` for the last step. Any other pairing, or a funnel of visitors, answers 400: a daily visitor ID is not a person anyone can look up. The list holds at most 100 user IDs, most recent first by the last time they did that step (step 1's inside the range), with `total`, the count of all of them, from the same query (`count() OVER ()`, before the `LIMIT`). It runs through the dashboard's query limit.

It shows user IDs, so it needs the `users` area as well as `product_analytics` ([access](access.md#each-routes-need)); without it the answer is 403, and the dashboard shows the counts without the lists.

### Each saved funnel's result

The saved funnels list shows each funnel's overall conversion, and the people at its first and last steps, for the page's period and environment. One request counts them all (`GET /api/projects/:id/funnels/results`): it reads the project's saved funnels from PostgreSQL and runs each one's funnel query through the dashboard's query limit (`telemetry/dashboard-limit.ts`), at most 2 at once for the request and 4 for the process. One request per funnel would have sent up to 50 at once, each with its own queries and no limit, and filled the browser's connections ahead of the rest of the page. The list's answer has no period before. Opening a saved funnel shows the list's counts at once, dimmed, until the funnel's own answer brings the comparison. A saved funnel whose stored steps no longer pass the checks gets no result. If the request fails, each row says so, with a Retry that asks again for all of them.

### Saved funnels

Code: `apps/api/src/funnels/`. A project can name a funnel to open it again: its steps, who it counts, and its window, checked by the same rules as the funnel report's, so a saved funnel is always one the report can count. The period and the environment are the page's, not the funnel's. A project has at most 50, each with its own name, listed by name. They live in PostgreSQL (`saved_funnels`), the steps as the report's JSON; nothing is stored in ClickHouse, so a funnel saved today counts past events too, and deleting one loses only its definition. Changing one replaces its name and definition together, and names the version it was read at (`updatedAt`): if the funnel was changed since, such as by someone else or in another tab, the change is refused (409 `funnel_changed`) rather than undoing theirs without a word. `updated_at` is kept in whole milliseconds, as JSON carries it, and moves forward with every change.

The funnel page's address still holds the steps, the count, and the window, so a link shows what was viewed even after the saved funnel changes; it also names the saved funnel it was opened from (`funnel=<id>`), so the page can tell when the shown funnel differs from it.

## Retention

Code: `apps/api/src/product/retention.ts`. For each signed-in user: the Monday of the week of their first event in the environment (their cohort), and every week they did something themselves, any event but time on page and Web Vitals. The report shows every cohort whose week holds a day of the range, at most 54 since a range is at most 366 days, each with up to 12 weeks after, until the current week, which is not over yet and so can only grow.

The period means "cohorts that started in this period". It is shared with the other tabs, which open on Last 7 days, and with one cohort a week, a period that short showed one or two rows and looked broken. So the Retention tab offers only periods of 4 weeks or more and opens on Last 90 days (about 13 cohorts); a shorter one from the address opens Last 90 days, and the picker says so. A cohort-count control was the other choice, but it would sit beside a period the page then ignored, so the picker and the table could disagree. Older cohorts are a longer period or a custom range away: the report no longer keeps only the latest 13, which hid cohorts the period named.

The answer also carries `average`, one entry per week offset: the retained users and the users of the cohorts whose week at that offset is over, summed. Summing weights each cohort by its size, so a small cohort cannot swing the average, and leaving out a week in progress keeps it from reading low, since its count can only grow. Week 0 counts too, so its average is 100% once any cohort has finished its first week. An offset no cohort has finished is `{ users: 0, retained: 0 }`.

When no cohort shows, the answer says whether the project has ever identified a user (`identifiesUsers`), so the page can tell setup from an empty period: `SELECT 1 FROM events WHERE project_id = … AND user_id IS NOT NULL LIMIT 1`, any environment, without `FINAL` since only existence matters. It filters by `project_id` first, the table's sort key, and stops at the first match; it runs only when the table is empty.

A user's first week is over all the time the project keeps, so a cohort leaves out users seen before it, even long ago: the query reads every signed-in event of the environment up to the last cohort's last shown week, after which nothing can change the table. A user's cohort can move later when retention deletes their first events.

```text
GET /api/projects/:id/events?period=7d&environment=production
GET /api/projects/:id/events/:name?period=7d&p.plan=team&p.seats=5
GET /api/projects/:id/funnel?period=7d&steps=[{"type":"page","path":"/pricing"},{"type":"event","name":"signup"}]&count=visitors&window=86400
GET /api/projects/:id/funnel/breakdown?(the funnel's parameters)&by=deviceType
GET /api/projects/:id/funnel/breakdown?(the funnel's parameters)&by=p.plan
GET /api/projects/:id/funnel/people?(the funnel's parameters, count=users)&step=2&outcome=dropped
GET /api/projects/:id/funnel/trend?(the funnel's parameters)
GET /api/projects/:id/funnel/times?(the funnel's parameters)
GET /api/projects/:id/retention?period=90d&environment=production

GET    /api/projects/:id/funnels
GET    /api/projects/:id/funnels/results?period=7d&environment=production
POST   /api/projects/:id/funnels             { "name": "Pricing to signup", "steps": [{"type":"page","path":"/pricing"},{"type":"event","name":"signup"}], "count": "visitors", "window": 3600 }
PUT    /api/projects/:id/funnels/:funnelId   (the same, and "updatedAt": the version it was read at)
DELETE /api/projects/:id/funnels/:funnelId
```

Like every project route, each runs the access check first. Saving, changing, or deleting a funnel also needs the dashboard's origin; a name already taken, a 51st funnel, or a change from an older version answers 409, and steps the report would refuse answer 400 with the report's own error.

## Not done yet

- Goals by signed-in user instead of visitor, and a goal's trend over time.
- Funnel order modes (strict, or any order) and excluded steps.
- Matching a literal `*` in a path, and case-insensitive filters.
- A distribution of the time between funnel steps, beyond the median and 75th percentile.
- A funnel's breakdown by more than one dimension, or by the visit's medium.
- Retention by a chosen event instead of any event, and by day or month.
- Property filters on the web analytics page, and other comparisons than "equals".
- A time limit for report queries, and stopping a query when the browser stops waiting: a long range on a large project runs to its end.
