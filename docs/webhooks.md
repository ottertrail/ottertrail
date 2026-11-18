# Webhooks

A webhook is a notification channel ([uptime and alerts](uptime-alerts.md#where-alerts-go)) that sends each alert as a JSON `POST` to a URL of your own: a script, a chat relay, or another service. Each request is signed with the channel's secret, so the receiver can check that it came from your Ottertrail instance and is not a replay. This page describes format version 1. Code: `apps/api/src/notifications/` (`webhook.ts`, `events.ts`).

## Setting one up

On the Settings page, under **Notification channels**, add a channel of the kind Webhook with its URL. The instance makes the channel's secret (32 random bytes, written as 43 characters of base64url); any signed-in user can show it, copy it, and replace it. The dashboard fetches it only when Show is pressed. A replaced secret stops working at once. **Send test** queues a `test` notification, and the channel's deliveries show how it went.

The URL is `http` or `https`, without a user name or password. It follows the uptime checks' address rules ([deployment](deployment.md#uptime-checks)): a host that resolves to a loopback, private, link-local, or other internal address is refused when the channel is saved, and again on every delivery, so a DNS change after saving cannot point a webhook inside the instance's network. The request goes to the address that was checked, without resolving the host again.

## The request

```http
POST /hooks/ottertrail HTTP/1.1
Host: example.com
Content-Type: application/json
User-Agent: Ottertrail/0.0.0 (webhooks)
Ottertrail-Event: check.down
Ottertrail-Delivery: 2f0c3a9e-8d41-4b7a-9c55-6a1e2b3c4d5e
Ottertrail-Timestamp: 1794983405
Ottertrail-Signature: v1=5d4c…(64 hex digits)
```

| Header                 | Value                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Content-Type`         | `application/json`                                                                                                                                |
| `User-Agent`           | `Ottertrail/<version> (webhooks)`                                                                                                                 |
| `Ottertrail-Event`     | The event type, as in the body                                                                                                                    |
| `Ottertrail-Delivery`  | The delivery's ID: one per channel and notification, the same on every retry                                                                      |
| `Ottertrail-Timestamp` | When this attempt was sent, in Unix seconds                                                                                                       |
| `Ottertrail-Signature` | `v1=` and the HMAC-SHA256, in lowercase hex, of the timestamp, a full stop, and the body exactly as sent, keyed with the channel's secret as text |

The body, version 1:

```json
{
  "version": 1,
  "id": "6b1f3c1e-6f0c-4b65-8f15-0a5a7b0a4b10",
  "type": "check.down",
  "time": "2026-11-18T06:30:00.000Z",
  "project": { "id": "0d6e5f80-0c4f-4b8e-9d3a-3f8f6a1c2b7e", "name": "Shop" },
  "subject": {
    "type": "check",
    "id": "c0ffee00-0000-4000-8000-000000000001",
    "name": "API health",
    "url": "https://api.shop.example/health",
    "ruleId": "5a2c7e10-3b4d-4e6f-8a9b-0c1d2e3f4a5b",
    "ruleName": "API down"
  },
  "message": "Shop: the check \"API health\" (https://api.shop.example/health) is down. It answered 503, which does not count as up.",
  "url": "https://analytics.example.com/projects/0d6e5f80-0c4f-4b8e-9d3a-3f8f6a1c2b7e/uptime/c0ffee00-0000-4000-8000-000000000001"
}
```

| Field     | Meaning                                                                                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version` | `1`. A change that could break a receiver comes as a new version; fields may be added to this one                                                                |
| `id`      | The notification: the same for every channel it went to, and on every retry. Use it to drop a repeat                                                             |
| `type`    | The event type, below                                                                                                                                            |
| `time`    | When it happened, ISO 8601 in UTC                                                                                                                                |
| `project` | The project's ID and name; `null` for a notification about no project, such as a test                                                                            |
| `subject` | What it is about: an object whose values are text, numbers, `true` or `false`, or `null`, such as a check's `type`, `id`, and `name` (for a test, the channel's) |
| `message` | One or two sentences on what happened, as the email says it                                                                                                      |
| `url`     | The dashboard's page about it                                                                                                                                    |

### Event types

| Type                   | Sent when                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `check.down`           | An uptime check goes down                                                                     |
| `check.up`             | It is no longer down: up again, paused, or its URL changed                                    |
| `certificate.expiring` | A check's certificate expires within the rule's number of days                                |
| `certificate.renewed`  | Its expiry moved past the rule's days, or the check no longer reports a certificate           |
| `error.new`            | An error group is seen for the first time                                                     |
| `error.regressed`      | A resolved error group occurs again                                                           |
| `error.spike`          | Errors in the rule's window reach its threshold                                               |
| `error.spike_resolved` | They stay below it for the same window                                                        |
| `alert.held_back`      | A rule held notifications back after sending 20 in an hour; says how many, once the hour ends |
| `test`                 | Someone sends a test from the Settings page                                                   |

Alert rules ([step 3](uptime-alerts.md#step-3-alert-rules-as-built)) send all but `test`; alerts on telemetry will add types of their own. A receiver should ignore a type it does not know.

### Example bodies

Each alert's `subject` names what it is about, with `ruleId` and `ruleName`, the rule that sent it. Messages say what happened and name the project; an error's message is cut to 200 characters. The links point at the dashboard: the check's page, the error group's page in the alert's environment, the error list, or the Alerts page.

#### `check.down` and `check.up`

```json
{
  "version": 1,
  "id": "6b1f3c1e-6f0c-4b65-8f15-0a5a7b0a4b10",
  "type": "check.down",
  "time": "2026-11-18T06:30:00.000Z",
  "project": {
    "id": "0d6e5f80-0c4f-4b8e-9d3a-3f8f6a1c2b7e",
    "name": "Shop"
  },
  "subject": {
    "type": "check",
    "id": "c0ffee00-0000-4000-8000-000000000001",
    "name": "API health",
    "url": "https://api.shop.example/health",
    "ruleId": "5a2c7e10-3b4d-4e6f-8a9b-0c1d2e3f4a5b",
    "ruleName": "API down"
  },
  "message": "Shop: the check \"API health\" (https://api.shop.example/health) is down. It answered 503, which does not count as up.",
  "url": "https://analytics.example.com/projects/0d6e5f80-0c4f-4b8e-9d3a-3f8f6a1c2b7e/uptime/c0ffee00-0000-4000-8000-000000000001"
}
```

`check.up` has the same subject; its message is, for example, `Shop: the check "API health" (https://api.shop.example/health) is up again, after 25 minutes down.` (from the first failure of the run that took it down), or says the check was paused or its URL changed.

#### `certificate.expiring` and `certificate.renewed`

```json
{
  "version": 1,
  "id": "7c2e4d2f-7a1d-4c76-9a26-1b6b8c1b5c21",
  "type": "certificate.expiring",
  "time": "2026-11-18T07:00:00.000Z",
  "project": {
    "id": "0d6e5f80-0c4f-4b8e-9d3a-3f8f6a1c2b7e",
    "name": "Shop"
  },
  "subject": {
    "type": "certificate",
    "checkId": "c0ffee00-0000-4000-8000-000000000001",
    "checkName": "API health",
    "url": "https://api.shop.example/health",
    "host": "api.shop.example",
    "expiresAt": "2026-11-28T12:00:00.000Z",
    "days": 14,
    "ruleId": "5a2c7e10-3b4d-4e6f-8a9b-0c1d2e3f4a5b",
    "ruleName": "Certificates"
  },
  "message": "Shop: the TLS certificate of api.shop.example, checked by \"API health\", expires on 2026-11-28, in 10 days.",
  "url": "https://analytics.example.com/projects/0d6e5f80-0c4f-4b8e-9d3a-3f8f6a1c2b7e/uptime/c0ffee00-0000-4000-8000-000000000001"
}
```

`certificate.renewed` has the subject without `days`, with the new `expiresAt` (or `null` when the check no longer reports a certificate), and a message such as `Shop: the TLS certificate of api.shop.example, checked by "API health", was renewed: it now expires on 2027-02-26.`

#### `error.new`

```json
{
  "version": 1,
  "id": "8d3f5e30-8b2e-4d87-ab37-2c7c9d2c6d32",
  "type": "error.new",
  "time": "2026-11-18T07:12:30.000Z",
  "project": {
    "id": "0d6e5f80-0c4f-4b8e-9d3a-3f8f6a1c2b7e",
    "name": "Shop"
  },
  "subject": {
    "type": "error",
    "fingerprint": "1-3f2a9c1d0b7e6a5f4c3d",
    "errorType": "TypeError",
    "message": "Cannot read properties of undefined (reading 'total')",
    "environment": "production",
    "ruleId": "5a2c7e10-3b4d-4e6f-8a9b-0c1d2e3f4a5b",
    "ruleName": "New errors"
  },
  "message": "Shop: a new error in production. TypeError: Cannot read properties of undefined (reading 'total')",
  "url": "https://analytics.example.com/projects/0d6e5f80-0c4f-4b8e-9d3a-3f8f6a1c2b7e/errors/1-3f2a9c1d0b7e6a5f4c3d?env=%22production%22"
}
```

#### `error.regressed`

```json
{
  "version": 1,
  "id": "9e4a6f41-9c3f-4e98-bc48-3d8dae3d7e43",
  "type": "error.regressed",
  "time": "2026-11-18T07:20:30.000Z",
  "project": {
    "id": "0d6e5f80-0c4f-4b8e-9d3a-3f8f6a1c2b7e",
    "name": "Shop"
  },
  "subject": {
    "type": "error",
    "fingerprint": "1-3f2a9c1d0b7e6a5f4c3d",
    "errorType": "TypeError",
    "message": "Cannot read properties of undefined (reading 'total')",
    "environment": "staging",
    "resolvedAt": "2026-11-17T09:00:00.000Z",
    "ruleId": "5a2c7e10-3b4d-4e6f-8a9b-0c1d2e3f4a5b",
    "ruleName": "Regressions"
  },
  "message": "Shop: an error resolved on 2026-11-17 happened again, in staging. TypeError: Cannot read properties of undefined (reading 'total')",
  "url": "https://analytics.example.com/projects/0d6e5f80-0c4f-4b8e-9d3a-3f8f6a1c2b7e/errors/1-3f2a9c1d0b7e6a5f4c3d?env=%22staging%22"
}
```

#### `error.spike` and `error.spike_resolved`

```json
{
  "version": 1,
  "id": "af5b7a52-ad4a-4fa9-8d59-4e9eaf4e8f54",
  "type": "error.spike",
  "time": "2026-11-18T07:31:00.000Z",
  "project": {
    "id": "0d6e5f80-0c4f-4b8e-9d3a-3f8f6a1c2b7e",
    "name": "Shop"
  },
  "subject": {
    "type": "errors",
    "fingerprint": null,
    "environment": "production",
    "count": 27,
    "threshold": 20,
    "windowMinutes": 10,
    "ruleId": "5a2c7e10-3b4d-4e6f-8a9b-0c1d2e3f4a5b",
    "ruleName": "Error spike"
  },
  "message": "Shop: 27 errors in production in the last 10 minutes, at or above the rule's threshold of 20.",
  "url": "https://analytics.example.com/projects/0d6e5f80-0c4f-4b8e-9d3a-3f8f6a1c2b7e/errors?env=%22production%22"
}
```

With one group, `fingerprint` is its ID, the message names its type and message ("27 occurrences of TypeError: …"), and the link is the group's page, in the rule's environment or, for a rule over every environment, in the environment of the window's latest occurrence. `error.spike_resolved` has the same subject, with the count at that time, and a message such as `Shop: errors in production stayed below the threshold of 20 for 10 minutes: 4 in the last 10 minutes.`

#### `alert.held_back`

```json
{
  "version": 1,
  "id": "b06c8b63-be5b-4a0a-9e6a-5faf0a5f9a65",
  "type": "alert.held_back",
  "time": "2026-11-18T08:31:00.000Z",
  "project": {
    "id": "0d6e5f80-0c4f-4b8e-9d3a-3f8f6a1c2b7e",
    "name": "Shop"
  },
  "subject": {
    "type": "rule",
    "id": "5a2c7e10-3b4d-4e6f-8a9b-0c1d2e3f4a5b",
    "name": "New errors",
    "held": 35,
    "cap": 20
  },
  "message": "Shop: the alert rule \"New errors\" held back 35 more notifications after sending 20 in an hour, its limit. The rule's alert history in the dashboard lists every alert.",
  "url": "https://analytics.example.com/projects/0d6e5f80-0c4f-4b8e-9d3a-3f8f6a1c2b7e/alerts"
}
```

## The answer

Any `2xx` answer within 10 seconds counts as delivered; the body of the answer is not read. Anything else is a failure: a redirect (`3xx`, which is not followed), a `4xx` or `5xx`, no answer in time, or a connection that fails. A failure is retried after 30 seconds, then 1, 2, 5, 10, 20, and 20 minutes, eight attempts in about an hour, then given up. Each retry has a new timestamp and signature, with the same body and `Ottertrail-Delivery`.

Delivery is at least once: a receiver that answered too late, or whose answer was lost, gets the same notification again. Drop a repeat by its `id` (or `Ottertrail-Delivery`). A channel takes at most 60 deliveries an hour; past that, deliveries are recorded as failed without being sent.

## Checking the signature

1. Read the body as raw bytes, before any JSON parser changes it.
2. Refuse the request when `Ottertrail-Timestamp` is more than a few minutes from your clock: an old request replayed is refused even with a valid signature.
3. Compute the HMAC-SHA256 of `<timestamp>.<body>` with the channel's secret, and compare it with the hex after `v1=` in constant time.

In Node.js:

```js
import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = 300;

/** Whether a request came from your Ottertrail instance; `rawBody` is the body as sent, as text. */
export function verifyOttertrailWebhook(secret, headers, rawBody, now = Date.now()) {
  const timestamp = headers["ottertrail-timestamp"];
  const header = headers["ottertrail-signature"];
  if (typeof timestamp !== "string" || !/^\d+$/.test(timestamp)) return false;
  if (typeof header !== "string" || !header.startsWith("v1=")) return false;
  // Refuse a request sent long ago: a replay of one that was overheard.
  if (Math.abs(now / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
  const given = Buffer.from(header.slice(3), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

`headers` are the request's headers with lowercase names, as Node.js's `http` module gives them. The API's tests (`apps/api/tests/notifications-webhook.test.ts`) check real requests with this same function. Answer `2xx` quickly and do slow work afterwards: the request waits 10 seconds at most.
