import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { GaugeIcon, OctagonAlertIcon } from "lucide-react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { DEFAULT_ENVIRONMENT, type PageRange } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import { CORE_VITALS, DEVICES, type Device, isDevice, speedQuery } from "@/lib/speed-api";

import { formatDayRange } from "../analytics/format";
import { ReportFilterBar } from "../errors/range-controls";
import { NoSuchProject } from "../projects/no-such-project";
import { LcpDayCard } from "./lcp-day-card";
import { type SpeedSearch, speedSearchOf } from "./search";
import { DeviceTable, PageTable, SpeedTablesNote } from "./speed-tables";
import { CoreVitals, SecondaryVitals } from "./vital-cards";

const ALL_DEVICES = "all";
const DEVICE_ITEMS = [{ value: ALL_DEVICES, label: "All devices" }, ...DEVICES];

function DevicePicker({
  device,
  onDevice,
}: {
  device: Device | undefined;
  onDevice: (device: Device | undefined) => void;
}) {
  return (
    <Select
      items={DEVICE_ITEMS}
      value={device ?? ALL_DEVICES}
      onValueChange={(value) => {
        if (isDevice(value)) {
          onDevice(value);
        } else if (value === ALL_DEVICES) {
          onDevice(undefined);
        }
      }}
    >
      <SelectTrigger aria-label="Device" className="w-36">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {DEVICE_ITEMS.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function NoLoads({ environment, device }: { environment: string; device: Device | undefined }) {
  const where = [
    device === undefined ? "" : ` on ${device}`,
    environment === DEFAULT_ENVIRONMENT ? "" : ` in ${environment}`,
  ].join("");
  return (
    <Empty className="border border-dashed p-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <GaugeIcon />
        </EmptyMedia>
        <EmptyTitle>No page loads measured{where} in this period</EmptyTitle>
        <EmptyDescription>
          The tracking snippet measures Web Vitals automatically. On each page load, it adds a
          second script, <code className="font-mono">v.js</code>, and sends values once, when the
          visitor first hides or leaves the page. In a single-page app, values belong to the landing
          page: browsers measure Web Vitals per page load, so navigation within the app has no
          values of its own. A snippet pinned with <code className="font-mono">integrity</code>{" "}
          measures nothing, because the second script can&apos;t be pinned with it: remove the
          attribute to measure. To disable Web Vitals, add{" "}
          <code className="font-mono">data-vitals=&quot;off&quot;</code> to the snippet.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function Loading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {CORE_VITALS.map((name) => (
          <div key={name} className="flex flex-col gap-2">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-7 w-20" />
            <Skeleton className="h-16 w-full max-w-72" />
          </div>
        ))}
      </div>
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-44 w-full" />
      <div className="@container">
        <div className="grid gap-8 @3xl:grid-cols-2">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    </div>
  );
}

export function SpeedPage({
  projectId,
  range,
  environment = DEFAULT_ENVIRONMENT,
  device,
}: {
  projectId: string;
  range: PageRange;
  environment?: string;
  device: Device | undefined;
}) {
  const navigate = useNavigate();
  const query = useQuery(speedQuery(projectId, range, environment, device));
  const search: SpeedSearch = { range, environment, device };
  const show = (next: Partial<SpeedSearch>) =>
    void navigate({
      to: "/projects/$projectId/speed",
      params: { projectId },
      search: speedSearchOf({ ...search, ...next }),
    });

  if (query.error instanceof ApiError && query.error.status === 404) {
    return <NoSuchProject />;
  }
  const data = query.data;

  return (
    <div className="flex flex-col">
      <ReportFilterBar
        label="Period, environment, and device"
        range={range}
        environment={environment}
        answered={data}
        onRange={(next) => show({ range: next })}
        onEnvironment={(next) => show({ environment: next })}
        filters={<DevicePicker device={device} onDevice={(next) => show({ device: next })} />}
      />
      <div className="flex flex-col gap-6 px-gutter py-5">
        {query.isError && (
          <Alert variant="destructive">
            <OctagonAlertIcon />
            <AlertTitle>
              {data === undefined
                ? "The speed report could not load"
                : "The speed report could not refresh"}
            </AlertTitle>
            <AlertDescription>
              {query.error.message}
              {data !== undefined && " The report below is from the last successful load."}
            </AlertDescription>
            <AlertAction>
              <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        )}
        {data === undefined ? (
          !query.isError && <Loading />
        ) : (
          <div
            className="flex flex-col gap-6 transition-opacity data-[stale=true]:opacity-60"
            data-stale={query.isPlaceholderData}
            aria-busy={query.isPlaceholderData}
          >
            {data.loads === 0 ? (
              <NoLoads environment={environment} device={device} />
            ) : (
              <>
                <section aria-label="Core Web Vitals" className="flex flex-col gap-3">
                  <CoreVitals speed={data} />
                  <p className="max-w-4xl text-xs text-pretty text-ink-subtle">
                    Values are the 75th percentile (p75) of{" "}
                    {formatDayRange(data.firstDay, data.lastDay)} ({data.timeZone}): 75% of page
                    loads were at least this fast. Thresholds are Google&apos;s.
                  </p>
                </section>
                <SecondaryVitals speed={data} />
                <LcpDayCard days={data.days} />
                {/* Use content width for the columns. */}
                <section
                  aria-label="By device and page"
                  className="@container flex flex-col gap-3 border-t pt-5"
                >
                  <div className="grid gap-x-8 gap-y-8 @5xl:grid-cols-2">
                    <DeviceTable speed={data} />
                    <PageTable speed={data} />
                  </div>
                  <SpeedTablesNote speed={data} />
                </section>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
