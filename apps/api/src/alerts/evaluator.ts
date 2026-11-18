import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import type { Reader } from "../clickhouse/query.ts";
import type { StateChange } from "../uptime/checks.ts";
import { evaluateCertificates, evaluateCheckDown } from "./check-rules.ts";
import { evaluateErrorRules } from "./error-rules.ts";
import { type AlertContext, flushHeldBack } from "./fire.ts";
import { endOrphanedCheckAlerts, pruneHistory } from "./rules.ts";

/** How often the worker evaluates alert rules. */
export const ALERT_TICK_MS = 60_000;
/** How often every certificate is looked at again, besides when a run sees a new one. */
export const CERTIFICATE_INTERVAL_MS = 60 * 60 * 1000;
/** How often alerts past their 90 days are deleted. */
export const HISTORY_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The worker's alert rules (docs/uptime-alerts.md, "Alerts"):
 *
 * - onStateChange and onCertificate act on one check as soon as the
 *   checker records a change, so a check's alert goes out within seconds.
 * - tick, every minute: check-down rules for every check (catching up a
 *   change the worker stopped before acting on, and ending, silently, any
 *   alert left firing for a check that no longer exists), error rules, the
 *   summaries of what rules' hourly caps held back; every hour,
 *   certificates (whose window moves with time) and the history's pruning.
 *
 * Each step logs its own failure and lets the others go on.
 */
export class AlertEvaluator {
  readonly #context: AlertContext;
  readonly #reader: Reader;
  readonly #now: () => Date;
  #certificatesAt = 0;
  #prunedAt = 0;

  constructor({
    clickhouse,
    now = () => new Date(),
    ...context
  }: AlertContext & { clickhouse: ClickHouseClient; now?: () => Date }) {
    this.#context = context;
    this.#reader = { client: clickhouse };
    this.#now = now;
  }

  #failed(step: string, error: unknown) {
    this.#context.log?.("error", `alert rules: ${step} failed`, { err: String(error) });
  }

  /** A check went down or came back up: its check-down rules, now. */
  async onStateChange(change: Pick<StateChange, "checkId" | "projectId">): Promise<void> {
    try {
      await evaluateCheckDown(
        this.#context,
        { projectId: change.projectId, checkId: change.checkId },
        this.#now(),
      );
    } catch (error) {
      this.#failed("a check's state change", error);
    }
  }

  /** A run recorded a new certificate expiry: the check's certificate rules, now. */
  async onCertificate(check: { checkId: string; projectId: string }): Promise<void> {
    try {
      await evaluateCertificates(this.#context, check, this.#now());
    } catch (error) {
      this.#failed("a check's new certificate", error);
    }
  }

  /** One minute's evaluation. */
  async tick(): Promise<void> {
    const at = this.#now();
    try {
      await endOrphanedCheckAlerts(this.#context.db, at);
      await evaluateCheckDown(this.#context, {}, at);
    } catch (error) {
      this.#failed("check-down rules", error);
    }
    if (at.getTime() - this.#certificatesAt >= CERTIFICATE_INTERVAL_MS) {
      try {
        await evaluateCertificates(this.#context, {}, at);
        this.#certificatesAt = at.getTime();
      } catch (error) {
        this.#failed("certificate rules", error);
      }
    }
    try {
      // Each project's failure is logged within; this catches PostgreSQL's.
      await evaluateErrorRules(this.#context, this.#reader, at);
    } catch (error) {
      this.#failed("error rules", error);
    }
    try {
      await flushHeldBack(this.#context, at);
    } catch (error) {
      this.#failed("held-back summaries", error);
    }
    if (at.getTime() - this.#prunedAt >= HISTORY_PRUNE_INTERVAL_MS) {
      try {
        const pruned = await pruneHistory(this.#context.db, at);
        if (pruned > 0) this.#context.log?.("info", "old alerts deleted", { pruned });
        this.#prunedAt = at.getTime();
      } catch (error) {
        this.#failed("deleting old alerts", error);
      }
    }
  }
}
