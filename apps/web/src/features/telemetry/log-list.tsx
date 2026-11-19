import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { logQuery, type LogSummary, severityOf } from "@/lib/logs-api";
import { cn } from "@/lib/utils";

import { AttributeTable } from "./attributes";
import { formatPreciseMoment } from "./format";

const TONES: Record<string, StatusTone> = {
  warn: "warning",
  error: "critical",
  fatal: "critical",
};

/** A record's severity as the sender named it, or its range's name, as an icon and a label. */
export function SeverityBadge({ log }: { log: LogSummary }) {
  const range = severityOf(log.severityNumber);
  const label = log.severityText !== "" ? log.severityText : (range?.label ?? "No severity");
  return (
    <StatusBadge
      tone={range === undefined ? "neutral" : (TONES[range.value] ?? "neutral")}
      title={
        range === undefined
          ? "The sender named no severity"
          : `${range.label} (severity ${log.severityNumber})`
      }
    >
      {label}
    </StatusBadge>
  );
}

/** The record's trace: a link to its page, or on that page, a button that shows its span. */
function TraceFacts({
  log,
  projectId,
  onSpan,
  spanName,
  inWorkbench,
}: {
  log: LogSummary & { traceId: string };
  projectId: string;
  onSpan: ((spanId: string) => void) | undefined;
  spanName: string | undefined;
  inWorkbench: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-ink-subtle">Trace</dt>
      <dd className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        {onSpan === undefined && inWorkbench ? (
          // Beside the logs list: the trace opens in the Traces workbench, on its span.
          <Link
            to="/projects/$projectId/traces"
            params={{ projectId }}
            search={{
              trace: log.traceId.toLowerCase(),
              at: log.time,
              ...(log.spanId === null ? {} : { span: log.spanId }),
            }}
            className="font-mono text-link hover:underline"
            aria-label={`Open trace ${log.traceId}`}
          >
            {log.traceId}
          </Link>
        ) : onSpan === undefined ? (
          <Link
            to="/projects/$projectId/traces/$traceId"
            params={{ projectId, traceId: log.traceId }}
            search={{ at: log.time, ...(log.spanId === null ? {} : { span: log.spanId }) }}
            className="font-mono text-link hover:underline"
            aria-label={`Open trace ${log.traceId}`}
          >
            {log.traceId}
          </Link>
        ) : (
          <span className="font-mono text-ink-muted">{log.traceId}</span>
        )}
        {log.spanId !== null &&
          (onSpan !== undefined && spanName !== undefined ? (
            <Button variant="outline" size="sm" onClick={() => onSpan(log.spanId ?? "")}>
              Show its span: {spanName}
            </Button>
          ) : (
            <span className="text-xs text-ink-subtle">
              span <span className="font-mono">{log.spanId}</span>
            </span>
          ))}
      </dd>
    </div>
  );
}

const hasTrace = (log: LogSummary): log is LogSummary & { traceId: string } => log.traceId !== null;

/**
 * An opened record: its whole body, times, labels, attributes, and
 * resource attributes, read now (a list holds only a summary of each), and
 * its trace. Under a row it opened, and in the Logs workbench beside the
 * list (`inWorkbench`), where the trace's link opens the Traces workbench.
 */
