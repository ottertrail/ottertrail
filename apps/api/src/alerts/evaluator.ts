import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import type { Reader } from "../clickhouse/query.ts";
import { tellAssigneesOfRegressions } from "../errors/assignments.ts";
import { pruneInbox } from "../notifications/inbox.ts";
import type { StateChange } from "../uptime/checks.ts";
import { evaluateCertificates, evaluateCheckDown } from "./check-rules.ts";
import { ARRIVAL_LAG_MS, evaluateErrorRules, MAX_CATCH_UP_MS } from "./error-rules.ts";
import { type AlertContext, flushHeldBack } from "./fire.ts";
import { endOrphanedCheckAlerts, pruneHistory } from "./rules.ts";
import {
  countsOf,
  evaluateTelemetryPass,
  type PassOptions,
  type PassResult,
  recordEvaluation,
  releaseRules,
  takeDueRules,
} from "./telemetry-rules.ts";

export const ALERT_TICK_MS = 60_000;
/** How often every certificate is looked at again, besides when a run sees a new one. */
export const CERTIFICATE_INTERVAL_MS = 60 * 60 * 1000;
export const HISTORY_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Coordinate check, error, telemetry, and AI rules (docs/uptime-alerts.md, "Alerts"). Check
 * callbacks run immediately; tick catches missed changes and handles error rules and hourly
 * cleanup. Telemetry runs on a separate loop, a few projects at a time (telemetry-rules.ts).
 * Each step logs failures independently. stop() lets running rules finish and prevents new
 * evaluations.
 */
export class AlertEvaluator {
  readonly #context: AlertContext;
  readonly #reader: Reader;
  readonly #now: () => Date;
  readonly #telemetry: Omit<PassOptions, "now" | "stopping">;
  #certificatesAt = 0;
  #prunedAt = 0;
  #inboxPrunedAt = 0;
  /** The end of the arrivals the last regression pass read (ms); none yet after a start. */
  #regressionsThrough: number | null = null;
  #stopping = false;

  constructor({
    clickhouse,
    now = () => new Date(),
    telemetry = {},
    ...context
  }: AlertContext & {
    clickhouse: ClickHouseClient;
    now?: () => Date;
    /** How telemetry rules are read and bounded (tests pass their own). */
    telemetry?: Partial<Omit<PassOptions, "now" | "stopping">>;
  }) {
    this.#context = context;
    this.#reader = { client: clickhouse };
    this.#now = now;
    this.#telemetry = {
      // Limit each query to the project's remaining budget; abort any still running when it
      // expires.
      readerOf: (_projectId, deadline) => ({
        client: clickhouse,
        deadline,
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      }),
      ...telemetry,
    };
  }

  /** Let running telemetry rules finish; start no more. */
  stop(): void {
    this.#stopping = true;
  }

  #failed(step: string, error: unknown) {
    this.#context.log?.("error", `alert rules: ${step} failed`, { err: String(error) });
  }

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

  async onCertificate(check: { checkId: string; projectId: string }): Promise<void> {
    try {
      await evaluateCertificates(this.#context, check, this.#now());
    } catch (error) {
      this.#failed("a check's new certificate", error);
    }
  }

  /** Claim due rules for this worker and evaluate a few projects at a time. */
  async telemetryTick(): Promise<PassResult[]> {
    if (this.#stopping) return [];
    let results: PassResult[] = [];
    try {
      const rules = await takeDueRules(this.#context.db, this.#now());
      if (rules.length === 0) return [];
      const pass = await evaluateTelemetryPass(this.#context, rules, {
        ...this.#telemetry,
        now: this.#now,
        stopping: () => this.#stopping,
      });
      results = pass.results;
      await releaseRules(
        this.#context.db,
        pass.released.map((rule) => rule.id),
      );
    } catch (error) {
      this.#failed("telemetry rules", error);
      return results;
    }
    for (const item of results) {
      const fields = { rule: item.rule.id, project: item.rule.projectId };
      const error = "error" in item ? item.error : null;
      try {
        const change = await recordEvaluation(this.#context.db, item.rule.id, error, this.#now());
        if (change === "failing") {
          this.#context.log?.("error", "alert rules: evaluating a telemetry rule failed", {
            ...fields,
            err: String(error),
          });
        } else if (change === "recovered") {
          this.#context.log?.("info", "alert rules: a telemetry rule evaluates again", fields);
        }
      } catch (recording) {
        this.#failed("recording a telemetry rule's evaluation", recording);
      }
    }
    const counts = countsOf(results);
    if (counts.sent + counts.held > 0) {
      this.#context.log?.("info", "telemetry alerts sent", { ...counts });
    }
    return results;
  }

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
    // After startup or a gap, read at most MAX_CATCH_UP_MS of arrivals. Notifications are
    // deduplicated per resolution.
    const until = at.getTime() - ARRIVAL_LAG_MS;
    const from = Math.max(this.#regressionsThrough ?? 0, until - MAX_CATCH_UP_MS);
    if (from < until) {
      try {
        await tellAssigneesOfRegressions(this.#context.db, this.#reader, {
          from: new Date(from),
          until: new Date(until),
        });
        this.#regressionsThrough = until;
      } catch (error) {
        this.#failed("telling assignees of regressions", error);
      }
    }
    // Retry each failed hourly cleanup next minute without repeating successful ones.
    if (at.getTime() - this.#prunedAt >= HISTORY_PRUNE_INTERVAL_MS) {
      try {
        const pruned = await pruneHistory(this.#context.db, at);
        if (pruned > 0) this.#context.log?.("info", "old alerts deleted", { pruned });
        this.#prunedAt = at.getTime();
      } catch (error) {
        this.#failed("deleting old alerts", error);
      }
    }
    if (at.getTime() - this.#inboxPrunedAt >= HISTORY_PRUNE_INTERVAL_MS) {
      try {
        const pruned = await pruneInbox(this.#context.db, at);
        if (pruned > 0) this.#context.log?.("info", "old notifications deleted", { pruned });
        this.#inboxPrunedAt = at.getTime();
      } catch (error) {
        this.#failed("deleting old notifications", error);
      }
    }
  }
}
