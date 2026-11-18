import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, OctagonAlertIcon, SearchXIcon } from "lucide-react";
import * as React from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { DEFAULT_ENVIRONMENT, type PageRange } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import {
  type HostChart,
  type HostChartId,
  type HostCharts,
  hostChartsQuery,
  type HostLine,
} from "@/lib/hosts-api";

import { RangeControls } from "../errors/range-controls";
import { NoSuchProject } from "../projects/no-such-project";
import { ChartCard } from "./chart-card";
import { stepText } from "./chart-time";
import { formatPreciseMoment } from "./format";
import { formatPercent } from "./host-format";
import { Freshness } from "./hosts-page";
import { formatMetricValue, formatNumber, formatRate } from "./metric-format";
import { environmentSearch, rangeSearch } from "./search";
import { assignSlots, OTHER_COLOR, SLOTS } from "./split-colors";
import type { ChartLine } from "./time-chart";

/** What each chart is called (its unit in the title) and says it shows. */
const CHARTS: Record<
  HostChartId,
  { title: string; description: (step: string, metrics: string) => string; empty: string }
> = {
  cpu: {
    title: "CPU busy (%)",
    description: (step, metrics) =>
      `The share of CPU time not idle, all CPUs together, per ${step}, from ${metrics}.`,
    empty: "system.cpu.utilization or system.cpu.time",
  },
  cpuStates: {
    title: "CPU time by state (%)",
    description: (step, metrics) =>
      `Each state's share of CPU time, all CPUs together, per ${step}, from ${metrics}.`,
    empty: "system.cpu.utilization or system.cpu.time",
  },
  memoryPercent: {
    title: "Memory used (%)",
    description: (step, metrics) => `The share of memory used, per ${step}, from ${metrics}.`,
    empty: "system.memory.utilization or system.memory.usage",
  },
  memoryBytes: {
    title: "Memory used (bytes)",
    description: (step, metrics) => `Memory in the used state, per ${step}, from ${metrics}.`,
    empty: "system.memory.usage",
  },
  filesystem: {
    title: "Filesystem used by mount point (%)",
    description: (step, metrics) =>
      `Each mount point's share used, per ${step}, from ${metrics}; read-only filesystems, always full, are left out. Past eight, the rest are added up as "Other mount points".`,
    empty: "system.filesystem.utilization or system.filesystem.usage",
  },
  network: {
    title: "Network (bytes per second)",
    description: (step, metrics) =>
      `Bytes received and sent per second, every interface the Collector reads added up, per ${step}, from ${metrics}.`,
    empty: "system.network.io",
  },
  disk: {
    title: "Disk I/O (bytes per second)",
    description: (step, metrics) =>
      `Bytes read and written per second, every device the Collector reads added up, per ${step}, from ${metrics}: leave partitions and virtual devices out in its configuration, or they count twice.`,
    empty: "system.disk.io",
  },
  load: {
    title: "Load average",
    description: (step, metrics) =>
      `The average of the load averages' points per ${step}, from ${metrics}: runnable and waiting threads, not a share.`,
    empty: "system.cpu.load_average.1m",
  },
};

/** How a line is named in the legend, the tooltip, and the table. */
const LINE_LABELS: Partial<Record<HostChartId, Record<string, string>>> = {
  network: { receive: "Received", transmit: "Sent" },
  disk: { read: "Read", write: "Written" },
  load: {
    "system.cpu.load_average.1m": "1 minute",
    "system.cpu.load_average.5m": "5 minutes",
    "system.cpu.load_average.15m": "15 minutes",
  },
  memoryPercent: { used: "Used" },
  memoryBytes: { used: "Used" },
};

function lineLabel(chart: HostChart, line: HostLine): string {
  if (line.other) return chart.id === "filesystem" ? "Other mount points" : "Other values";
  if (line.value === null) return chart.id === "cpu" ? "Busy" : "(not set)";
  if (line.value === "") return "(empty)";
  return LINE_LABELS[chart.id]?.[line.value] ?? line.value;
}

/** A line's key: its value, never its label, so no value can pass for another line. */
const keyOf = (line: HostLine) => (line.other ? "\u0000other" : `v${JSON.stringify(line.value)}`);

function formatterOf(unit: string): (value: number) => string {
  if (unit === "%") return (value) => formatPercent(value) ?? "";
  if (unit === "By/s") return (value) => formatRate(value, "By");
  if (unit === "{thread}") return formatNumber;
  return (value) => formatMetricValue(value, unit);
}

/**
 * A chart's lines, each value in the color slot it first got while the
 * page is open (assignSlots), so a mount point or state keeps its color
 * when the period changes; "other" in gray.
 */
