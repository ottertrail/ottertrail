# Product analytics

What people do in an app, beyond which pages they open: the events a site sends, filtered by their properties, an ordered funnel, and a retention report. Part of stage 2 ([roadmap](roadmap.md)).

| Part                                         | Status  |
| -------------------------------------------- | ------- |
| Definitions                                  | Done    |
| Events, with property breakdowns and filters | Done    |
| One ordered funnel                           | Done    |
| One retention report                         | Done    |
| Saved goals and funnels                      | Planned |

## Definitions

The spec asks for these before any report: each report below counts by them.

**Product events** are the events a site sends itself: `window.ottertrail.track(name, properties)` in the browser, and [server-side events](web-analytics.md#server-side-events). The tracker's own events are not product events: `pageview`, `engagement` (time on page), `error` with an error's details, and `vitals`. (An `error` a site sent itself before errors existed, without details, stays a product event.) A funnel can still use a page as a step: a pageview of that path.

**Properties** are the flat details an event carries, at most 30, each a string up to 500 characters, a number, `true` or `false`, or `null` ([web analytics](web-analytics.md#the-request)). A filter compares one property with one value, as text: a string as it is, and a number, `true`, `false`, or `null` as JSON writes it (`3`, `true`). An event without the property never matches, even a filter for an empty value. Several filters must all hold.

**Who did it** is counted two ways:

- **Visitors:** the cookieless daily visitor ID ([web analytics](web-analytics.md#the-visitor-id)). It is the same for one browser and address within one day in the organization's timezone, and new the next day, by design. So a visitor is "one browser on one day": a person who comes back tomorrow counts again, and anything that needs the same person across days cannot use visitors.
- **Users:** the site's own ID for its signed-in user ([known users](web-analytics.md#known-users)), the same on every day and device. Only events sent while someone was signed in have one.

**Days and weeks** are the organization's: a day starts at midnight in its timezone, and a week on Monday, as ISO weeks do. Ranges are whole days, as on the analytics page.

**Late events:** the API accepts an event up to 24 hours after it happened, and reports place it when it happened (`occurred_at`), not when it arrived. So the last day of a report can still grow for a day, and a week for a day after it ends. Events reach the reports a few seconds after they arrive (the copy to ClickHouse).

**Environments:** every report reads one environment, production unless another is chosen, as the other pages do.

**Funnel:** two to five ordered steps, each an event name or a page path (up to 500 characters), with at most one property filter each. Two steps in a row must not be able to match the same event: the same page, or the same event name unless both filter one property by different values. One event would count for both, so such a funnel always converts; put another step between, such as a page. Someone reaches step _k_ if they did steps 1 to _k_ in that order, other events in between allowed, all within the conversion window that starts at their step 1; a step 1 in the report's range starts a funnel. Counted by visitors, the window can reach at most to the end of that visitor's day; counted by users, up to 30 days.

**Retention:** signed-in users only, since visitor IDs change daily. A user's cohort is the week of their first event in the environment, over all the time the project keeps. They are retained in week _n_ if they did anything themselves (any event but time on page and Web Vitals) in the _n_-th week after it. Week 0 is everyone, 100%; the current week is marked as not over.

## Events

Code: `apps/api/src/product/events.ts`. The product events of a range and environment, most frequent first (the top 100), each with its events, visitors, and users. One event adds its events per day and its properties: the 30 most frequent property names, each with its 10 most frequent values. Filters narrow all of it; one that matches nothing gives zeros, not an error.

Properties are stored as each event's JSON (`properties`), so a breakdown reads every event of the range with that name and splits its properties (`JSONExtractKeysAndValuesRaw`), once for names and values together. A property that is an ID, different on every event, makes that count as large as the event count. Fine for what a small team sends; a project with millions of one event a month will want the properties in columns of their own, not built.

## Funnel

Code: `apps/api/src/product/funnel.ts`. ClickHouse's `windowFunnel` follows each visitor or user through the steps: it finds the longest chain of steps in order, each within the window from that chain's step 1. The query reads events from the range's start to its end plus the window, so a funnel started near the end can finish, and only a step 1 inside the range starts one. A page step is a pageview of exactly that path; an event step is a product event of that name, with its property filter if it has one.

Choices: count by visitors (the default) or users, and a window of 5 or 30 minutes, 1 hour, 1 day (the default), or, for users, 7, 14, or 30 days. Visitors are refused longer windows: their IDs change at midnight, so a visitor's funnel ends with their day whatever the window says. A person counts once, at the furthest step they reached; times between steps are not shown yet. Two steps in the same millisecond count in either order.

## Retention

Code: `apps/api/src/product/retention.ts`. For each signed-in user: the Monday of the week of their first event in the environment (their cohort), and every week they did something themselves, any event but time on page and Web Vitals. The report shows the cohorts whose week holds a day of the range, the latest 13, each with up to 12 weeks after, until the current week, which is not over yet and so can only grow.

A user's first week is over all the time the project keeps, so a cohort leaves out users seen before it, even long ago: the query reads every signed-in event of the environment up to the last cohort's last shown week, after which nothing can change the table. A user's cohort can move later when retention deletes their first events.

```text
GET /api/projects/:id/events?period=7d&environment=production
GET /api/projects/:id/events/:name?period=7d&p.plan=team&p.seats=5
GET /api/projects/:id/funnel?period=7d&steps=[{"type":"page","path":"/pricing"},{"type":"event","name":"signup"}]&count=visitors&window=86400
GET /api/projects/:id/retention?period=90d
```

Like every project route, each runs the organization access check first.

## Not done yet

- Saved goals and funnels: a funnel lives in the page's address, which can be shared or bookmarked.
- Time between funnel steps, and who dropped off.
- Retention by a chosen event instead of any event, and by day or month.
- Property filters on the web analytics page, and other comparisons than "equals".
- A time limit for report queries, and stopping a query when the browser stops waiting: a long range on a large project runs to its end.
