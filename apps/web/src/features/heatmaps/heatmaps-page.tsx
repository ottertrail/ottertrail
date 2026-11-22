import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { MousePointerClickIcon, OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { BreakdownTable } from "@/components/breakdown-table";
import { ButtonLink } from "@/components/button-link";
import { ReportChart } from "@/components/report-chart";
import { type Stat, StatStrip } from "@/components/stat-strip";
import { StatusBadge } from "@/components/status-badge";
import { TruncatedText } from "@/components/truncated-text";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  Empty,
  EmptyContent,
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
import { useSettled } from "@/hooks/use-settled";
import { useAccess } from "@/lib/access";
import { DEFAULT_ENVIRONMENT, type PageRange } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import {
  HEATMAP_DEVICES,
  type Heatmap,
  type HeatmapDevice,
  type HeatmapPages,
  heatmapPagesQuery,
  heatmapQuery,
  isHeatmapDevice,
} from "@/lib/heatmaps-api";
import { MISSING } from "@/lib/missing";

import { formatDay, formatDayRange, formatWhole } from "../analytics/format";
import { ReportFilterBar } from "../errors/range-controls";
import { dayIn } from "../overview/format";
import { NoSuchProject } from "../projects/no-such-project";
import { elementName, elementTitle, formatPosition, formatShare } from "./format";
import { OpenOnSite } from "./open-on-site";
import { ScrollReachChart, ScrollReachTable } from "./scroll-reach-chart";
import { type DeviceChoice, type HeatmapsSearch, heatmapsSearchOf } from "./search";
import { SnapshotSection } from "./snapshot-view";

/** The device with the most pageviews of a page's answer for all devices; none without any. */
function topDeviceOf(heatmap: Heatmap): HeatmapDevice | undefined {
  let top: { device: HeatmapDevice; pageviews: number } | undefined;
  for (const item of heatmap.devices) {
    if (isHeatmapDevice(item.device) && item.pageviews > (top?.pageviews ?? 0)) {
      top = { device: item.device, pageviews: item.pageviews };
    }
  }
  return top?.device;
}

/** The device picker's choice for every class of device. */
const ALL_DEVICES = "all";
const DEVICE_ITEMS = [{ value: ALL_DEVICES, label: "All devices" }, ...HEATMAP_DEVICES];

const deviceLabel = (device: string) =>
  HEATMAP_DEVICES.find((item) => item.value === device)?.label ?? device;

function DevicePicker({
  device,
  onDevice,
}: {
  device: DeviceChoice | undefined;
  onDevice: (device: DeviceChoice) => void;
}) {
  return (
    <Select
      items={DEVICE_ITEMS}
      value={device ?? ALL_DEVICES}
      onValueChange={(value) => {
        if (isHeatmapDevice(value) || value === ALL_DEVICES) onDevice(value);
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

/**
 * The page shown, from the pages with heatmap data (most pageviews first):
 * typing filters the list at once and, once typing pauses, asks the API,
 * which finds pages past the first 100.
 */
function PagePicker({
  projectId,
  range,
  environment,
  device,
  path,
  onPath,
}: {
  projectId: string;
  range: PageRange;
  environment: string;
  device: HeatmapDevice | undefined;
  path: string | undefined;
  onPath: (path: string) => void;
}) {
  // Only what the reader typed: the field also shows the chosen page.
  const [typed, setTyped] = React.useState("");
  const search = useSettled(typed.trim(), 250);
  const pages = useQuery(heatmapPagesQuery(projectId, range, environment, device, search));
  const needle = typed.trim().toLowerCase();
  const items = (pages.data?.pages ?? [])
    .map((page) => page.path)
    .filter((item) => item.toLowerCase().includes(needle));
  return (
    <Combobox
      items={items}
      value={path ?? null}
      filter={null}
      onValueChange={(next) => {
        if (typeof next === "string") {
          setTyped("");
          onPath(next);
        }
      }}
      onInputValueChange={(value, details) => {
        if (details.reason === "input-change") setTyped(value);
      }}
      onOpenChange={(open) => {
        if (!open) setTyped("");
      }}
      autoHighlight
    >
      <ComboboxInput
        aria-label="Page"
        className="w-60 max-w-full"
        triggerLabel="Show pages"
        placeholder="Search pages"
        autoComplete="off"
        spellCheck={false}
      />
      <ComboboxContent>
        <ComboboxEmpty>
          {pages.isFetching ? "Searching…" : "No page with heatmap data matches"}
        </ComboboxEmpty>
        <ComboboxList>
          {(item: string) => (
            <ComboboxItem key={item} value={item}>
              {/* The whole path, wrapped: a tooltip would not show on a highlighted option. */}
              <span className="min-w-0 font-mono text-xs break-all">{item}</span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

/** " on mobile in staging": what an empty state was asked about. */
const whereText = (environment: string, device: HeatmapDevice | undefined) =>
  [
    device === undefined ? "" : ` on ${device}`,
    environment === DEFAULT_ENVIRONMENT ? "" : ` in ${environment}`,
  ].join("");

/** The attribute the tracking snippet needs, as code. */
const ATTRIBUTE = <code className="font-mono">data-heatmaps=&quot;on&quot;</code>;

/** The setting is off and nothing is there: who turns it on, and how. */
function HeatmapsOff({ projectId }: { projectId: string }) {
  const canManage = useAccess().can("projects");
  return (
    <Empty className="border border-dashed p-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MousePointerClickIcon />
        </EmptyMedia>
        <EmptyTitle>Heatmaps are off for this project</EmptyTitle>
        <EmptyDescription>
          {canManage ? (
            <>
              Turn them on in the project&apos;s settings, on the Install tab, then add {ATTRIBUTE}{" "}
              to the tracking snippet on your site. Pages then send where visitors click and how far
              they scroll.
            </>
          ) : (
            <>
              An owner or admin turns them on in the project&apos;s settings, and the tracking
              snippet then needs {ATTRIBUTE}. Ask one of them to turn on heatmaps.
            </>
          )}
        </EmptyDescription>
      </EmptyHeader>
      {canManage && (
        <EmptyContent>
          <ButtonLink
            variant="outline"
            to="/projects/$projectId/settings"
            params={{ projectId }}
            search={{ tab: "install" }}
          >
            Turn on heatmaps
          </ButtonLink>
        </EmptyContent>
      )}
    </Empty>
  );
}

/** The setting is on, but no page sent anything in the period. */
function NoData({
  environment,
  device,
  retentionDays,
  clipped,
}: {
  environment: string;
  device: HeatmapDevice | undefined;
  retentionDays: number;
  /** The period began before the days kept. */
  clipped: boolean;
}) {
  return (
    <Empty className="border border-dashed p-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MousePointerClickIcon />
        </EmptyMedia>
        <EmptyTitle>No heatmap data{whereText(environment, device)} in this period</EmptyTitle>
        <EmptyDescription>
          Heatmaps are on. If you have not yet, add {ATTRIBUTE} to the tracking snippet on your
          site. Data arrives as visitors view pages: their clicks at once, and how far they scrolled
          when they leave the page. Heatmap data is kept {retentionDays} days
          {clipped ? ", so nothing from earlier in this period is left." : "."}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/** A chosen page, or a page on a chosen device, without data: other choices that have some. */
function NoPageData({
  heatmap,
  pages,
  search,
  device,
  projectId,
}: {
  heatmap: Heatmap;
  pages: HeatmapPages | undefined;
  search: HeatmapsSearch;
  /** The device shown: chosen, or the page's top device; none for all devices. */
  device: HeatmapDevice | undefined;
  projectId: string;
}) {
  const { environment } = search;
  const devices = heatmap.devices.filter(
    (item) => item.pageviews > 0 && isHeatmapDevice(item.device) && item.device !== device,
  );
  const otherPages = (pages?.pages ?? []).filter((item) => item.path !== heatmap.path).slice(0, 5);
  const link = (next: Partial<HeatmapsSearch>) => ({
    to: "/projects/$projectId/heatmaps" as const,
    params: { projectId },
    search: heatmapsSearchOf({ ...search, ...next }),
  });
  return (
    <Empty className="border border-dashed p-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MousePointerClickIcon />
        </EmptyMedia>
        <EmptyTitle>
          No heatmap data for <span className="font-mono">{heatmap.path}</span>
          {whereText(environment, device)} in this period
        </EmptyTitle>
        <EmptyDescription>
          {devices.length > 0 || otherPages.length > 0 ? (
            "Choose another device or page with data, or a longer period."
          ) : (
            <>
              No visitor sent heatmap data from this page in the period. Data arrives as pages are
              viewed, once the tracking snippet has {ATTRIBUTE}.
            </>
          )}
          {heatmap.clipped && (
            <>
              {" "}
              Heatmaps keep {heatmap.retentionDays} days of data, so nothing from before{" "}
              {formatDay(heatmap.firstDay)} is left.
            </>
          )}
        </EmptyDescription>
      </EmptyHeader>
      {(devices.length > 0 || otherPages.length > 0) && (
        <EmptyContent className="flex flex-col gap-3">
          {devices.length > 0 && (
            <ul aria-label="Devices with data" className="flex flex-wrap justify-center gap-2">
              {device !== undefined && (
                <li>
                  <ButtonLink variant="outline" size="sm" {...link({ device: "all" })}>
                    All devices
                  </ButtonLink>
                </li>
              )}
              {devices.map((item) => (
                <li key={item.device}>
                  <ButtonLink
                    variant="outline"
                    size="sm"
                    {...link({ device: isHeatmapDevice(item.device) ? item.device : undefined })}
                  >
                    {deviceLabel(item.device)} ({formatWhole(item.pageviews)})
                  </ButtonLink>
                </li>
              ))}
            </ul>
          )}
          {otherPages.length > 0 && (
            <ul aria-label="Pages with data" className="flex flex-wrap justify-center gap-2">
              {otherPages.map((item) => (
                <li key={item.path}>
                  <ButtonLink variant="outline" size="sm" {...link({ path: item.path })}>
                    <TruncatedText text={item.path} className="max-w-48 font-mono text-xs" />
                  </ButtonLink>
                </li>
              ))}
            </ul>
          )}
        </EmptyContent>
      )}
    </Empty>
  );
}

/** Shaped like the report: the strip, the chart, and two tables side by side. */
function Loading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-5 w-48" />
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          // oxlint-disable-next-line react/no-array-index-key
          <div key={index} className="flex flex-col gap-2">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-7 w-16" />
          </div>
        ))}
      </div>
      <Skeleton className="h-44 w-full" />
      <div className="@container">
        <div className="grid gap-8 @5xl:grid-cols-2">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    </div>
  );
}

/** The figures, the scroll chart, and the two tables of one page. */
function Report({
  heatmap,
  projectId,
  range,
  environment,
}: {
  heatmap: Heatmap;
  projectId: string;
  range: PageRange;
  environment: string;
}) {
  const canManage = useAccess().can("projects");
  const { totals } = heatmap;
  // Scroll depth arrives when a visitor leaves the page: today's figures still grow.
  // As of when the report appeared: a day that ends while it is open is not worth re-rendering for.
  const [openedAt] = React.useState(() => new Date());
  const [spots, setSpots] = React.useState<"rage" | "dead">("rage");
  const today = dayIn(heatmap.timeZone, openedAt);
  const delayed = heatmap.firstDay <= today && today <= heatmap.lastDay;
  const stats: Stat[] = [
    { label: "Pageviews with heatmap data", value: formatWhole(totals.pageviews) },
    { label: "Clicks", value: formatWhole(totals.clicks) },
    { label: "Rage clicks", value: formatWhole(totals.rageClicks) },
    { label: "Dead clicks", value: formatWhole(totals.deadClicks) },
    {
      label: "Median scroll depth",
      value: totals.medianDepth === null ? MISSING : formatShare(totals.medianDepth),
      detail:
        totals.reachedBottom === null
          ? undefined
          : `${formatShare(totals.reachedBottom)} reached the bottom`,
    },
  ];
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <TruncatedText
          text={heatmap.path}
          className="pt-1 font-mono text-sm text-ink"
          render={<h2>{heatmap.path}</h2>}
        />

        <OpenOnSite
          projectId={projectId}
          path={heatmap.path}
          hostnames={heatmap.siteHostnames}
          device={heatmap.device ?? undefined}
        />
      </div>
      {!heatmap.heatmaps && (
        <Alert>
          <MousePointerClickIcon />
          <AlertTitle>Heatmaps are off for this project</AlertTitle>
          <AlertDescription>
            These figures were collected while they were on. No new data arrives until they are
            turned on again
            {canManage
              ? ", on the Install tab of the project's settings."
              : " by an owner or admin."}
          </AlertDescription>
          {canManage && (
            <AlertAction>
              <ButtonLink
                variant="outline"
                size="sm"
                to="/projects/$projectId/settings"
                params={{ projectId }}
                search={{ tab: "install" }}
              >
                Open the settings
              </ButtonLink>
            </AlertAction>
          )}
        </Alert>
      )}
      {(delayed || heatmap.clipped) && (
        <div className="flex flex-col gap-2 text-xs text-ink-subtle">
          {delayed && (
            <p className="flex flex-wrap items-center gap-2">
              <StatusBadge tone="warning">Today still arriving</StatusBadge>
              <span>
                Scroll depth arrives as visitors leave a page, so today&apos;s figures grow until
                the day ends.
              </span>
            </p>
          )}
          {heatmap.clipped && (
            <p data-slot="clipped-note">
              Heatmaps keep {heatmap.retentionDays} days of data, so this report starts on{" "}
              {formatDay(heatmap.firstDay)}.
            </p>
          )}
        </div>
      )}
      <section aria-label="Heatmap figures" className="flex flex-col gap-3">
        <StatStrip label="Heatmap figures" stats={stats} />
        <p className="max-w-4xl text-xs text-pretty text-ink-subtle">
          For {formatDayRange(heatmap.firstDay, heatmap.lastDay)} ({heatmap.timeZone}). The tracker
          samples pageviews; a pageview counts once it has sent how far it was scrolled.
        </p>
        {totals.droppedClicks > 0 && (
          <p data-slot="dropped-clicks" className="max-w-4xl text-xs text-pretty text-ink-subtle">
            {formatWhole(totals.droppedClicks)} {totals.droppedClicks === 1 ? "click" : "clicks"}{" "}
            not recorded (over 100 on one pageview).
          </p>
        )}
      </section>
      <SnapshotSection
        projectId={projectId}
        path={heatmap.path}
        device={heatmap.device ?? undefined}
        range={range}
        environment={environment}
        timeZone={heatmap.timeZone}
      />
      <ReportChart
        title="How far visitors scrolled"
        description="Each bar is the share of pageviews that reached that depth, from the top of the page (10%) to its bottom. The line across the bars is the average fold: how much of the page showed without scrolling."
        table={<ScrollReachTable reach={heatmap.scroll.reach} />}
      >
        {heatmap.scroll.reach.length === 0 || totals.pageviews === 0 ? (
          <p className="py-8 text-center text-sm text-ink-subtle">
            No pageview sent how far it was scrolled yet: a pageview sends it when the visitor
            leaves the page.
          </p>
        ) : (
          <ScrollReachChart reach={heatmap.scroll.reach} averageFold={heatmap.scroll.averageFold} />
        )}
      </ReportChart>
      {/* Side by side by the content's width, not the window's. */}
      <section aria-label="Clicks" className="@container border-t pt-5">
        <div className="grid gap-x-8 gap-y-8 @5xl:grid-cols-2">
          <BreakdownTable
            title="Most-clicked elements"
            headingLevel={2}
            description={
              <>
                Named by your site&apos;s <code className="font-mono">data-ottertrail-name</code>{" "}
                where set, otherwise by their last steps in the page.
              </>
            }
            caption="Elements of the page, most clicks first"
            nameHeading="Element"
            figureHeadings={["Clicks", "Share", "Rage clicks", "Dead clicks"]}
            rows={heatmap.elements.map((item) => ({
              key: `${item.label ?? ""}\u0000${item.element}`,
              label: (
                <span className={item.label === null ? "font-mono text-xs" : undefined}>
                  {elementName(item.label, item.element)}
                </span>
              ),
              title: elementTitle(item.label, item.element),
              // A name, or the path's last steps, leaves the rest of the path out.
              shortened:
                elementTitle(item.label, item.element) !== elementName(item.label, item.element),
              action:
                item.rageClicks > 0 ? (
                  <StatusBadge tone="warning">Rage clicks</StatusBadge>
                ) : undefined,
              bar: item.clicks,
              figures: [
                formatWhole(item.clicks),
                formatShare(item.share),
                formatWhole(item.rageClicks),
                formatWhole(item.deadClicks),
              ],
            }))}
            empty="No clicks on this page in this period."
            layout="stack"
          />
          <BreakdownTable
            title="Hotspots"
            headingLevel={2}
            views={{
              value: spots,
              onValueChange: (value) => setSpots(value === "dead" ? "dead" : "rage"),
              items: [
                { value: "rage", label: "Rage clicks" },
                { value: "dead", label: "Dead clicks" },
              ],
            }}
            description={
              spots === "rage"
                ? "Elements clicked again and again in quick succession, often because they did not respond."
                : "Elements where nothing on the page responded within a second of a click."
            }
            caption={`Elements with ${spots} clicks, most first`}
            nameHeading="Element"
            figureHeadings={[spots === "rage" ? "Rage clicks" : "Dead clicks", "Spot (x, y)"]}
            rows={(spots === "rage"
              ? heatmap.hotspots.map((item) => ({ ...item, count: item.rageClicks }))
              : heatmap.deadHotspots.map((item) => ({ ...item, count: item.deadClicks }))
            ).map((item) => ({
              key: `${item.label ?? ""}\u0000${item.element}`,
              label: (
                <span className={item.label === null ? "font-mono text-xs" : undefined}>
                  {elementName(item.label, item.element)}
                </span>
              ),
              title: elementTitle(item.label, item.element),
              // A name, or the path's last steps, leaves the rest of the path out.
              shortened:
                elementTitle(item.label, item.element) !== elementName(item.label, item.element),
              bar: item.count,
              figures: [
                formatWhole(item.count),
                <span key="spot" title={formatPosition(item.x, item.y)}>
                  <span aria-hidden="true">
                    {Math.round(item.x * 100)}%, {Math.round(item.y * 100)}%
                  </span>
                  <span className="sr-only">{formatPosition(item.x, item.y)}</span>
                </span>,
              ],
            }))}
            empty={`No ${spots} clicks on this page in this period.`}
            layout="stack"
          />
        </div>
      </section>
    </>
  );
}

/**
 * Where visitors click on a page and how far they scroll, for a period, an
 * environment, a page, and a class of device: figures, the scroll reach,
 * and the most-clicked elements, and "Open on your site", which draws them
 * over the live page.
 */
export function HeatmapsPage({
  projectId,
  range,
  environment = DEFAULT_ENVIRONMENT,
  path,
  device,
}: {
  projectId: string;
  range: PageRange;
  environment?: string;
  path: string | undefined;
  device: DeviceChoice | undefined;
}) {
  const navigate = useNavigate();
  const search: HeatmapsSearch = { range, environment, path, device };
  const show = (next: Partial<HeatmapsSearch>) =>
    void navigate({
      to: "/projects/$projectId/heatmaps",
      params: { projectId },
      search: heatmapsSearchOf({ ...search, ...next }),
    });
  // Only the reader's own choice is in the address: a device, or "all".
  const chosenDevice = device === "all" ? undefined : device;
  const pages = useQuery(heatmapPagesQuery(projectId, range, environment, chosenDevice));
  // Without a page in the address, the first with data (the API lists most pageviews and clicks first).
  const shownPath =
    path ??
    (pages.data?.pages.find((item) => item.pageviews + item.clicks > 0) ?? pages.data?.pages[0])
      ?.path;
  // Without a choice, the page's answer for all devices names the device
  // with the most pageviews for this page and period, as each device's
  // layout differs. Worked out on every render, never written to the
  // address, so another page or period finds its own.
  const allDevices = useQuery({
    ...heatmapQuery(projectId, range, environment, undefined, shownPath ?? ""),
    enabled: shownPath !== undefined && device === undefined,
  });
  const derived =
    device === undefined && allDevices.data !== undefined && !allDevices.isPlaceholderData
      ? topDeviceOf(allDevices.data)
      : undefined;
  // Until the answer for all devices is in, the default device is unknown.
  const deriving = device === undefined && (allDevices.isPending || allDevices.isPlaceholderData);
  const queryDevice = chosenDevice ?? derived;
  const heatmap = useQuery({
    ...heatmapQuery(projectId, range, environment, queryDevice, shownPath ?? ""),
    // Not while the answer for all devices failed: Retry asks it again.
    enabled: shownPath !== undefined && !deriving && !(device === undefined && allDevices.isError),
  });

  const notFound = [pages.error, allDevices.error, heatmap.error].some(
    (error) => error instanceof ApiError && error.status === 404,
  );
  if (notFound) {
    return <NoSuchProject />;
  }
  const failed = pages.isError
    ? pages
    : allDevices.isError
      ? allDevices
      : heatmap.isError
        ? heatmap
        : undefined;
  const data = shownPath === undefined ? undefined : heatmap.data;
  const answered = data ?? pages.data;
  // Nothing to show yet: the list of pages, or the page's heatmap, still loading.
  const waiting =
    pages.data === undefined ||
    (shownPath !== undefined && (deriving || heatmap.data === undefined));

  let body: React.ReactNode;
  if (waiting) {
    body = failed === undefined && <Loading />;
  } else if (data === undefined || (data.totals.pageviews === 0 && data.totals.clicks === 0)) {
    const settings = data ?? pages.data;
    body =
      settings !== undefined && !settings.heatmaps ? (
        <HeatmapsOff projectId={projectId} />
      ) : data === undefined ? (
        <NoData
          environment={environment}
          device={queryDevice}
          retentionDays={pages.data?.retentionDays ?? 90}
          clipped={pages.data?.clipped ?? false}
        />
      ) : (
        <NoPageData
          heatmap={data}
          pages={pages.data}
          search={search}
          device={queryDevice}
          projectId={projectId}
        />
      );
  } else {
    body = <Report heatmap={data} projectId={projectId} range={range} environment={environment} />;
  }

  return (
    <div className="flex flex-col">
      <ReportFilterBar
        label="Period, environment, page, and device"
        range={range}
        environment={environment}
        answered={answered}
        onRange={(next) => show({ range: next })}
        onEnvironment={(next) => show({ environment: next })}
        filters={
          <>
            <PagePicker
              projectId={projectId}
              range={range}
              environment={environment}
              device={chosenDevice}
              path={shownPath}
              onPath={(next) => show({ path: next })}
            />
            <DevicePicker device={device ?? derived} onDevice={(next) => show({ device: next })} />
          </>
        }
      />
      <div className="flex flex-col gap-6 px-gutter py-5">
        {failed !== undefined && (
          <Alert variant="destructive">
            <OctagonAlertIcon />
            <AlertTitle>
              {data === undefined
                ? "The heatmaps could not load"
                : "The heatmaps could not refresh"}
            </AlertTitle>
            <AlertDescription>
              {failed.error?.message}
              {data !== undefined && " The report below is from the last successful load."}
            </AlertDescription>
            <AlertAction>
              <Button variant="outline" size="sm" onClick={() => void failed.refetch()}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        )}
        <div
          className="flex flex-col gap-6 transition-opacity data-[stale=true]:opacity-60"
          data-stale={pages.isPlaceholderData || heatmap.isPlaceholderData}
          aria-busy={pages.isPlaceholderData || heatmap.isPlaceholderData}
        >
          {body}
        </div>
      </div>
    </div>
  );
}