function linesOf(chart: HostChart, colors: Map<string, number>): ChartLine[] {
  const slots = assignSlots(
    colors,
    chart.lines.filter((line) => !line.other).map(keyOf),
    SLOTS.length,
  );
  return chart.lines.map((line) => {
    const key = keyOf(line);
    const slot = slots.get(key);
    return {
      key,
      label: lineLabel(chart, line),
      color: line.other || slot === undefined ? OTHER_COLOR : (SLOTS[slot] ?? OTHER_COLOR),
      values: line.values,
    };
  });
}

function HostChartCard({
  data,
  chart,
  colors,
}: {
  data: HostCharts;
  chart: HostChart;
  colors: Map<string, number>;
}) {
  const about = CHARTS[chart.id];
  const step = stepText(data.stepSeconds);
  return (
    <ChartCard
      title={about.title}
      description={
        <>
          {chart.metrics.length === 0
            ? `Worked out from ${about.empty}.`
            : about.description(step, chart.metrics.join(", "))}
          {chart.capped &&
            " The host sent more series than a chart reads: it reads the 1,000 with the most points."}
        </>
      }
      frame={data}
      subject={data.host}
      lines={linesOf(chart, colors)}
      formatValue={formatterOf(chart.unit)}
      domain={chart.unit === "%" ? { min: 0, max: 100 } : undefined}
      missing={
        chart.lines.length === 0 ? `This host sent no ${about.empty} in this period.` : undefined
      }
    />
  );
}

/** One host's charts over the period: CPU, memory, filesystems, network, disks, and load. */
export function HostPage({
  projectId,
  host,
  range,
  environment = DEFAULT_ENVIRONMENT,
}: {
  projectId: string;
  host: string;
  range: PageRange;
  environment?: string;
}) {
  const navigate = useNavigate();
  // Each chart's values keep their colors while the page is open.
  const [colors] = React.useState(() => new Map<HostChartId, Map<string, number>>());
  const colorsOf = (id: HostChartId) => {
    const known = colors.get(id);
    if (known !== undefined) return known;
    const fresh = new Map<string, number>();
    colors.set(id, fresh);
    return fresh;
  };
  const charts = useQuery(hostChartsQuery(projectId, range, environment, host));
  const show = (next: { range?: PageRange; environment?: string }) =>
    void navigate({
      to: "/projects/$projectId/hosts/$host",
      params: { projectId, host },
      search: {
        ...rangeSearch(next.range ?? range),
        ...environmentSearch(next.environment ?? environment),
      },
    });

  if (charts.error instanceof ApiError && charts.error.status === 404) {
    return <NoSuchProject />;
  }
  const data = charts.data;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <div className="flex flex-col gap-2">
        <Link
          to="/projects/$projectId/hosts"
          params={{ projectId }}
          search={{ ...rangeSearch(range), ...environmentSearch(environment) }}
          className="flex items-center gap-1 self-start text-sm text-link hover:underline"
        >
          <ArrowLeftIcon aria-hidden="true" className="size-4" />
          All hosts
        </Link>
        <h2 className="font-mono text-lg font-medium break-all text-ink">{host}</h2>
        {data !== undefined && data.lastSeen !== null && (
          <p className="flex flex-wrap items-center gap-2 text-sm text-ink-subtle">
            <span>
              Last seen{" "}
              <time dateTime={data.lastSeen}>
                {formatPreciseMoment(data.lastSeen, data.timeZone)}
              </time>
            </span>
            <Freshness stale={data.stale} />
            {data.stale === true && <span>Nothing arrived from it in the last 5 minutes.</span>}
          </p>
        )}
      </div>

      <RangeControls
        range={range}
        environment={environment}
        answered={data}
        onRange={(next) => show({ range: next })}
        onEnvironment={(next) => show({ environment: next })}
      />

      {charts.isError && (
        <Alert variant="destructive">
          <OctagonAlertIcon />
          <AlertTitle>
            {data === undefined ? "The host could not load" : "The host could not refresh"}
          </AlertTitle>
          <AlertDescription>
            {charts.error.message}
            {data !== undefined && " The charts below are from the last successful load."}
          </AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={() => void charts.refetch()}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      )}
      {data === undefined ? (
        !charts.isError && (
          <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
            <Skeleton className="h-72 w-full" />
            <Skeleton className="h-72 w-full" />
          </div>
        )
      ) : data.lastSeen === null ? (
        <Empty className="border border-dashed p-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchXIcon />
            </EmptyMedia>
            <EmptyTitle>No host metrics from this host in this period</EmptyTitle>
            <EmptyDescription>
              Nothing arrived from it
              {environment === DEFAULT_ENVIRONMENT ? "" : ` in ${environment}`} in this period.
              Metrics are kept {data.retentionDays} days.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div
          className="grid gap-4 transition-opacity data-[stale=true]:opacity-60 lg:grid-cols-2"
          data-stale={charts.isPlaceholderData}
          aria-busy={charts.isPlaceholderData}
        >
          {data.charts.map((chart) => (
            <HostChartCard key={chart.id} data={data} chart={chart} colors={colorsOf(chart.id)} />
          ))}
        </div>
      )}
    </div>
  );
}
