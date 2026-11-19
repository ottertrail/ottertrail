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
import { RangeControls } from "../errors/range-controls";
import { NoSuchProject } from "../projects/no-such-project";
import { LcpDayCard } from "./lcp-day-card";
import { type SpeedSearch, speedSearchOf } from "./search";
import { DeviceTable, PageTable } from "./speed-tables";
import { CoreVitalCard, SecondaryVitals } from "./vital-cards";

/** The device picker's choice for every kind of device. */
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

/** No page load had a value: how the tracker measures, so the reader knows what to expect. */
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
          page. Navigation within the app has no separate values. A snippet pinned with{" "}
          <code className="font-mono">integrity</code> measures nothing. To disable Web Vitals, add{" "}
          <code className="font-mono">data-vitals=&quot;off&quot;</code> to the snippet.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function Loading() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading">
      <div className="grid gap-4 lg:grid-cols-3">
        {CORE_VITALS.map((name) => (
          <Skeleton key={name} className="h-56 w-full rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-32 w-full rounded-xl" />
      <Skeleton className="h-72 w-full rounded-xl" />
    </div>
  );
}

/**
 * How fast the project's page loads felt: the Core Web Vitals (LCP, INP,
 * CLS) at their 75th percentile, with FCP and TTFB to explain LCP, per
 * day, device, and page, for a period, an environment, and a device.
 */
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
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <RangeControls
        range={range}
        environment={environment}
        answered={data}
        onRange={(next) => show({ range: next })}
        onEnvironment={(next) => show({ environment: next })}
      >
        <DevicePicker device={device} onDevice={(next) => show({ device: next })} />
      </RangeControls>

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
          className="flex flex-col gap-4 transition-opacity data-[stale=true]:opacity-60"
          data-stale={query.isPlaceholderData}
          aria-busy={query.isPlaceholderData}
        >
          {data.loads === 0 ? (
            <NoLoads environment={environment} device={device} />
          ) : (
            <>
              <section aria-label="Core Web Vitals" className="flex flex-col gap-2">
                <div className="grid gap-4 lg:grid-cols-3">
                  {CORE_VITALS.map((name) => (
                    <CoreVitalCard key={name} name={name} speed={data} />
                  ))}
                </div>
                <p className="text-xs text-ink-subtle">
                  Values are the 75th percentile (p75) of{" "}
                  {formatDayRange(data.firstDay, data.lastDay)} ({data.timeZone}): 75% of page loads
                  were at least this fast. Thresholds are Google&apos;s.
                </p>
              </section>
              <SecondaryVitals speed={data} />
              <LcpDayCard days={data.days} />
              <DeviceTable speed={data} />
              <PageTable speed={data} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
