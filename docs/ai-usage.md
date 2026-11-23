# AI usage tracking

**Status: phase 1 is built: detection and storage of AI calls, the price table, the report API, the AI cost and failures alert rule kinds, the AI page (`/projects/<id>/ai`, [dashboard](dashboard.md#ai)), the alert form for the new kinds ([dashboard](dashboard.md#813-alerts)), and the instance's own prices in Settings → AI models ([below](#prices)). From phase 2, `POST /api/ai-calls` for apps without OpenTelemetry ([below](#sending-calls-over-http)), the `ai_latency` rule kind, the Overview's AI cost widget ([below](#the-overviews-ai-cost-widget)), the list of calls in the Workbench pattern, conversations grouped by `gen_ai.conversation.id` ([below](#the-calls-list)), and a user's AI usage on the user's page ([below](#a-users-ai-usage)) are built. The docs site explains it at `/monitoring/ai-usage/`.**

An app that calls language models pays per token, and its calls fail, stall, and get cut off in ways its other requests do not. This module shows the LLM calls an app makes: tokens, estimated cost, latency, and failures, per model, per feature, and per user, with the trace of each call one click away. It reads the spans the app already sends over OTLP ([telemetry](telemetry.md)), or calls its server sends over HTTP; nothing of Ottertrail's runs in the app.

## Decisions

Made on 22 November 2026, all as the design proposed:

1. **AI calls get their own ClickHouse table**, `ai_calls`, written beside the spans and kept as long as the project's events, not the 30 days of spans. Cost questions are asked by the month and the year, and a row is small next to the spans around it: each one is a paid API call.
2. **Prompts and completions are never stored.** They are dropped at ingestion for every project, AI page or not ([telemetry](telemetry.md#ai-prompts-and-completions-are-not-stored), `apps/api/src/telemetry/ai-content.ts`). This module reads only token counts and names.
3. **Prices come from a small hand-kept table in the repository** (`apps/api/src/ai/price-table.ts`), read from the providers' own price pages, each entry with its source and the day it was checked, updated each release. The owner and admins set the instance's own prices over it in Settings → AI models ([Prices](#prices)). Prices are never fetched at run time: self-hosted instances must work offline.
4. **A call's feature** is its `ottertrail.feature` attribute, else `gen_ai.agent.name`, else none ("Unlabeled").
5. **Access:** the `ai` area at view, apart from monitoring ([access](access.md)). It shows AI calls, including the calling service's name and the trace ID as text; traces, logs, metrics, and the other services need `monitoring`. The breakdown by user, and the user of each call, also need `users` at view; a call's link to its trace needs `monitoring` at view.

## Detection

When the traces route has normalized a request's spans (`apps/api/src/ai/calls.ts`), each stored span is an AI call if:

- its `gen_ai.operation.name` is an inference or embeddings operation: `chat`, `generate_content`, `text_completion`, `realtime_inference`, or `embeddings`;
- or, whatever else its operation name is (none, empty, or one the conventions do not list), it has `gen_ai.system` or `gen_ai.provider.name` and an input or output token count, as older senders' spans do;
- but never when its operation is one that is not a model call: `invoke_agent`, `create_agent`, `invoke_workflow`, `execute_tool`, `plan`, or `retrieval`.

Those spans are not calls, whatever tokens they carry: an agent's span repeats the tokens of the model calls inside it, which are counted on their own ([OpenTelemetry's guidance](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-token-metrics.md)). It still shows in its trace. A refused span makes no call.

Each value is read from the first of its names the span has, so the current names and the older ones instrumentations still send both work:

| Value               | Names read, in order                                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Provider            | `gen_ai.provider.name`, `gen_ai.system`                                                                                           |
| Model               | `gen_ai.response.model`, `gen_ai.request.model`                                                                                   |
| Operation           | `gen_ai.operation.name` ("" when absent)                                                                                          |
| Input tokens        | `gen_ai.usage.input_tokens`, `gen_ai.usage.prompt_tokens`, `llm.token_count.prompt`                                               |
| Output tokens       | `gen_ai.usage.output_tokens`, `gen_ai.usage.completion_tokens`, `llm.token_count.completion`                                      |
| Cache read tokens   | `gen_ai.usage.cache_read.input_tokens`, `llm.token_count.prompt_details.cache_read`                                               |
| Cache write tokens  | `gen_ai.usage.cache_write.input_tokens`, `gen_ai.usage.cache_creation.input_tokens`, `llm.token_count.prompt_details.cache_write` |
| Reasoning tokens    | `gen_ai.usage.reasoning.output_tokens`                                                                                            |
| Finish reasons      | `gen_ai.response.finish_reasons` (a list, or one reason), in lower case                                                           |
| Time to first chunk | `gen_ai.response.time_to_first_chunk`, in seconds                                                                                 |
| Error               | `error.type`; the call failed if it has one or its span's status is Error                                                         |
| Feature             | `ottertrail.feature`, else `gen_ai.agent.name`                                                                                    |
| User                | `user.id`, else `enduser.id`, by the rule error events use: 1 to 200 characters, no control characters                            |
| Conversation        | `gen_ai.conversation.id`, trimmed: 1 to 200 characters, no control characters                                                     |

The user is the ID the tracker's `data-user-id` sends, so a call links to the Users page ([known users](web-analytics.md#known-users)).

### Limits

- **Names:** the model, provider, operation, and feature lose control characters, are trimmed, and are cut to 100 characters; `error.type` to 200; at most 16 finish reasons of 64 characters.
- **Conversation ID:** trimmed; one longer than 200 characters or with a control character is none, never cut, so two conversations cannot become one. It is an ID the app chooses: nothing else of the messages is read.
- **Token counts:** a whole number from 0 to 10^9. Anything else (negative, fractional, larger) is left out of that call, as 0, and the call is kept; the batch never fails for it.
- **Lists:** a breakdown lists the 2,000 models and the 500 features with the most calls in the period; the rest are one "Other" row. The chart splits into the 10 that cost the most, and "Other".
- **Budget:** each AI call costs one more unit of the project's telemetry budget, as an exception that becomes an error event does ([telemetry](telemetry.md#limits)), but never makes a request too large: a request is refused as too large (413, which exporters drop) only when it costs more than the whole budget without its AI calls, and one that the calls take past it costs the whole budget, waiting for it with a 429 that exporters retry. A 503 gives all of it back.

## Storage

`ai_calls` (migration `0008_ai_calls`): project, start time, `id` (the trace and span IDs, the span's own row ID; a call sent over HTTP, its UUID), trace and span IDs, service, environment, release, provider, model, operation, feature, user, the five token counts, duration, time to first chunk, failed, `error.type`, and finish reasons. Migration `0009_ai_calls_conversation` adds `conversation_id` ("" for none), with a bloom filter index that finds one conversation's calls in a period; older rows read "". Migration `0011_received_at` adds `received_at`, when the API received the request that brought the call (its clock, as events have it; older rows read 1970), and `input_includes_cache`, whether the input count holds the cached tokens ([Cost](#cost); older rows take what the cost assumed before, input at least the cached tokens).

- `ReplacingMergeTree`, `PARTITION BY toYYYYMM(timestamp)`, `ORDER BY (project_id, toDate(timestamp), id)` (migration `0012_ai_calls_by_day`, which made the table again and copied its rows; until then it was ordered by the exact time): every query filters by project first, then a period. The key holds the day, not the time, as events' does ([ClickHouse](clickhouse.md#each-event-once)): a retried batch makes the same IDs, so it is the same rows, and a call sent over HTTP again with a corrected time is the same row too, unless its two times fall either side of midnight UTC ([below](#retries)). `FINAL` keeps the copy written last. With `FINAL`, ClickHouse picks the granules by the key's day and applies a condition on the exact time only after merging the copies, so a period's edge cannot split one call into two.
- **Written beside the span**, exactly as exception-derived error events are: the route writes the spans, the error events, and the AI calls before it answers 200 (asynchronous inserts, waiting for the write); if any insert fails, the budget is given back and the answer is 503, and the exporter's retry writes them all again.
- **Kept as long as the project's events** ("Keep events" on the project, forever by default): retention deletes a project's AI calls older than its cut-off with its events (`deleteEventsBefore` in `apps/api/src/clickhouse/delete-events.ts`). No TTL.
- **Deleted with the project,** found by the orphan sweep, and taken off the disk by `APPLY DELETED MASK`, as every other table ([ClickHouse](clickhouse.md#retention-and-deleting-a-project)). ClickHouse's backup covers it: `BACKUP DATABASE` takes every table.
- **Forced merges** as the telemetry tables have them: a partition's parts are merged into one once all are an hour old. Inserts return once on disk, as events' do.
- **Cost is not stored.** It is worked out when calls are read (below), so a corrected price applies to past calls.

## Cost

`apps/api/src/ai/prices.ts` holds the matching and the arithmetic; `price-table.ts` the prices.

- **Which price:** the instance's own price for the call's model with the latest start at or before the call's time; else, when the model matches a bundled entry, the instance's price on any of that entry's IDs (a price on `gpt-4o` covers `gpt-4o-2024-08-06` too); else the entry's bundled price; else, for a model priced as another, that model's price at the call's time, by the same steps; else none ([Prices](#prices)).
- **Matching in the bundled table:** by model ID, in any case, whatever provider sent it: first an exact ID or documented alias, then the longest listed prefix. The response model is matched first (`claude-sonnet-4-6`, `gpt-4o-2024-08-06`, `us.anthropic.claude-sonnet-4-6`), as each call names it.
- **Arithmetic,** per call, then added up: cache reads at the cache read price, cache writes at the cache write price, the rest of the input at the input price, and the output (reasoning included, as the conventions count it) at the output price. A provider with no separate cache price charges cached tokens as input. The rest of the input depends on how the call counted it, which each call stores (`input_includes_cache`, `apps/api/src/ai/calls.ts`): the input less both cache counts when the input holds them, else all of the input. An input smaller than its cached tokens never holds them. `costOf` in JavaScript and `pricedColumns` in ClickHouse take the same rule, and `ai-report.test.ts` checks they agree.
- **Whether the input holds the cached tokens:**
  - A span: yes, as the GenAI conventions say: `gen_ai.usage.input_tokens` "SHOULD include cached tokens", and the cache read and write counts "SHOULD be included in" it ([attribute registry](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/registry/attributes/gen-ai.md), checked on 22 November 2026). OpenLLMetry's Anthropic instrumentation follows this: it adds `cache_read_input_tokens` and `cache_creation_input_tokens` to Anthropic's `input_tokens` ([its code](https://github.com/traceloop/openllmetry/blob/main/packages/opentelemetry-instrumentation-anthropic/opentelemetry/instrumentation/anthropic/__init__.py)).
  - A call sent over HTTP: what its `inputIncludesCache` says; without it, by its provider's API. Anthropic's API counts cached tokens apart (`input_tokens` beside `cache_read_input_tokens` and `cache_creation_input_tokens`), and so does Claude on Vertex AI, which answers in Anthropic's form (`provider` `gcp.vertex_ai` with a model ID containing `claude`). Amazon Bedrock's Converse API too: its `inputTokens` "represents only the non-cached input tokens" ([Bedrock's prompt caching](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html)), except for OpenAI's models there (a model ID containing `openai.`), whose Responses API counts them in. OpenAI's API (`prompt_tokens` holds `prompt_tokens_details.cached_tokens`), Gemini's, and every other provider: counted in.
  - Before 22 November 2026 the cost took any input at least as large as the cached tokens as holding them, which priced Anthropic's counts too low whenever uncached input outnumbered cached (1,000 uncached and 500 cached tokens at $3 and $0.30 a million came to $0.00165 instead of $0.00315).
- **Input tokens added up** (the report's totals, breakdowns, users, and chart; the Overview's widget, a user's section, and the calls list's conversations) are all of the input, cached tokens included, however each call counted them (`all_input_tokens` in `pricedColumns`): a call that counts them apart adds its cache reads and writes to its input, so a period that mixes providers adds up one kind of count. A single call shows its counts as sent.
- **The cache-read share** is cache reads out of that input, so it is at most 1.
- **In ClickHouse:** the prices go into each query as array parameters, never as SQL text: the bundled IDs, prefixes longest first, and every price as a numbered slot (the bundled entries, then each custom row). A row's bundled entry is found with `indexOf` and `arrayFirstIndex`. A model with custom rows, and a bundled entry with custom rows on its IDs, each have a timeline worked out in JavaScript (`priceBookOf` in `prices.ts`): the moments the price may change (the rows' starts, and those of the entry and of the model it is priced as), each with the slot that applies from then; a call finds its model with one `indexOf` over those models, else its entry with one `indexOf` over those entries, and its slot with one `arrayCount` over that short array. Model IDs are lower-cased with `lowerUTF8` in ClickHouse and `toLowerCase` in JavaScript: the same for ASCII and most letters; the few whose case mapping depends on the language or changes the length (such as `İ` or `ẞ`) can differ, so a custom price on such an ID may not match its calls. Nothing is fetched or joined. `priceAt` works out the same in JavaScript, and `ai-models.test.ts` checks the two agree.
- **No price:** a model the table lacks counts its tokens but no cost. The totals count those calls (`noPriceCalls`) and name up to 20 of the models, so the page can say what its cost leaves out.

### The price table

Checked on 22 November 2026, standard pay-as-you-go prices in US dollars per million tokens: no batch, flex, or priority prices. 130 entries:

| Provider      | Models                                                                                                                                                                                                                                      | Source                                                                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI        | GPT-6.x (Astra, Sol, Terra, Luna), GPT-5.6, GPT-5.5 and Pro, GPT-5.4 (mini, nano, Pro), GPT-5.2 and Pro, GPT-5.1, GPT-5 (mini, nano, Pro), GPT-4.1 and mini, GPT-4o and mini, o3 and o3-pro, chat-latest, text-embedding-3-small and -large | https://developers.openai.com/api/docs/pricing; the embedding models' own pages                                                                                                                                                       |
| Anthropic     | Fable and Mythos 5.2, 5.1, 5; Opus 5.5, 5, 4.8, 4.7, 4.6, 4.5, 4.1, 4; Sonnet 5.5, 5, 4.6, 4.5, 4; Haiku 5.5, 4.5                                                                                                                           | https://platform.claude.com/docs/en/about-claude/pricing                                                                                                                                                                              |
| Google Gemini | Gemini 4 (Carbon, Argon, Neon, Hydrogen), 3.8 Flash, 3.6 Flash, 3.5 Flash-Lite, 3.1 Flash-Lite, 3.1 Pro Preview, 3 Flash Preview, 2.5 Pro, Flash, and Flash-Lite, Gemini Embedding 2 and 001                                                | https://ai.google.dev/gemini-api/docs/pricing                                                                                                                                                                                         |
| Mistral       | Mistral Large 4, Small 4, Ministral 3 (14B, 8B, 3B), Codestral, Voxtral Small, Codestral Embed, Mistral Embed, and the GLM 5.3 and DeepSeek V4.1 Flash models Mistral serves                                                                | https://docs.mistral.ai/inference/pricing                                                                                                                                                                                             |
| AWS Bedrock   | The Claude models above by their Bedrock IDs, regional and geo (`us.`, `eu.`, `au.`, `jp.`, `in.`, `ca.`) apart from global (`global.`); Mistral's Bedrock models; gpt-oss                                                                  | AWS's Price List API, us-east-1, on demand: https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/us-east-1/index.json (Claude) and …/AmazonBedrock/current/us-east-1/index.json (the others) |

Left out because the price or the ID could not be confirmed on the provider's own pages: models already shut down, models priced by image, audio, or minute rather than text tokens, gated variants, `gemini-flash-latest` (it moves), Mistral Medium (only on its deprecation list), Claude models AWS lists as end of life, and Google Cloud's `@` IDs for Opus 4.1, Opus 4, and Sonnet 4. Each entry's `notes` says what its prices leave out, such as a higher price past a prompt length or a price change already announced.

To update it: read each source again, change the numbers and `checked`, and add new models with their IDs as the provider's model page names them. Never add a price from memory or from a third-party list.

### Prices

Settings → AI models (`?tab=ai-models`, [dashboard](dashboard.md#ai-models)), for the owner and admins (`projects`). The bundled table matches model IDs exactly, then by the longest listed prefix, and its prices change; negotiated discounts, regional prices, and self-hosted models cannot be in it. So the instance keeps prices of its own, in US dollars per million tokens (USD only), in PostgreSQL's `ai_model_prices` (migration `0019_ai_model_prices`; `apps/api/src/ai/custom-prices.ts`):

- **A row** names a provider and a model ID in lower case (matched exactly, as calls are read; a row on an ID of a bundled entry covers every call of the entry, below the calls' own rows), `effective_from` (a moment, or null for all calls), and either the four prices (`numeric`, 0 to 10,000, at most 6 decimals; a null cache price is charged as input) or `price_as` (another model, for all calls), never both. Unique on (model, `effective_from`), nulls not distinct; `created_by`, `updated_by`, and their times.
- **Edit price** sets the four prices either from a day on (midnight in the instance's timezone; a real price change: calls before it keep the earlier price), replacing a row from the same day, or for all calls (a correction), replacing every row of the model: the model's sheet names the dated prices and the price as it replaces. At most 100 rows per model and 1,000 in all (409 past them).
- **Price as** points a model the table lacks (a dated snapshot) at another model's price, resolved at read time at the call's time, one level deep only: a model priced as another cannot be a target, and a model others are priced as cannot be priced as one. A model with a bundled price cannot be priced as another (its own price would win). A model's own dated prices win over its price as from their day.
- **Add model** is Edit price for a model the list lacks, such as a self-hosted one at $0. **Reset to built-in** deletes every row of the model, after a confirm; it is refused (409, naming them) while other models are priced as it.
- **Kept hours:** every change blanks the AI cost rules' `ai_cost_windows.settings_key` in the same transaction, so each rule's next evaluation adds its hours up again at the new prices; the hours are not deleted, so an evaluation running meanwhile stays consistent at the old prices. The price book's fingerprint (a hash of the bundled table and, of each custom row, the model, start, prices, and price as) is part of the key too, so that evaluation's own write is added up again at the next run, and so is a row changed past the routes.
- **Reads:** each report request and each cost rule's evaluation reads the rows (a small PostgreSQL query) into a price book.

```text
GET  /api/settings/ai-models            every model with calls in the last 30 days across the instance's projects, every bundled entry (its first ID), and every model with rows
PUT  /api/settings/ai-models/price      { provider, model, effectiveFrom: "YYYY-MM-DD" | null, input, output, cacheRead, cacheWrite }
PUT  /api/settings/ai-models/price-as   { provider, model, priceAs: { provider, model } }
POST /api/settings/ai-models/reset      { model }
```

Each needs `projects` (`requirePermission`), and the changes the dashboard's `Origin`; bodies are checked by schema before any database work, and changes are limited to 30 per user, then one every 10 seconds (`DEFAULT_AI_MODEL_CHANGE_LIMIT` in `model-routes.ts`). The list's ClickHouse query filters by `project_id IN` the instance's projects first, groups by model in lower case, and lists at most 2,000 models (when ClickHouse cannot answer, the list still answers, with `callsCounted: false` and each `calls` null, so prices stay editable); each row carries its price now and its source (`built_in`, `custom`, `price_as`, or none), the bundled price with the day it was checked, the custom prices with who changed them and when, and the price as. The table is deployment-wide customer data, an intended exception to CLAUDE.md's rule against adding any: it is instance settings, like `instance_settings`, and moves to an organization with the other instance settings ([multi-tenancy](multi-tenancy.md#two-levels-of-settings)). No row names another row: `price_as` names a model.

## The report

Three project routes (`apps/api/src/ai/routes.ts`, queries in `apps/api/src/ai/report.ts`), each behind `requireProjectAccess` for `ai` at view:

```text
GET /api/projects/:id/ai?period=7d|from=…&to=…&environment=…&service=…&provider=…&model=…&feature=…&user=…
GET /api/projects/:id/ai/chart?…the same…&split=model|feature
GET /api/projects/:id/ai/calls?…the same…
```

- **Period:** as the other reports: `period` (`today`, `7d`, `30d`, `90d`, `12m`) or `from` and `to`, days in the instance's timezone, at most 366. Not cut to the 30 days of spans: AI calls are kept as long as events.
- **Filters:** each exactly as stored; `feature=` (empty) is the calls with no feature. `environment` is `production` when left out. `user` is one end user's calls (`user_id`), validated as user IDs are everywhere (1 to 200 characters, no control characters); it needs `users` at view as well, and without it the request is refused with 403, as an alert rule of another area is, rather than answered for everyone. `received` stays the project's, whatever the filters.
- **Totals** (`totals`): estimated cost, calls, the token counts, the cache-read share of the input, the 95th-percentile duration, the failed calls and share, and the calls of models without a price. `previous` holds the same totals for the period before, counted as the other reports count it (`previousDays`: as many days right before, up to the same moment when the period is still running), so the page shows the change.
- **By model** (`models`) and **by feature** (`features`): calls, tokens, cost, the median and 95th-percentile duration, the median time to the first chunk, the failed share, and the share cut off at the token limit (finish reason `length` or `max_tokens`), the costliest first; past the listed ones, one row with `other: true`.
- **By user** (`users`): the 50 users whose calls cost the most, without the calls that name no user. Only with `users` at view: otherwise `users` is `null` and `usersHidden` is `true`, and the latest calls carry no user.
- **Failures** (`failures`): failed calls by `error.type`, the most first, at most 100, with the latest of each.
- **The chart:** cost, input and output tokens, calls, and the 95th-percentile duration per time bucket (the buckets of the Traces and Logs charts, [telemetry](telemetry.md#the-lists-charts)), for every call (`total`) and split by model or feature (`series`).
- **The latest calls:** the 50 newest, each with its trace ID, span ID, and start in nanoseconds, which open the span (`GET …/traces/:traceId/spans/:spanId?start=`).
- **What the filters offer:** `environments` and `services` as the telemetry pages answer them, and `filterOptions` with the services, providers, models (at most 2,000), and features (at most 500) of the period in the shown environment.
- **Percentiles** are t-digest estimates (`quantileTDigest`), whose memory stays small over a period of up to 366 days: close to the exact ones on many calls, and one of the calls' own durations on a few.
- **The latest calls** read the last day of the range first, and the whole range only when that day holds fewer than 50.
- **How they read:** every query filters by project first, then time, passes every value as a parameter, has a `LIMIT`, and runs with the dashboard's limits (15 seconds, 300 MB, read-only, ended with the request, at most 4 at once per process: [telemetry](telemetry.md#how-the-pages-read)). The totals, chart, and breakdowns read without `FINAL`, as the Services page does: a retried call counts twice until its parts are merged. The latest calls read with `FINAL`.

The answers, in TypeScript's terms (all times as ISO 8601, durations in milliseconds, cost in US dollars, shares from 0 to 1, `null` where there is nothing to divide):

```ts
// GET …/ai
{
  timeZone: string; environment: string; firstDay: string; lastDay: string;
  environments: string[]; services: string[];
  filterOptions: { services: string[]; providers: string[]; models: string[]; features: string[] };
  received: boolean; // whether the project has any AI call at all
  totals: Totals;
  previous: { firstDay: string; lastDay: string; until: string | null; totals: Totals };
  models: (Figures & { model: string; provider: string; other: boolean; priced: boolean })[];
  features: (Figures & { feature: string; other: boolean })[];
  users: { userId: string; calls: number; inputTokens: number; outputTokens: number;
           costUsd: number; failed: number; noPriceCalls: number }[] | null;
  usersHidden: boolean;
  failures: { errorType: string; calls: number; lastAt: string }[];
  limits: { models: 2000; features: 500; users: 50 };
}
Totals = { calls; inputTokens; outputTokens; cacheReadTokens; cacheWriteTokens; reasoningTokens;
           costUsd; cacheReadShare: number | null; p95Ms: number | null; failed;
           failedShare: number | null; noPriceCalls; noPriceModels: string[] }
Figures = Totals without p95Ms and noPriceModels, plus { p50Ms; p95Ms; firstChunkP50Ms;
           cutOff: number; cutOffShare: number | null }

// GET …/ai/chart
{ …the range…, start: string; bucketStarts: string[]; stepSeconds: number; buckets: number;
  split: "model" | "feature";
  total: Series; series: (Series & { key: string; other: boolean })[] }
Series = { costUsd: number[]; tokens: number[]; calls: number[]; p95Ms: (number | null)[] }

// GET …/ai/calls
{ …the range…, limit: 50, usersHidden: boolean,
  calls: { traceId; spanId; startNs: string; at: string; service; release; provider; model;
           operation; feature; userId: string | null; inputTokens; outputTokens;
           cacheReadTokens; cacheWriteTokens; reasoningTokens; costUsd: number | null;
           durationMs; firstChunkMs: number | null; failed: boolean; errorType: string;
           finishReasons: string[] }[] }
```

## Alerts

Three rule kinds, evaluated by the worker with the telemetry rules, once a minute each, from the same figures as the page (`apps/api/src/alerts/ai-rules.ts`), read without `FINAL` ([uptime and alerts](uptime-alerts.md#step-4-alerts-on-telemetry-as-built)). All need `ai` at view to see, create, or change, and their alerts in the inbox need it too ([access](access.md#alert-rules-and-the-areas-they-watch)); monitoring alone is not enough.

| Kind          | Settings (`POST …/alert-rules`, `settings`)                                                                                                                                                                                                        | Fires when                                                   | Resolves when                               |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------- |
| `ai_cost`     | `thresholdUsd` (above 0, at most 10^9), `costWindow` (`1h` the last hour, `1d` the last 24 hours (default), `month` the month so far, from midnight of its first day in the instance's timezone), and optionally `feature`, `model`, `environment` | The window's estimated cost is above the value               | It stays at or below it for 60 minutes      |
| `ai_failures` | `thresholdPercent` (0 to just under 100), `windowMinutes` (5 to 60, default 10), `minCalls` (1 to 10^6, default 20), and optionally `feature`, `model`, `environment`                                                                              | The window's failed share is above the share                 | It stays at or below it for the same window |
| `ai_latency`  | `thresholdMs` (above 0, at most 3,600,000), `windowMinutes` (5 to 60, default 10), `minCalls` (1 to 10^6, default 20), and optionally `feature`, `model`, `environment`                                                                            | The window's 95th-percentile duration is above the threshold | It stays at or below it for the same window |

- **Scope:** `environment` is one environment, `production` when left out; `feature` and `model` (at most 100 characters each) narrow the rule to one of each, exactly as stored, or all when `null`. A `feature` of `""` is the calls that name none ("Unlabeled"), as the report's `feature=` is.
- **The window** ends a minute before the evaluation, as the telemetry rules' do.
- **Kept hours.** A cost rule whose window holds 3 closed hours or more (the last 24 hours, and the month so far) does not read the whole window each minute: the cost, calls, and calls without a price of each closed hour (UTC hours that ended before the window's end) are kept in PostgreSQL (`ai_cost_windows` and `ai_cost_hours`, migration `0018_ai_cost_hours`; `apps/api/src/alerts/ai-cost-hours.ts`), and each evaluation reads from ClickHouse only the part of the hour the window starts in, the hours closed since the last evaluation, and the hour still open. They are added up again from scratch at the first evaluation after the instance's midnight, when the rule's settings or the prices change ([Prices](#prices)), and when the window no longer follows on from what is kept; a new month starts from nothing. The last hour's rule reads its window whole.
- **Latency** is the calls' duration, the span's, at the 95th percentile: a t-digest estimate (`quantileTDigest`), as the page's ([The report](#the-report)), read in one query with the window's count (`aiLatencyWindow` in `report.ts`). The percentile is fixed; a route latency rule's choice of p99 is not offered, since a window of 20 calls has no meaningful 99th percentile.
- **No data:** a failures or latency rule with fewer calls than its minimum does not judge the window. A cost rule always has a value: no calls cost 0.
- **When saved,** a rule whose calls have not arrived in the last 24 hours is saved with a warning, as the telemetry rules are.
- **Notifications:** `ai.cost`, `ai.cost_resolved`, `ai.failures`, `ai.failures_resolved`, `ai.latency`, `ai.latency_resolved` ([webhooks](webhooks.md)). Every cost message says the cost is an estimate from token counts and model prices, and how many calls of models without a price it leaves out. The link opens the AI page with the rule's environment, feature, and model (`/projects/:id/ai?env=…&feature=…&model=…`).

## The Overview's AI cost widget

The project Overview ([dashboard](dashboard.md#the-widgets)) has an AI cost widget after the services one: the estimated cost of the period's AI calls and their number, each against the period before, with the AI page's minimum of 20 calls before a change shows, and the three models that cost the most. Its route, `GET /api/projects/:id/overview/ai-cost`, needs `ai` at view, as the AI page does; a user without it neither sees the widget nor gets its numbers (403). It reuses the report's queries (`aiTotals` for both periods, `aiModels`, `hasAiCalls`) at the instance's prices, in the Overview's environment, with no filters. It answers `received` (any AI call at all), `costUsd`, `calls`, `noPriceCalls`, `previousCostUsd`, `previousCalls`, and `models` (`model`, `costUsd`, `calls`; the breakdown's Other row and models that cost nothing are left out). The widget says "Cost is an estimate from token counts and model prices." and how many calls had no price; its links to the AI page (the head's, and each model's, filtered by it) keep the Overview's period and environment. Without any AI call it says "No AI calls yet" and links to the docs site's page on sending them.

## A user's AI usage

A user's page and the Users workbench's detail pane (`UserView`, [dashboard](dashboard.md#users)) have an "AI in the last 30 days" section after Replays: the user's calls, estimated cost, input and output tokens, failed share, and 95th-percentile duration, then the three models and the three features that cost them the most, from `GET …/ai?period=30d&user=…` in the page's environment (`apps/web/src/features/users/user-ai.tsx`). The user page has no period of its own, so the section takes the last 30 days. It says "Cost is an estimate from token counts and model prices." and how many calls had no price, and links to the user's calls on the calls list ("AI calls", [below](#the-calls-list), filtered by the user, over the same days and environment) and to the AI page ("AI page"), which has no user filter.

- **Access:** shown only with `ai` at view, which the AI routes need; without it there is no section and no request. The page itself needs `users`, which the `user` filter needs too.
- **Most projects have no AI calls:** while the project has never had one (`received` false), and while that is not known yet, the section shows nothing at all. With AI calls but none from this user in the period, it says "No AI calls from this user in the last 30 days."
- **Failure:** "The AI usage could not load", with Retry.

## Sending calls

Any instrumentation that follows the OpenTelemetry GenAI conventions sends calls this module reads. The docs site's page (`/monitoring/ai-usage/`) shows OpenTelemetry's own OpenAI instrumentations: `@opentelemetry/instrumentation-openai` for Node.js (openai 4.19 to 6, https://github.com/open-telemetry/opentelemetry-js-contrib/tree/main/packages/instrumentation-openai) and `opentelemetry-instrumentation-openai-v2` for Python (https://pypi.org/project/opentelemetry-instrumentation-openai-v2/), both checked on 22 November 2026.

## Sending calls over HTTP

For an app without OpenTelemetry: its server sends each call's names, token counts, and duration to `POST /api/ai-calls`, and the calls go into the same `ai_calls` table, so the AI page and the alert rules read them as they read calls found in spans. Code: `apps/api/src/ai/ingest-routes.ts`.

Send a call one way only. A call whose trace already has a GenAI span for it is counted from that span; sending it over HTTP as well counts it twice. `traceId` and `spanId` are for linking a call to a trace that has no GenAI span of its own, such as the request that made the call.

```text
POST /api/ai-calls
Authorization: Bearer sk_…
Content-Type: application/json

{ "v": 1, "environment": "production", "release": "api@2.3.0",
  "calls": [{ "id": "<UUID>", "occurredAt": 1794823396705, "provider": "openai", "model": "gpt-4o-mini",
              "operation": "chat", "inputTokens": 1200, "outputTokens": 300, "durationMs": 1850,
              "feature": "support-chat", "userId": "42" }] }
```

| Field                                                                                   | Required | Rule                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment`, `release`                                                                | No       | For the whole batch, as server-side events take them ([web analytics](web-analytics.md#server-side-events)); `production` when left out                                                                                                                                                                                                                                                 |
| `id`                                                                                    | Yes      | A UUID the sender makes once per call: the call's row ID                                                                                                                                                                                                                                                                                                                                |
| `occurredAt`                                                                            | Yes      | When the call started, in milliseconds since 1970                                                                                                                                                                                                                                                                                                                                       |
| `provider`, `model`                                                                     | Yes      | 1 to 100 characters, no control characters. The model is what prices the call ([Cost](#cost))                                                                                                                                                                                                                                                                                           |
| `operation`                                                                             | No       | Such as `chat` or `embeddings`; "" when left out, as for a span without one                                                                                                                                                                                                                                                                                                             |
| `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens` | No       | Whole numbers from 0 to 10^9; 0 when left out. Send the provider's counts as they are: whether the input holds the cached tokens is `inputIncludesCache`'s                                                                                                                                                                                                                              |
| `inputIncludesCache`                                                                    | No       | `true` when `inputTokens` holds the cached tokens (OpenAI's API, Gemini's), `false` when it counts them apart (Anthropic's API, Bedrock's Converse). Left out, it is worked out from `provider` and `model` ([Cost](#cost)); a proxy that reports another provider's models in its own form should send it. An input smaller than its cached tokens is taken as apart, whatever is sent |
| `durationMs`                                                                            | Yes      | 0 to 86,400,000 (a day), fractions allowed                                                                                                                                                                                                                                                                                                                                              |
| `firstChunkMs`                                                                          | No       | Time to the first chunk of a streamed answer, in the same range                                                                                                                                                                                                                                                                                                                         |
| `ok`, `errorType`                                                                       | No       | A call failed if `ok` is `false` or it has an `errorType` (at most 200 characters); `ok: true` with an `errorType` is refused                                                                                                                                                                                                                                                           |
| `finishReasons`                                                                         | No       | At most 16, of at most 64 characters, stored in lower case                                                                                                                                                                                                                                                                                                                              |
| `userId`                                                                                | No       | 1 to 200 characters, no control characters: the ID the tracker's `data-user-id` sends, so the call links to the Users page                                                                                                                                                                                                                                                              |
| `feature`                                                                               | No       | At most 100 characters: what `ottertrail.feature` sets on a span                                                                                                                                                                                                                                                                                                                        |
| `conversationId`                                                                        | No       | No control characters; at most 200 characters once trimmed, counted as a span's are (in characters, so 200 emoji fit; longer is refused with 400): what `gen_ai.conversation.id` sets on a span ([Conversations](#conversations))                                                                                                                                                       |
| `service`                                                                               | No       | At most 100 characters: the service filter on the AI page                                                                                                                                                                                                                                                                                                                               |
| `traceId`, `spanId`                                                                     | No       | 32 and 16 hex characters, for an app that has traces too: the call's "Open its trace" link. A `spanId` needs its `traceId`                                                                                                                                                                                                                                                              |

- **The project's secret key,** as server-side events and OTLP take it, looked up before the body is read, as OTLP does (cached, unknown keys too): a missing or malformed key gets 401 (`unauthorized`), an unknown one 401 (`unknown_key`), and neither body is read. A public key never works. No CORS headers: a page cannot read the answers, and must never hold the key.
- **Before the body is read,** cheapest first: the key's form, requests per IP address (an IPv6 address by its /64; bursts of 600, then 50 a second, as for server-side events), the requests in progress (8 per API process, 4 of them one project's, counted and given back as OTLP's: a client that disconnects keeps its place until its insert settles: 503 `busy` or 429 past them), and the key. Then the schema, the text rules, and the times.
- **Optional names may be empty:** `operation`, `feature`, `conversationId`, `service`, `errorType`, and a finish reason that is "" or only spaces are as left out, as on a span.
- **No prompts or completions.** The schema has no field for them, and fields it does not know are dropped (Fastify's `removeAdditional`, as for server-side events), so a prompt sent by mistake is never stored.
- **Cost is not sent:** it is worked out from the tokens when the calls are read ([Cost](#cost)).
- **The server's clock is trusted:** a call more than 5 minutes ahead is refused (400); one more than 24 hours old is counted in `tooOld` and not stored.
- **Limits:** at most 1,000 calls and 1 MiB a request (a usual call is about 300 bytes). Each call costs one unit of the project's telemetry budget, the one OTLP spends ([telemetry](telemetry.md#limits)); a batch larger than the whole budget is refused (413).
- **The answer comes once ClickHouse has written the batch** (an asynchronous insert, waiting for the write). A batch of one month's calls is one write, stored whole or not at all. A batch whose calls fall in two months is two partitions, and a failed write (503) can store part of it; a retry with the same body is safe, as the copies merge ([Retries](#retries)).

| Status | Body `error`                   | Meaning                                                                                          | Should the sender retry? |
| ------ | ------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------ |
| 202    | none: `{ "stored", "tooOld" }` | Written to ClickHouse. `stored` counts the calls written, a retry's included                     | No                       |
| 400    | `invalid_request`              | The batch breaks a rule above                                                                    | No: it will fail again   |
| 401    | `unauthorized`, `unknown_key`  | No secret key, a malformed one, or one no project has                                            | No                       |
| 413    | `payload_too_large`            | Over 1 MiB, or more calls than the project's whole budget                                        | No: send smaller batches |
| 415    | `unsupported_media_type`       | Not `application/json`                                                                           | No                       |
| 429    | `rate_limited`                 | Too many requests from the address or in progress for the project, or calls for the budget       | Yes, after `Retry-After` |
| 503    | `storage_unavailable`, `busy`  | The key could not be looked up, ClickHouse could not write, or too many requests are in progress | Yes, after `Retry-After` |

### Retries

Retry on 429 and 503 with the same body. A call's row is its project, the day of its `occurredAt` (UTC), and its `id`, which `ReplacingMergeTree` keeps once, so a retried call is one row as long as the retry sends the same `id` and an `occurredAt` on the same day; the copy written last is kept. Make the `id` when the call is made, not when it is sent. A retry whose time falls on the other side of midnight UTC is a second row, as for events. Until ClickHouse merges the copies, the AI page's totals and the alert rules can count a retried call twice, as they can a retried span ([Known limits](#known-limits)); the latest calls never show a copy.

### Examples

```sh
curl https://analytics.example.com/api/ai-calls \
  -H "Authorization: Bearer $OTTERTRAIL_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"v": 1, "calls": [{"id": "'"$(uuidgen)"'", "occurredAt": '"$(date +%s)000"',
       "provider": "openai", "model": "gpt-4o-mini", "operation": "chat",
       "inputTokens": 1200, "outputTokens": 300, "durationMs": 1850,
       "feature": "support-chat", "userId": "42"}]}'
```

Node.js, after a call with the `openai` package:

```ts
import { randomUUID } from "node:crypto";

const startedAt = Date.now();
const completion = await openai.chat.completions.create({ model: "gpt-4o-mini", messages });
const call = {
  id: randomUUID(),
  occurredAt: startedAt,
  provider: "openai",
  model: completion.model,
  operation: "chat",
  inputTokens: completion.usage?.prompt_tokens ?? 0,
  outputTokens: completion.usage?.completion_tokens ?? 0,
  cacheReadTokens: completion.usage?.prompt_tokens_details?.cached_tokens ?? 0,
  durationMs: Date.now() - startedAt,
  feature: "support-chat",
  userId: user.id,
};
await fetch("https://analytics.example.com/api/ai-calls", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.OTTERTRAIL_SECRET_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ v: 1, calls: [call] }),
});
```

Python, with `requests`:

```py
import os, time, uuid
import requests

started_at = time.time()
completion = client.chat.completions.create(model="gpt-4o-mini", messages=messages)
requests.post(
    "https://analytics.example.com/api/ai-calls",
    headers={"Authorization": f"Bearer {os.environ['OTTERTRAIL_SECRET_KEY']}"},
    json={"v": 1, "calls": [{
        "id": str(uuid.uuid4()),
        "occurredAt": int(started_at * 1000),
        "provider": "openai",
        "model": completion.model,
        "operation": "chat",
        "inputTokens": completion.usage.prompt_tokens,
        "outputTokens": completion.usage.completion_tokens,
        "durationMs": (time.time() - started_at) * 1000,
        "feature": "support-chat",
        "userId": str(user.id),
    }]},
    timeout=10,
)
```

An app that makes many calls can gather them and send up to 1,000 at a time; a failed call can be sent with `"ok": false` and the error's type.

## Getting the feature and the user onto a call

Auto-instrumented model spans are children of the app's own code, so an attribute set on the app's span does not reach them. OpenTelemetry's baggage span processors copy baggage onto every span started inside it: put `ottertrail.feature` and `user.id` in baggage around a feature's work, and allow only those two keys. Baggage also goes out in the headers of outgoing HTTP requests, the model provider's too, unless the baggage propagator is off: set `OTEL_PROPAGATORS=tracecontext`.

Node.js, with `@opentelemetry/baggage-span-processor`:

```ts
import { context, propagation } from "@opentelemetry/api";
import { BaggageSpanProcessor } from "@opentelemetry/baggage-span-processor";

// With the SDK's other span processors:
new BaggageSpanProcessor((key) => key === "ottertrail.feature" || key === "user.id");

// Around a feature's work:
const baggage = propagation.createBaggage({
  "ottertrail.feature": { value: "support-chat" },
  "user.id": { value: user.id },
});
await context.with(propagation.setBaggage(context.active(), baggage), () => answer(question));
```

Python, with `opentelemetry-processor-baggage`:

```py
from opentelemetry import baggage, context
from opentelemetry.processor.baggage import BaggageSpanProcessor

provider.add_span_processor(BaggageSpanProcessor(lambda key: key in ("ottertrail.feature", "user.id")))

ctx = baggage.set_baggage("ottertrail.feature", "support-chat")
ctx = baggage.set_baggage("user.id", user.id, context=ctx)
token = context.attach(ctx)
try:
    answer(question)
finally:
    context.detach(token)
```

The Vercel AI SDK's `functionId` arrives as `gen_ai.agent.name`, which is the feature when `ottertrail.feature` is not set.

A conversation's ID travels the same way: put `gen_ai.conversation.id` in baggage around a conversation's turn, and allow that key too.

## The calls list

Every call of a period, one at a time, and the conversations they make, on the AI page's calls list (`/projects/<id>/ai/calls`, [dashboard](dashboard.md#ai-calls)). Four project routes (`apps/api/src/ai/call-routes.ts`, queries in `apps/api/src/ai/call-list.ts`), each behind `requireProjectAccess` for `ai` at view; a call's user, and the `user` filter, need `users` at view too (without it, users are `null`, `usersHidden` is `true`, and a request with `user` is refused with 403, so no one finds a user's calls by guessing their ID):

```text
GET /api/projects/:id/ai/call-list?…the report's filters…&user=…&conversation=…&status=failed&before=…
GET /api/projects/:id/ai/calls/:callId?at=…
GET /api/projects/:id/ai/conversations?…the same filters, no conversation…
GET /api/projects/:id/ai/conversations/:conversationId?…the same filters…
```

- **The list:** newest first, 100 a page, with a cursor (`before`, the last call's start in nanoseconds and its ID) to the next while there are more. Read with `FINAL`, so a retried call is listed once, at the time of its copy written last, on every page (the time condition applies after the copies are merged, [Storage](#storage)); `FINAL` merges every row of the range it reads, so the day before the page's end is read first, and the rest of the period only when that day does not fill the page. Each call carries every stored field and its estimated cost (`null` without a price). The answer also has the period's `totals` with the filters (calls, estimated cost, failed and its share, calls without a price), read without `FINAL` as the AI page's totals are, so the two pages give the same figures for the same calls, and what the filter bar offers, as the report answers it. A later page (with `before`) skips both: its `totals`, `environments`, `services`, `filterOptions`, and `received` are `null`, and the first page's stand.
- **One call:** by its row ID, over the whole UTC days a minute either side of `at` (its start, which the list's links send), or, without `at`, the days its copies are on in the last 366, found first without `FINAL`; any environment, since the ID names one call. Read with `FINAL` over those days, so the page shows the copy the list shows (a retry with a corrected time is the same row, and its copies differ until merged); the key's day and ID narrow that read to the call's few granules, and an address without `at` does not merge a year of rows. A retry across midnight UTC is two rows: the later is shown. The answer adds where its price comes from (`price`: `built_in` with the day it was checked, `custom` with the row's model when it is on another ID and the day it starts, or `price_as` with the model it takes; the prices per million tokens; `null` without a price), worked out with `priceAt` at the call's time, as the cost is, and whether its trace is still kept (`traceKept`: it has a trace ID and started within the spans' retention, `traceRetentionDays`). An unknown ID answers 404 `no_such_call`.
- **Filters:** those of the report (`service`, `provider`, `model`, `feature`), the user (`user`, as stored), the conversation, and `status=failed`. Each value as stored, each a parameter.

### Conversations

A conversation is the calls that share a `conversation_id` ([Detection](#detection), or `conversationId` [over HTTP](#sending-calls-over-http)). Calls without one are in no conversation.

- **The list:** the period's conversations with the filters, by their last call, newest first, at most 1,000: first the IDs of the 1,000 with the latest calls (a `GROUP BY` without `FINAL`, since a copy does not move a conversation's last call), then their figures with `FINAL`. `more` says when others were left out. Each: its ID, first and last call, calls (turns), input and output tokens, estimated cost, calls without a price, the durations added up, failed calls, the user of most of its calls, and up to five features and models.
- **What the filters do:** the model, feature, service, provider, and user narrow the calls a conversation is made of; `status=failed` keeps the conversations with a failed call, all their calls counted.
- **One conversation:** its calls in the period with the filters (but `status`), oldest first, at most 500, each once (`FINAL`), and its figures counted whole.

## Known limits

- **Cost is an estimate.** It is tokens times the built-in list prices, or the prices set in Settings → AI models. With the built-in prices it leaves out batch discounts, negotiated prices, regional and US-only surcharges, higher prices past a prompt length, Anthropic's 1-hour cache writes (spans do not say which cache was used: the 5-minute price is taken), per-request fees such as web search, and price changes the table does not have yet. The page must say so.
- **Sampled traces undercount.** A call is counted only if its span reaches Ottertrail; with head or tail sampling, the totals are those of the sampled traces. The token metrics are not sampled; comparing against them is phase 2.
- **A retried call counts twice** in the totals, chart, breakdowns, and alerts until its parts are merged: they read without `FINAL`. The forced merge acts on a whole month's partition, which is still being written to for the month, so within the month a copy lasts until ClickHouse merges its part, as it usually does within minutes to hours. The latest calls never show a copy.
- **A late call in a closed hour** (one that arrives after its hour has ended and been kept, or one retention deletes from it) is not in a cost rule's total until the next daily recompute, after the instance's midnight. The AI page reads every call each time and is not affected.
- **Reasoning tokens** are priced as output, as the conventions count them in the output. A sender that counts them apart from the output undercounts.
- **Models are matched by ID only,** whatever the provider. A self-hosted or fine-tuned model with a listed ID's name is priced as the listed one unless the instance sets a price of its own; a dated snapshot the table does not list has no price until it gets one in Settings → AI models (a price, or price as).
- **Custom prices are the instance's,** not a project's: every project's calls of a model take the same price.
- **A dated price is a moment,** midnight of its day in the instance's timezone when it was set: changing the timezone afterwards does not move it, so it then starts at another hour of the new timezone's day.
- **Rows on two IDs of one bundled entry** both cover the entry: a call without a row of its own takes the later start of the two.
- **OpenInference spans** that name only `llm.*` attributes (no `gen_ai.*`) are not detected: set `OPENINFERENCE_ENABLE_GENAI_SEMCONV=true`.
- **Calls older than the telemetry retention** cannot be sent: the traces route refuses spans older than `TELEMETRY_RETENTION_DAYS`, and `POST /api/ai-calls` calls more than a day old, so a project's history starts when it starts sending.
- **A call sent over HTTP without a trace** has no "Open its trace" link on the AI page.
- **Exception messages and other log bodies are kept.** Only the content attributes, and the bodies of GenAI message events, are dropped ([telemetry](telemetry.md#ai-prompts-and-completions-are-not-stored)). An exception message that quotes a prompt (`exception.message`, in the error list), a span's status message, or the body of a log record with any other event name is stored as sent. Keep prompts out of the messages your app's errors and logs carry.
- **The calls list's totals and its rows can differ** until a retried call's copies merge: the totals read without `FINAL`, as the AI page's, the rows with it.
- **A conversation is its calls in the period:** one that started before the period shows only its later turns, and its figures cover those. Choose a longer period to see it whole.
- **At most 1,000 conversations** a period, those with the latest calls, and 500 calls of one conversation; past them the pages say so.
- **The conversation filter has no field to type in:** it is set by a link (a call's conversation, a conversation's calls) and shown as a chip that removes it. The Conversations view finds conversations.
- **A conversation's ID is the app's:** Ottertrail does not check that calls sharing one belong together, and an ID over 200 characters is dropped, so those calls are in no conversation.

## Phases

1. **Phase 1, minimal useful:**
   - dropping content attributes (done, its own fix: commit `2ac772d`);
   - AI call detection with aliases, and the `ai_calls` table with retention, deletion, and backups (built);
   - the bundled price table (built);
   - the report API and the AI page in the project sidebar, after Databases ([dashboard](dashboard.md#ai); built);
   - the `ai_cost` and `ai_failures` alerts, in the API and the Alerts page's form (built);
   - these docs, with the snippets above, and the docs site's page `/monitoring/ai-usage/` (built);
   - tests against real ClickHouse with OpenTelemetry's own exporters (`ai-calls.test.ts`, `ai-report.test.ts`, `ai-alerts.test.ts`);
   - the instance's own prices in Settings → AI models, from a day on or for all calls, and price as (built 22 November 2026; [Prices](#prices)).
2. **Phase 2:**
   - `POST /api/ai-calls` with the secret key, for apps without OpenTelemetry, into the same table (built 22 November 2026; [Sending calls over HTTP](#sending-calls-over-http));
   - an AI calls list in the Workbench pattern (built 22 November 2026; [The calls list](#the-calls-list));
   - an `ai_latency` alert (built 22 November 2026; [Alerts](#alerts));
   - a cost widget on the Overview (built 22 November 2026; [above](#the-overviews-ai-cost-widget));
   - a user's AI usage on the user's page (built 22 November 2026; [above](#a-users-ai-usage));
   - comparing the totals with the token metrics;
   - grouping by `gen_ai.conversation.id` (built 22 November 2026; [Conversations](#conversations));
   - an AI access area, so finance people can see costs without monitoring (built 22 November 2026, [access](access.md)).

## Tests

- `apps/api/tests/ai-calls.test.ts`: spans of each kind of sender through OpenTelemetry's protobuf and JSON exporters, stored as calls or not, the old and new names, the bounds; a retried batch one row; each call a unit of the budget, never a 413 for a batch the budget takes without them; a 503 that gives it back when the calls cannot be written, whether the spans were.
- `apps/api/tests/ai-http-calls.test.ts`: `POST /api/ai-calls`: every field stored, the key (missing, malformed, public, unknown) checked before the body, each rule refusing the whole batch, unknown fields such as a prompt dropped, 1,000 calls and 1 MiB, a call over a day old, empty optional names as left out, a retried batch one row, a retry with a corrected time on the same day one row, whether the input holds the cached tokens as sent and by provider, the arrival stored, each call a unit of the budget OTLP shares, the address's rate by IPv6 /64, the requests in progress and a client that hangs up while its calls are written keeping its place until the insert settles, an unknown key's body never parsed, 503 when the key cannot be looked up and when ClickHouse cannot write, with the budget given back, and the calls on the AI page and in a cost rule.
- `apps/api/tests/ai-call-list.test.ts`: the calls list's routes: every field, each filter and the environment, paging past the first day with each call once (retries with a corrected time at a page's edge too), one call with its price's source and whether its trace is kept, the totals and cost against the AI page's, conversations from spans and from calls over HTTP, their filters, one conversation's calls, the 1,000 bound, and access with and without `users`. `ai-calls.test.ts` and `ai-http-calls.test.ts` cover the conversation ID's rules.
- `apps/web/tests/browser/ai-calls.test.tsx` and `list-workbenches.test.tsx`: the calls list and the Conversations view against the fake API (`fake-ai-calls.ts`).
- `apps/api/tests/ai-report.test.ts`: the price table's shape and matching, the arithmetic in JavaScript and in ClickHouse (input with and without its cached tokens), the report's figures and each filter (one user's calls on every route, refused without `users`), the previous period, the chart and its Other line, the latest calls, access with and without `users`, and retention, project deletion, and the orphan sweep.
- `apps/api/tests/ai-alerts.test.ts`: the three kinds fired, the cost and latency kinds resolved, the failures and latency kinds quiet below their minimum, the month's window across a timezone, the kept hours of the month and the last 24 hours against a full scan (a late call, midnight, a new month), the unlabeled feature, the worker's pass, and the rule routes' validation.
- `apps/api/tests/ai-models.test.ts`: cost at read time with custom rows from a day, for all calls, price as (one level), on another ID of a bundled entry, exactly at a start, in a non-UTC timezone, and after a reset, ClickHouse against `priceAt`; kept hours marked stale and added up again after a change, and after a row changed past the routes; the list across the instance's projects only, and without ClickHouse; admins yes, members no; validation, the caps, a reset refused for a target, Origin, and the limit per user.
- `apps/web/tests/browser/ai-models.test.tsx`: the tab, the No price filter, the search and paging, a model's sheet, Edit price from a date and for all calls, price as, Add model, Reset with its confirm, the states, and the AI page's link.
- `apps/web/tests/browser/ai.test.tsx` and `ai-alerts.test.tsx`: the page and the alert form against the fake API (`fake-ai.ts`), and a call without a trace without its link; `report-screens.test.tsx` the page at 390 and 1440 wide.
- `apps/web/tests/browser/users.test.tsx`: a user's AI section with its figures, models, and features, the line for no calls in the period, nothing without `ai` (and no request, even with `monitoring`) or for a project without AI calls, the failure and Retry, and its fit at 390 and 1440 wide, on the page and beside the list.
- `apps/api/tests/overview.test.ts` and `apps/web/tests/browser/overview.test.tsx`: the AI cost widget's figures against the period before, its models, its access, the change hidden below 20 calls, and the state without AI calls.
