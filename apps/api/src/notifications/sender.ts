import type { Buffer } from "node:buffer";

import type { Kysely } from "kysely";

import type { Database } from "../db/schema.ts";
import type { AddressPolicy, Lookup } from "../outbound/addresses.ts";
import { readInstanceSettings } from "../settings/settings.ts";
import {
  type AttemptOutcome,
  type DueDelivery,
  recordAttempt,
  takeDueDeliveries,
} from "./deliveries.ts";
import { type Mailer, sendEmail } from "./email.ts";
import { sendWebhook } from "./webhook.ts";

export const MAX_SENDING = 10;

export const DELIVERY_TICK_MS = 2000;

export const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export interface SenderOptions {
  db: Kysely<Database>;
  /** The SMTP server's mailer; null when SMTP_URL is unset. */
  mailer: Mailer | null;
  /** The uptime checks' address rules, which webhooks follow too. */
  policy: AddressPolicy;
  lookup?: Lookup | undefined;
  /** Certificates to trust besides the system's (tests). */
  ca?: string | Buffer | undefined;
  maxSending?: number;
  webhookTimeoutMs?: number;
  /** The moment deliveries are taken and recorded at (tests); PostgreSQL's now() when left out. */
  now?: () => Date;
  log?: (level: "info" | "error", msg: string, fields?: Record<string, unknown>) => void;
}

/**
 * Start due deliveries without waiting so a slow webhook uses only its own slot.
 * takeDueDeliveries advances attempts first; recordAttempt schedules retries or gives up.
 */
export class DeliverySender {
  readonly #options: SenderOptions;
  readonly #sending = new Set<Promise<void>>();

  constructor(options: SenderOptions) {
    this.#options = options;
  }

  get sending(): number {
    return this.#sending.size;
  }

  async tick(): Promise<number> {
    const { db, maxSending = MAX_SENDING, now } = this.#options;
    const due = await takeDueDeliveries(db, {
      limit: maxSending - this.#sending.size,
      now: now?.(),
    });
    for (const delivery of due) {
      const run: Promise<void> = this.deliver(delivery).then(
        () => undefined,
        () => undefined,
      );
      void run.finally(() => this.#sending.delete(run));
      this.#sending.add(run);
    }
    return due.length;
  }

  async drain(): Promise<void> {
    while (this.#sending.size > 0) await Promise.allSettled(this.#sending);
  }

  /** Sends one delivery and records the outcome; never throws. */
  async deliver(delivery: DueDelivery): Promise<AttemptOutcome> {
    const { db, log, now } = this.#options;
    let outcome: AttemptOutcome;
    try {
      outcome = await this.#send(delivery);
    } catch (error) {
      outcome = { ok: false, error: "The delivery failed unexpectedly." };
      log?.("error", "sending a notification failed unexpectedly", {
        delivery: delivery.id,
        err: String(error),
      });
    }
    try {
      const status = await recordAttempt(db, delivery, outcome, now?.());
      if (status === "failed") {
        log?.("info", "a notification could not be delivered", {
          delivery: delivery.id,
          channel: delivery.channelId,
          attempts: delivery.attempt,
        });
      }
    } catch (error) {
      log?.("error", "recording a notification's delivery failed", {
        delivery: delivery.id,
        err: String(error),
      });
    }
    return outcome;
  }

  async #send(delivery: DueDelivery): Promise<AttemptOutcome> {
    const { db, mailer, policy, lookup, ca, webhookTimeoutMs, now, log } = this.#options;
    if (delivery.kind === "email") {
      const settings = await readInstanceSettings(db);
      return sendEmail(mailer, delivery.addresses ?? [], delivery.payload, settings);
    }
    const result = await sendWebhook(
      { url: delivery.url ?? "", secret: delivery.secret ?? "", deliveryId: delivery.id },
      delivery.payload,
      {
        policy,
        lookup,
        ca,
        ...(webhookTimeoutMs === undefined ? {} : { timeoutMs: webhookTimeoutMs }),
        ...(now === undefined ? {} : { now }),
      },
    );
    if (!result.ok && result.refused !== undefined) {
      // Log refused addresses privately; dashboard errors hide them.
      log?.("info", "a webhook's address was refused", {
        delivery: delivery.id,
        channel: delivery.channelId,
        ...result.refused,
      });
    }
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }
}
