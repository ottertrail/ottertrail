import { useQuery } from "@tanstack/react-query";
import { OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { ReportChart } from "@/components/report-chart";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { PageRange } from "@/lib/analytics-api";
import { databasesTrendQuery } from "@/lib/databases-api";
import { STATUS_CLASSES, servicesTrendQuery } from "@/lib/services-api";

import { ChartSection } from "./chart-card";
import { stepText } from "./chart-time";
import { durationFormat, formatNumber } from "./metric-format";
import { SLOTS } from "./split-colors";
import { STATUS_COLORS, STATUS_LABELS } from "./status-format";
import type { ChartLine } from "./time-chart";

/** Load trend charts independently so failures cannot block the lists. */

interface View {
  value: string;
  label: string;
  title: string;
  description: string;
  lines: ChartLine[];
  formatValue: (value: number) => string;
  domain?: { min: number; max: number };
}

function ViewToggle({
  views,
  chosen,
  onChoose,
  label,
}: {
  views: readonly { value: string; label: string }[];
  chosen: string;
  onChoose: (value: string) => void;
  label: string;
}) {
  return (
    <ToggleGroup
      value={[chosen]}
      onValueChange={(next: string[]) => {
        const [value] = next;
        if (value !== undefined) onChoose(value);
      }}
      aria-label={label}
      variant="outline"
      size="sm"
      spacing={0}
    >
      {views.map((view) => (
        <ToggleGroupItem key={view.value} value={view.value}>
          {view.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function TrendSection({
  title,
  query,
  empty,
  views,
  subject,
  toggleLabel,
}: {
  title: string;
  query: {
    data: { start: string; stepSeconds: number; buckets: number; timeZone: string } | undefined;
    isError: boolean;
    error: Error | null;
    isPlaceholderData: boolean;
    refetch: () => unknown;
  };
  empty: string | undefined;
  views: View[];
  subject: string;
  toggleLabel: string;
}) {
  const [chosen, setChosen] = React.useState(views[0]?.value ?? "");
  const view = views.find((item) => item.value === chosen) ?? views[0];
  const { data } = query;
  const failure = query.isError && (
    <Alert variant="destructive">
      <OctagonAlertIcon />
      <AlertTitle>
        {data === undefined ? "The chart could not load" : "The chart could not refresh"}
      </AlertTitle>
      <AlertDescription>
        {query.error?.message}
        {data !== undefined && " The chart below is from the last successful load."}
      </AlertDescription>
      <AlertAction>
        <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </AlertAction>
    </Alert>
  );
  if (data === undefined || view === undefined) {
    return (
      <ReportChart title={title} headingLevel={2}>
        {failure || (
          <Skeleton
            className="h-[180px] w-full"
            aria-busy="true"
            aria-label={`Loading the chart of ${subject}`}
          />
        )}
      </ReportChart>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {failure}
      <div
        className="transition-opacity data-[stale=true]:opacity-60"
        data-stale={query.isPlaceholderData}
        aria-busy={query.isPlaceholderData}
      >
        <ChartSection
          headingLevel={2}
          title={view.title}
          description={view.description}
          frame={data}
          subject={subject}
          lines={view.lines}
          formatValue={view.formatValue}
          domain={view.domain}
          missing={empty}
          actions={
            empty === undefined ? (
              <ViewToggle
                views={views}
                chosen={view.value}
                onChoose={setChosen}
                label={toggleLabel}
              />
            ) : undefined
          }
        />
      </div>
    </div>
  );
}

const formatShare = (percent: number) => `${formatNumber(percent)}%`;

export function ServicesTrend({
  projectId,
  range,
  environment,
}: {
  projectId: string;
  range: PageRange;
  environment: string;
}) {
  const trend = useQuery(servicesTrendQuery(projectId, range, environment));
  const data = trend.data;
  const step = data === undefined ? "" : stepText(data.stepSeconds);
  const classes =
    data === undefined ? [] : STATUS_CLASSES.filter((name) => data.totals.statuses[name] > 0);
  const duration = durationFormat(data?.durations.p95Us ?? []);
  const views: View[] =
    data === undefined
      ? []
      : [
          {
            value: "requests",
            label: "Requests",
            title: "Requests per second",
            description: `Requests per second in each ${step}, across every service, by status class: ${classes
              .map((name) => STATUS_LABELS[name])
              .join(", ")}.`,
            lines: classes.map((name) => ({
              key: name,
              label: STATUS_LABELS[name],
              color: STATUS_COLORS[name],
              values: data.perSecond[name],
            })),
            formatValue: (value) => `${formatNumber(value)}/s`,
          },
          {
            value: "failed",
            label: "Failed",
            title: "Failed (%)",
            description: `The share of requests with status Error in each ${step}, across every service. A gap means no request arrived.`,
            lines: [
              {
                key: "failed",
                label: "Failed",
                color: SLOTS[4] ?? "",
                values: data.failedShare.map((share) => (share === null ? null : share * 100)),
              },
            ],
            formatValue: formatShare,
            domain: { min: 0, max: 100 },
          },
          {
            value: "p95",
            label: "95th percentile",
            title: `95th percentile (${duration.unit})`,
            description: `The 95th percentile of request durations in each ${step}, across every service. A gap means no request arrived.`,
            lines: [
              {
                key: "p95",
                label: "95th percentile",
                color: SLOTS[6] ?? "",
                values: data.durations.p95Us,
              },
            ],
            formatValue: duration.format,
          },
        ];
  return (
    <TrendSection
      title="Requests per second"
      query={trend}
      empty={
        data !== undefined && data.totals.requests === 0
          ? "No request arrived in this period."
          : undefined
      }
      views={views}
      subject="every service"
      toggleLabel="What to chart"
    />
  );
}

export function DatabasesTrend({
  projectId,
  range,
  environment,
}: {
  projectId: string;
  range: PageRange;
  environment: string;
}) {
  const trend = useQuery(databasesTrendQuery(projectId, range, environment));
  const data = trend.data;
  const step = data === undefined ? "" : stepText(data.stepSeconds);
  const time = durationFormat(data?.counts.totalUs ?? []);
  const views: View[] =
    data === undefined
      ? []
      : [
          {
            value: "calls",
            label: "Calls per second",
            title: "Calls per second",
            description: `Calls per second in each ${step}, across every database.`,
            lines: [
              {
                key: "calls",
                label: "Calls per second",
                color: SLOTS[0] ?? "",
                values: data.perSecond,
              },
            ],
            formatValue: (value) => `${formatNumber(value)}/s`,
          },
          {
            value: "time",
            label: "Time spent",
            title: `Time spent per ${step} (${time.unit})`,
            description: `The durations of the calls in each ${step}, added up, across every database.`,
            lines: [
              {
                key: "time",
                label: "Time spent",
                color: SLOTS[1] ?? "",
                values: data.counts.totalUs,
              },
            ],
            formatValue: time.format,
          },
        ];
  return (
    <TrendSection
      title="Calls per second"
      query={trend}
      empty={
        data !== undefined && data.totals.calls === 0
          ? "No database call in this period."
          : undefined
      }
      views={views}
      subject="every database"
      toggleLabel="What to chart"
    />
  );
}
