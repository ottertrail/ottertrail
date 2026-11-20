import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { OctagonAlertIcon } from "lucide-react";
import type * as React from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { isTraceId } from "@/lib/logs-api";
import { type SpanDetail, type SpanKind, spanQuery, type WaterfallSpan } from "@/lib/traces-api";

import { formatWhole } from "../analytics/format";
import { AttributeTable } from "./attributes";
import { formatDuration, formatOffset, formatPreciseMoment } from "./format";

const KIND_LABELS: Record<SpanKind, string> = {
  unspecified: "Unspecified",
  internal: "Internal",
  server: "Server",
  client: "Client",
  producer: "Producer",
  consumer: "Consumer",
};

const STATUS_LABELS = { unset: "Unset", ok: "OK", error: "Error" } as const;

/** "3 more were dropped", when the sender or Ottertrail dropped some. */
function Dropped({ count, noun }: { count: number; noun: string }) {
  if (count === 0) return null;
  return (
    <p className="text-xs text-ink-subtle">
      {formatWhole(count)} more {noun} {count === 1 ? "was" : "were"} dropped before storing.
    </p>
  );
}

function Facts({
  span,
  row,
  parentName,
  timeZone,
}: {
  span: SpanDetail;
  row: WaterfallSpan;
  parentName: string | undefined;
  timeZone: string;
}) {
  const facts: { label: string; value: React.ReactNode; mono?: boolean }[] = [
    { label: "Service", value: span.service || "(none)" },
    { label: "Kind", value: KIND_LABELS[span.kind] },
    {
      label: "Status",
      value:
        span.statusMessage === ""
          ? STATUS_LABELS[span.status]
          : `${STATUS_LABELS[span.status]}: ${span.statusMessage}`,
    },
    { label: "Start", value: formatPreciseMoment(span.start, timeZone) },
    { label: "Duration", value: formatDuration(span.durationUs) },
    { label: "From the trace's start", value: formatOffset(row.offsetUs) },
    { label: "Span ID", value: span.spanId, mono: true },
    {
      label: "Parent",
      value:
        span.parentSpanId === ""
          ? "None: a root span"
          : parentName === undefined
            ? `${span.parentSpanId} (not received)`
            : `${parentName} (${span.parentSpanId})`,
      mono: span.parentSpanId !== "" && parentName === undefined,
    },
    { label: "Release", value: span.release || "(none)" },
    { label: "Environment", value: span.environment },
    {
      label: "Scope",
      value: span.scope.name === "" ? "(none)" : `${span.scope.name} ${span.scope.version}`.trim(),
    },
  ];
  return (
    <dl className="grid gap-x-6 gap-y-3 text-sm @lg:grid-cols-2 @3xl:grid-cols-3">
      {facts.map((fact) => (
        <div key={fact.label} className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-xs text-ink-subtle">{fact.label}</dt>
          <dd className={fact.mono ? "font-mono break-all text-ink" : "break-words text-ink"}>
            {fact.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The selected span: what it is, its attributes, events (with theirs),
 * links, and its resource's attributes. Read when selected: a trace's
 * page lists only what the waterfall needs.
 */
export function SpanDetailCard({
  projectId,
  traceId,
  span,
  parentName,
  ref,
  inWorkbench = false,
}: {
  projectId: string;
  traceId: string;
  span: WaterfallSpan;
  parentName: string | undefined;
  ref?: React.Ref<HTMLElement>;
  /** Beside the traces list: a linked trace opens there, not on its own page. */
  inWorkbench?: boolean;
}) {
  const query = useQuery(spanQuery(projectId, traceId, span));
  return (
    <section
      ref={ref}
      aria-labelledby="span-detail-title"
      tabIndex={-1}
      className="rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Card>
        <CardHeader>
          <CardTitle>
            <h3 id="span-detail-title" className="break-words">
              Span: {span.name === "" ? "(no name)" : span.name}
            </h3>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {query.isPending ? (
            <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading the span">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : query.isError ? (
            <Alert variant="destructive">
              <OctagonAlertIcon />
              <AlertTitle>The span could not load</AlertTitle>
              <AlertDescription>{query.error.message}</AlertDescription>
              <AlertAction>
                <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                  Retry
                </Button>
              </AlertAction>
            </Alert>
          ) : (
            <>
              <Facts
                span={query.data.span}
                row={span}
                parentName={parentName}
                timeZone={query.data.timeZone}
              />
              <section className="flex flex-col gap-2">
                <h4 className="text-sm font-medium text-ink">Attributes</h4>
                <AttributeTable caption="Span attributes" attributes={query.data.span.attributes} />
                <Dropped count={query.data.span.droppedAttributes} noun="attributes" />
              </section>
              <section className="flex flex-col gap-2">
                <h4 className="text-sm font-medium text-ink">Events</h4>
                {query.data.span.events.length === 0 ? (
                  <p className="text-sm text-ink-subtle">None.</p>
                ) : (
                  <ol aria-label="Events, in the order sent" className="flex flex-col gap-3">
                    {query.data.span.events.map((event, index) => (
                      <li
                        // Events have no ID; their order is fixed.
                        // oxlint-disable-next-line react/no-array-index-key
                        key={index}
                        className="flex flex-col gap-2 rounded-lg p-3 ring-1 ring-border"
                      >
                        <p className="flex flex-wrap items-baseline gap-x-3 text-sm">
                          <span className="font-medium text-ink">{event.name || "(no name)"}</span>
                          {event.offsetUs !== null && event.time !== null && (
                            <time
                              dateTime={event.time}
                              className="font-mono text-xs text-ink-subtle"
                              title={formatPreciseMoment(event.time, query.data.timeZone)}
                            >
                              {event.offsetUs < 0
                                ? `${formatDuration(-event.offsetUs)} before the span's start`
                                : `${formatOffset(event.offsetUs)} from the span's start`}
                            </time>
                          )}
                        </p>
                        <AttributeTable
                          caption={`Attributes of event ${event.name}`}
                          attributes={event.attributes}
                        />
                      </li>
                    ))}
                  </ol>
                )}
                <Dropped count={query.data.span.droppedEvents} noun="events" />
              </section>
              <section className="flex flex-col gap-2">
                <h4 className="text-sm font-medium text-ink">Links</h4>
                {query.data.span.links.length === 0 ? (
                  <p className="text-sm text-ink-subtle">None.</p>
                ) : (
                  <ul aria-label="Linked spans" className="flex flex-col gap-3">
                    {query.data.span.links.map((link, index) => (
                      <li
                        // A span may link one span twice; links keep the order sent.
                        key={`${index}-${link.traceId}-${link.spanId}`}
                        className="flex flex-col gap-2 rounded-lg p-3 ring-1 ring-border"
                      >
                        <p className="flex flex-wrap items-baseline gap-x-3 text-sm">
                          {isTraceId(link.traceId) && inWorkbench ? (
                            <Link
                              to="/projects/$projectId/traces"
                              params={{ projectId }}
                              search={(previous) => ({
                                ...previous,
                                trace: link.traceId.toLowerCase(),
                                span: link.spanId,
                                at: undefined,
                              })}
                              className="font-mono text-link hover:underline"
                              aria-label={`Open linked trace ${link.traceId}`}
                            >
                              {link.traceId}
                            </Link>
                          ) : isTraceId(link.traceId) ? (
                            <Link
                              to="/projects/$projectId/traces/$traceId"
                              params={{ projectId, traceId: link.traceId }}
                              search={{ span: link.spanId }}
                              className="font-mono text-link hover:underline"
                              aria-label={`Open linked trace ${link.traceId}`}
                            >
                              {link.traceId}
                            </Link>
                          ) : (
                            <span className="font-mono text-ink-muted">
                              {link.traceId || "(no trace ID)"}
                            </span>
                          )}
                          <span className="text-xs text-ink-subtle">
                            span <span className="font-mono">{link.spanId}</span>
                          </span>
                        </p>
                        <AttributeTable
                          caption={`Attributes of the link to ${link.spanId}`}
                          attributes={link.attributes}
                        />
                      </li>
                    ))}
                  </ul>
                )}
                <Dropped count={query.data.span.droppedLinks} noun="links" />
              </section>
              <section className="flex flex-col gap-2">
                <h4 className="text-sm font-medium text-ink">Resource attributes</h4>
                <AttributeTable
                  caption="Resource attributes"
                  attributes={query.data.span.resourceAttributes}
                />
              </section>
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