export function LogRecordView({
  summary,
  timeZone,
  projectId,
  onSpan,
  spanName,
  inWorkbench = false,
}: {
  summary: LogSummary;
  timeZone: string;
  projectId: string;
  onSpan: ((spanId: string) => void) | undefined;
  spanName: string | undefined;
  inWorkbench?: boolean;
}) {
  const query = useQuery(logQuery(projectId, summary));
  const log = query.data?.log;
  const facts =
    log === undefined
      ? []
      : [
          { label: "Time", value: formatPreciseMoment(log.time, timeZone) },
          { label: "Observed", value: formatPreciseMoment(log.observedTime, timeZone) },
          { label: "Service", value: log.service || "(none)" },
          { label: "Release", value: log.release || "(none)" },
          { label: "Environment", value: log.environment },
          ...(log.eventName === "" ? [] : [{ label: "Event", value: log.eventName }]),
          {
            label: "Scope",
            value:
              log.scope.name === ""
                ? "(none)"
                : [log.scope.name, log.scope.version].join(" ").trim(),
          },
        ];
  return (
    <div
      className={
        inWorkbench
          ? "@container flex flex-col gap-4"
          : "flex flex-col gap-4 border-t px-3 pt-3 pb-4"
      }
    >
      {hasTrace(summary) && (
        <dl>
          <TraceFacts
            log={summary}
            projectId={projectId}
            onSpan={onSpan}
            spanName={spanName}
            inWorkbench={inWorkbench}
          />
        </dl>
      )}
      {query.isPending ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading the record">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : query.isError ? (
        <Alert variant="destructive">
          <OctagonAlertIcon />
          <AlertTitle>The record could not load</AlertTitle>
          <AlertDescription>{query.error.message}</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : (
        <>
          <pre className="max-h-96 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs [overflow-wrap:anywhere] whitespace-pre-wrap text-ink">
            {query.data.log.body === "" ? "(empty body)" : query.data.log.body}
          </pre>
          <dl
            className={
              inWorkbench
                ? "grid gap-x-6 gap-y-3 text-sm @md:grid-cols-2 @2xl:grid-cols-3"
                : "grid gap-x-6 gap-y-3 text-sm sm:grid-cols-3"
            }
          >
            {facts.map((fact) => (
              <div key={fact.label} className="flex min-w-0 flex-col gap-0.5">
                <dt className="text-xs text-ink-subtle">{fact.label}</dt>
                <dd className="break-words text-ink">{fact.value}</dd>
              </div>
            ))}
          </dl>
          <section className="flex flex-col gap-2">
            <h4 className="text-sm font-medium text-ink">Attributes</h4>
            <AttributeTable caption="Attributes" attributes={query.data.log.attributes} />
          </section>
          <section className="flex flex-col gap-2">
            <h4 className="text-sm font-medium text-ink">Resource attributes</h4>
            <AttributeTable
              caption="Resource attributes"
              attributes={query.data.log.resourceAttributes}
            />
          </section>
        </>
      )}
    </div>
  );
}

function Entry({
  log,
  timeZone,
  projectId,
  onSpan,
  spanNames,
  initiallyOpen,
}: {
  log: LogSummary;
  timeZone: string;
  projectId: string;
  onSpan: ((spanId: string) => void) | undefined;
  spanNames: ReadonlyMap<string, string> | undefined;
  initiallyOpen: boolean;
}) {
  const [open, setOpen] = React.useState(initiallyOpen);
  const detailId = React.useId();
  return (
    <li className="rounded-lg ring-1 ring-border">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "mt-0.5 size-4 shrink-0 text-ink-subtle transition-transform motion-reduce:transition-none",
            {
              "rotate-90": open,
            },
          )}
        />
        <time dateTime={log.time} className="shrink-0 font-mono text-xs leading-5 text-ink-muted">
          {formatPreciseMoment(log.time, timeZone)}
        </time>
        <SeverityBadge log={log} />
        {log.service !== "" && (
          <span className="hidden shrink-0 text-xs leading-5 text-ink-subtle sm:inline">
            {log.service}
          </span>
        )}
        <span className="line-clamp-2 min-w-0 flex-1 font-mono text-xs leading-5 break-words text-ink">
          {log.body === "" ? <span className="font-sans text-ink-subtle">(empty)</span> : log.body}
          {log.bodyTruncated && "…"}
        </span>
      </button>
      {open && (
        <div id={detailId}>
          <LogRecordView
            summary={log}
            timeZone={timeZone}
            projectId={projectId}
            onSpan={onSpan}
            spanName={log.spanId === null ? undefined : spanNames?.get(log.spanId)}
          />
        </div>
      )}
    </li>
  );
}

/**
 * Log records, each a row that opens to its whole body, attributes,
 * resource attributes, and its trace: a link to the trace's page, or, on
 * that page, a button that shows its span.
 */
export function LogList({
  logs,
  timeZone,
  projectId,
  label,
  onSpan,
  spanNames,
  openId,
}: {
  logs: readonly LogSummary[];
  timeZone: string;
  projectId: string;
  label: string;
  /** On a trace's page: selects the record's span in the waterfall. */
  onSpan?: (spanId: string) => void;
  /** The trace's spans' names, by span ID, for the button. */
  spanNames?: ReadonlyMap<string, string>;
  /** A record shown open from the start, such as one an address names. */
  openId?: string;
}) {
  return (
    <ul aria-label={label} className="flex flex-col gap-2">
      {logs.map((log) => (
        <Entry
          key={log.id}
          log={log}
          timeZone={timeZone}
          projectId={projectId}
          onSpan={onSpan}
          spanNames={spanNames}
          initiallyOpen={log.id === openId}
        />
      ))}
    </ul>
  );
}
