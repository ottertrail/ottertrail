# AI usage tracking

**Status: phase 1 is being built. The backend is built: detection and storage of AI calls, the price table, the report API, and the two alert rule kinds. The AI page and the alert form for the new kinds come next, on top of that API.**

An app that calls language models pays per token, and its calls fail, stall, and get cut off in ways its other requests do not. This module shows the LLM calls an app makes: tokens, estimated cost, latency, and failures, per model, per feature, and per user, with the trace of each call one click away. It reads the spans the app already sends over OTLP ([telemetry](telemetry.md)); nothing of Ottertrail's runs in the app.

## Decisions

Made on 22 November 2026, all as the design proposed:

1. **AI calls get their own ClickHouse table**, `ai_calls`, written beside the spans and kept as long as the project's events, not the 30 days of spans. Cost questions are asked by the month and the year, and a row is small next to the spans around it: each one is a paid API call.
2. **Prompts and completions are never stored.** They are dropped at ingestion for every project, AI page or not ([telemetry](telemetry.md#ai-prompts-and-completions-are-not-stored), `apps/api/src/telemetry/ai-content.ts`). This module reads only token counts and names.
3. **Prices come from a small hand-kept table in the repository** (`apps/api/src/ai/price-table.ts`), read from the providers' own price pages, each entry with its source and the day it was checked, updated each release. Per-project overrides come in phase 2. Prices are never fetched at run time: self-hosted instances must work offline.
4. **A call's feature** is its `ottertrail.feature` attribute, else `gen_ai.agent.name`, else none ("Unlabelled").
5. **Access:** the `monitoring` area at view. The breakdown by user, and the user of each call, also need `users` at view.

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

The user is the ID the tracker's `data-user-id` sends, so a call links to the Users page ([known users](web-analytics.md#known-users)).

### Limits

- **Names:** the model, provider, operation, and feature lose control characters, are trimmed, and are cut to 100 characters; `error.type` to 200; at most 16 finish reasons of 64 characters.
- **Token counts:** a whole number from 0 to 10^9. Anything else (negative, fractional, larger) is left out of that call, as 0, and the call is kept; the batch never fails for it.
- **Lists:** a breakdown lists the 2,000 models and the 500 features with the most calls in the period; the rest are one "Other" row. The chart splits into the 10 that cost the most, and "Other".
- **Budget:** each AI call costs one more unit of the project's telemetry budget, as an exception that becomes an error event does ([telemetry](telemetry.md#limits)), but never makes a request too large: a request is refused as too large (413, which exporters drop) only when it costs more than the whole budget without its AI calls, and one that the calls take past it costs the whole budget, waiting for it with a 429 that exporters retry. A 503 gives all of it back.

## Storage

`ai_calls` (migration `0008_ai_calls`): project, start time, `id` (the trace and span IDs, the span's own row ID), trace and span IDs, service, environment, release, provider, model, operation, feature, user, the five token counts, duration, time to first chunk, failed, `error.type`, and finish reasons.

- `ReplacingMergeTree`, `PARTITION BY toYYYYMM(timestamp)`, `ORDER BY (project_id, timestamp, id)`: every query filters by project first, then a period. A retried batch makes the same IDs, so it is the same rows.
- **Written beside the span**, exactly as exception-derived error events are: the route writes the spans, the error events, and the AI calls before it answers 200 (asynchronous inserts, waiting for the write); if any insert fails, the budget is given back and the answer is 503, and the exporter's retry writes them all again.
- **Kept as long as the project's events** ("Keep events" on the project, forever by default): retention deletes a project's AI calls older than its cut-off with its events (`deleteEventsBefore` in `apps/api/src/clickhouse/delete-events.ts`). No TTL.
- **Deleted with the project,** found by the orphan sweep, and taken off the disk by `APPLY DELETED MASK`, as every other table ([ClickHouse](clickhouse.md#retention-and-deleting-a-project)). ClickHouse's backup covers it: `BACKUP DATABASE` takes every table.
- **Forced merges** as the telemetry tables have them: a partition's parts are merged into one once all are an hour old. Inserts return once on disk, as events' do.
- **Cost is not stored.** It is worked out when calls are read (below), so a corrected price applies to past calls.

## Cost

`apps/api/src/ai/prices.ts` holds the matching and the arithmetic; `price-table.ts` the prices.

- **Matching:** by model ID, in any case, whatever provider sent it: first an exact ID or documented alias, then the longest listed prefix. The response model is matched first (`claude-sonnet-4-6`, `gpt-4o-2024-08-06`, `us.anthropic.claude-sonnet-4-6`), as each call names it.
- **Arithmetic,** per call, then added up: cache reads at the cache read price, cache writes at the cache write price, the rest of the input at the input price, and the output (reasoning included, as the conventions count it) at the output price. A provider with no separate cache price charges cached tokens as input. The conventions count cached tokens in the input, so the rest is the input less both; a call whose input is smaller than its cached tokens comes from a sender that counts them apart (as Anthropic's API does), so all of its input is the rest. The cache-read share is at most 1 for the same reason.
- **In ClickHouse:** the table goes into each query as array parameters (IDs, prefixes longest first, and the prices), and a row's entry is found with `indexOf` and `arrayFirstIndex`, so nothing is fetched or joined.
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

## The report

Three project routes (`apps/api/src/ai/routes.ts`, queries in `apps/api/src/ai/report.ts`), each behind `requireProjectAccess` for `monitoring` at view:

```text
GET /api/projects/:id/ai?period=7d|from=…&to=…&environment=…&service=…&provider=…&model=…&feature=…
GET /api/projects/:id/ai/chart?…the same…&split=model|feature
GET /api/projects/:id/ai/calls?…the same…
```

- **Period:** as the other reports: `period` (`today`, `7d`, `30d`, `90d`, `12m`) or `from` and `to`, days in the instance's timezone, at most 366. Not cut to the 30 days of spans: AI calls are kept as long as events.
- **Filters:** each exactly as stored; `feature=` (empty) is the calls with no feature. `environment` is `production` when left out.
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

Two rule kinds, evaluated by the worker with the telemetry rules, once a minute each, from the same figures as the page (`apps/api/src/alerts/ai-rules.ts`), read without `FINAL` ([uptime and alerts](uptime-alerts.md#step-4-alerts-on-telemetry-as-built)). Both need `monitoring` at view to see, create, or change, as telemetry rules do ([access](access.md#alert-rules-and-the-areas-they-watch)).

| Kind          | Settings (`POST …/alert-rules`, `settings`)                                                                                                                                                                                                        | Fires when                                     | Resolves when                               |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------- |
| `ai_cost`     | `thresholdUsd` (above 0, at most 10^9), `costWindow` (`1h` the last hour, `1d` the last 24 hours (default), `month` the month so far, from midnight of its first day in the instance's timezone), and optionally `feature`, `model`, `environment` | The window's estimated cost is above the value | It stays at or below it for 60 minutes      |
| `ai_failures` | `thresholdPercent` (0 to just under 100), `windowMinutes` (5 to 60, default 10), `minCalls` (1 to 10^6, default 20), and optionally `feature`, `model`, `environment`                                                                              | The window's failed share is above the share   | It stays at or below it for the same window |

- **Scope:** `environment` is one environment, `production` when left out; `feature` and `model` (at most 100 characters each) narrow the rule to one of each, exactly as stored, or all when `null`. A `feature` of `""` is the calls that name none ("Unlabelled"), as the report's `feature=` is.
- **The window** ends a minute before the evaluation, as the telemetry rules' do.
- **Kept hours.** A cost rule whose window holds 3 closed hours or more (the last 24 hours, and the month so far) does not read the whole window each minute: the cost, calls, and calls without a price of each closed hour (UTC hours that ended before the window's end) are kept in PostgreSQL (`ai_cost_windows` and `ai_cost_hours`, migration `0018_ai_cost_hours`; `apps/api/src/alerts/ai-cost-hours.ts`), and each evaluation reads from ClickHouse only the part of the hour the window starts in, the hours closed since the last evaluation, and the hour still open. They are added up again from scratch at the first evaluation after the instance's midnight, when the rule's settings change, and when the window no longer follows on from what is kept; a new month starts from nothing. The last hour's rule reads its window whole.
- **No data:** a failures rule with fewer calls than its minimum does not judge the window. A cost rule always has a value: no calls cost 0.
- **When saved,** a rule whose calls have not arrived in the last 24 hours is saved with a warning, as the telemetry rules are.
- **Notifications:** `ai.cost`, `ai.cost_resolved`, `ai.failures`, `ai.failures_resolved` ([webhooks](webhooks.md)). Every cost message says the cost is an estimate from token counts at list prices, and how many calls of models without a price it leaves out. The link opens the AI page with the rule's environment, feature, and model (`/projects/:id/ai?env=…&feature=…&model=…`).

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

## Known limits

- **Cost is an estimate.** It is tokens times list prices. It leaves out batch discounts, negotiated prices, regional and US-only surcharges, higher prices past a prompt length, Anthropic's 1-hour cache writes (spans do not say which cache was used: the 5-minute price is taken), per-request fees such as web search, and price changes the table does not have yet. The page must say so.
- **Sampled traces undercount.** A call is counted only if its span reaches Ottertrail; with head or tail sampling, the totals are those of the sampled traces. The token metrics are not sampled; comparing against them is phase 2.
- **A retried call counts twice** in the totals, chart, breakdowns, and alerts until its parts are merged: they read without `FINAL`. The forced merge acts on a whole month's partition, which is still being written to for the month, so within the month a copy lasts until ClickHouse merges its part, as it usually does within minutes to hours. The latest calls never show a copy.
- **A late call in a closed hour** (one that arrives after its hour has ended and been kept, or one retention deletes from it) is not in a cost rule's total until the next daily recompute, after the instance's midnight. The AI page reads every call each time and is not affected.
- **Reasoning tokens** are priced as output, as the conventions count them in the output. A sender that counts them apart from the output undercounts.
- **Models are matched by ID only,** whatever the provider. A self-hosted or fine-tuned model with a listed ID's name is priced as the listed one; a dated snapshot the table does not list has no price until it is added.
- **OpenInference spans** that name only `llm.*` attributes (no `gen_ai.*`) are not detected: set `OPENINFERENCE_ENABLE_GENAI_SEMCONV=true`.
- **Calls older than the telemetry retention** cannot be sent: the traces route refuses spans older than `TELEMETRY_RETENTION_DAYS`, so a project's history starts when it starts sending.

## Phases

1. **Phase 1, minimal useful:**
   - dropping content attributes (done, its own fix: commit `2ac772d`);
   - AI call detection with aliases, and the `ai_calls` table with retention, deletion, and backups (built);
   - the bundled price table (built);
   - the report API (built), then the AI page in the project sidebar, after Databases;
   - the `ai_cost` and `ai_failures` alerts (built in the API; the form comes with the page);
   - these docs, with the snippets above;
   - tests against real ClickHouse with OpenTelemetry's own exporters (`ai-calls.test.ts`, `ai-report.test.ts`, `ai-alerts.test.ts`).
2. **Phase 2:**
   - per-project price overrides in Settings, each with the day it applies from;
   - `POST /api/ai-calls` with the secret key, for apps without OpenTelemetry, into the same table;
   - an AI calls list in the Workbench pattern;
   - an `ai_latency` alert;
   - a cost widget on the Overview, and a user's AI cost on the user's page;
   - comparing the totals with the token metrics;
   - grouping by `gen_ai.conversation.id`;
   - an AI access area, if owners want finance people to see costs without the traces.

## Tests

- `apps/api/tests/ai-calls.test.ts`: spans of each kind of sender through OpenTelemetry's protobuf and JSON exporters, stored as calls or not, the old and new names, the bounds; a retried batch one row; each call a unit of the budget, never a 413 for a batch the budget takes without them; a 503 that gives it back when the calls cannot be written, whether the spans were.
- `apps/api/tests/ai-report.test.ts`: the price table's shape and matching, the arithmetic in JavaScript and in ClickHouse, the report's figures and each filter, the previous period, the chart and its Other line, the latest calls, access with and without `users`, and retention, project deletion, and the orphan sweep.
- `apps/api/tests/ai-alerts.test.ts`: both kinds fired, resolved, and quiet below their minimum, the month's window across a timezone, the kept hours of the month and the last 24 hours against a full scan (a late call, midnight, a new month), the unlabelled feature, the worker's pass, and the rule routes' validation.
