import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";

import {
  type AddressPolicy,
  AddressNotAllowedError,
  type Lookup,
  resolveTarget,
  systemLookup,
} from "../outbound/addresses.ts";
import { classifyRequestError, pinnedRequest, untilAborted } from "../outbound/request.ts";
import { OTTERTRAIL_VERSION } from "../version.ts";
import type { NotificationPayload } from "./events.ts";

/**
 * A webhook's request (docs/webhooks.md): a JSON POST, signed with the
 * channel's secret, sent to the address the uptime checks' rules allow
 * (outbound/), resolved again on every delivery and pinned, so DNS cannot
 * point it elsewhere between the check and the connection. Any 2xx
 * answer counts as delivered; a redirect is not followed; the answer's
 * body is never read.
 */

/** A webhook's time to answer, from resolving its host to the answer's headers. */
export const WEBHOOK_TIMEOUT_MS = 10_000;

export const USER_AGENT = `Ottertrail/${OTTERTRAIL_VERSION} (webhooks)`;

/**
 * The signature of a body sent at `timestamp` (Unix seconds): HMAC-SHA256
 * of "<timestamp>.<body>", keyed with the secret's text, in hex.
 */
export function signature(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export interface WebhookOptions {
  policy: AddressPolicy;
  lookup?: Lookup | undefined;
  /** Certificates to trust besides the system's (tests). */
  ca?: string | Buffer | undefined;
  timeoutMs?: number | undefined;
  /** The clock the timestamp is read from (tests). */
  now?: () => Date;
}

/** How a webhook delivery went; `refused` holds a refused address for the log only. */
export type WebhookResult =
  | { ok: true; status: number }
  | {
      ok: false;
      error: string;
      status?: number | undefined;
      refused?: { host: string; address: string; kind: string } | undefined;
    };

class TimeoutError extends Error {
  override name = "TimeoutError";
}

/** Sends one delivery's body to a webhook; never throws. */
export async function sendWebhook(
  webhook: { url: string; secret: string; deliveryId: string },
  payload: NotificationPayload,
  { policy, lookup = systemLookup, ca, timeoutMs = WEBHOOK_TIMEOUT_MS, now }: WebhookOptions,
): Promise<WebhookResult> {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor((now?.() ?? new Date()).getTime() / 1000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new TimeoutError("timed out")), timeoutMs);
  const { signal } = controller;
  try {
    const url = new URL(webhook.url);
    const target = await untilAborted(
      resolveTarget(url, { lookup, policy, signal, who: "webhooks" }),
      signal,
    );
    const { response } = await pinnedRequest(url, {
      method: "POST",
      target,
      signal,
      ca,
      body,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "user-agent": USER_AGENT,
        "ottertrail-event": payload.type,
        "ottertrail-delivery": webhook.deliveryId,
        "ottertrail-timestamp": String(timestamp),
        "ottertrail-signature": `v1=${signature(webhook.secret, timestamp, body)}`,
        connection: "close",
      },
    });
    const status = response.statusCode ?? 0;
    // The answer's body is not read.
    response.destroy();
    if (status >= 200 && status < 300) return { ok: true, status };
    if (status >= 300 && status < 400) {
      return {
        ok: false,
        status,
        error: `It answered ${status}, a redirect, which webhooks do not follow: use the final URL.`,
      };
    }
    return { ok: false, status, error: `It answered ${status}; a webhook must answer 2xx.` };
  } catch (error) {
    if (signal.aborted && signal.reason instanceof TimeoutError) {
      return { ok: false, error: `No answer within ${timeoutMs / 1000} seconds.` };
    }
    return {
      ok: false,
      error: classifyRequestError(error).detail,
      ...(error instanceof AddressNotAllowedError
        ? { refused: { host: error.host, address: error.address, kind: error.kind } }
        : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}
