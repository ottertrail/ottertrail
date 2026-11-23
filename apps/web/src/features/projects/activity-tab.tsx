import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ActivityIcon, OctagonAlertIcon, TriangleAlertIcon } from "lucide-react";
import * as React from "react";

import { ButtonLink } from "@/components/button-link";
import { clickableRow, ROW_LINK } from "@/components/clickable-row";
import { Missing } from "@/components/missing";
import { PINNED } from "@/components/pinned-column";
import { ScrollHint } from "@/components/scroll-hint";
import { SettingsSection } from "@/components/settings-section";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useSearchParam } from "@/hooks/use-search-param";
import { useAccess } from "@/lib/access";
import {
  type ActivityWindows,
  type IngestOutcome,
  type IngestSource,
  ingestActivityQuery,
  INGEST_OUTCOMES,
  type SourceActivity,
} from "@/lib/ingest-activity-api";

import { formatWhole } from "../analytics/format";
import { formatMoment, formatTime } from "../users/format";
import { timeAgo } from "./format";

/** The tab's value in the address: its counts are fetched only while it is the tab shown. */
export const ACTIVITY_TAB = "activity";
/** How often the counts are fetched again while the tab is shown: the API adds them every 15 seconds. */
const REFRESH_MS = 30_000;

/** Each source's name, and what its items are. */
const SOURCES: Record<IngestSource, { label: string; items: string }> = {
  browser_events: { label: "Browser events", items: "Events stored" },
  server_events: { label: "Server events", items: "Events stored" },
  errors: { label: "Errors", items: "Errors stored" },
  web_vitals: { label: "Web Vitals", items: "Page loads stored" },
  replays: { label: "Session replays", items: "Chunks stored" },
  heatmaps: { label: "Heatmaps", items: "Records stored" },
  traces: { label: "Traces", items: "Spans stored" },
  logs: { label: "Logs", items: "Log records stored" },
  metrics: { label: "Metrics", items: "Data points stored" },
  ai_calls: { label: "AI calls", items: "Calls stored" },
  source_maps: { label: "Source maps", items: "Maps stored" },
};

const OUTCOME_LABELS: Record<IngestOutcome, string> = {
  accepted: "Accepted",
  filtered_bot: "Filtered: bots",
  filtered_spam: "Filtered: spam",
  filtered_too_old: "Filtered: too old",
  refused_origin: "Refused: site not allowed",
  refused_disabled: "Refused: turned off",
  refused_invalid: "Refused: invalid",
  refused_rate_limited: "Refused: rate limited",
  refused_volume: "Refused: limit reached",
  refused_unavailable: "Refused: storage unavailable",
};

const isRefused = (outcome: IngestOutcome) => outcome.startsWith("refused_");
const isFiltered = (outcome: IngestOutcome) => outcome.startsWith("filtered_");

/** Requests in the window, of the outcomes `pick` chooses. */
function sum(
  activity: SourceActivity,
  window: "hour" | "day" | "week",
  pick: (outcome: IngestOutcome) => boolean,
): number {
  let total = 0;
  for (const outcome of INGEST_OUTCOMES) {
    const counts = activity.outcomes[outcome];
    if (counts !== undefined && pick(outcome)) total += counts[window].count;
  }
  return total;
}

const anyIn7Days = (activity: SourceActivity) => sum(activity, "week", () => true) > 0;

/** What the links in a reason's line need. */
interface Links {
  projectId: string;
  /** Whether the user is the owner, who alone may open the Server log. */
  owner: boolean;
  /** Closes the sheet as a link in it opens another tab. */
  onNavigate: () => void;
}

/** A link to another tab of the project's settings: Install, the first, has no `?tab=`. */
function TabLink({
  links,
  tab,
  children,
}: {
  links: Links;
  tab: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      to="/projects/$projectId/settings"
      params={{ projectId: links.projectId }}
      search={tab === "install" ? {} : { tab }}
      className="text-link hover:underline"
      onClick={links.onNavigate}
    >
      {children}
    </Link>
  );
}

/** "the Server log", a link for the owner; the owner's, in words, for an admin. */
function ServerLogLink({ links }: { links: Links }) {
  if (!links.owner) return <>the owner&apos;s Server log</>;
  return (
    <>
      the{" "}
      <Link
        to="/settings"
        search={{ tab: "server-log" }}
        className="text-link hover:underline"
        onClick={links.onNavigate}
      >
        Server log
      </Link>
    </>
  );
}

/** What could not store a source's data when it answered 503. */
const UNAVAILABLE: Record<IngestSource, string> = {
  // Visitor IDs and the instance's timezone come from PostgreSQL before the insert.
  browser_events: "ClickHouse or PostgreSQL couldn't store the data.",
  errors: "ClickHouse or PostgreSQL couldn't store the data.",
  web_vitals: "ClickHouse or PostgreSQL couldn't store the data.",
  server_events: "ClickHouse couldn't store the data.",
  heatmaps: "ClickHouse couldn't store the data.",
  traces: "ClickHouse couldn't store the data.",
  logs: "ClickHouse couldn't store the data.",
  metrics: "ClickHouse couldn't store the data.",
  ai_calls: "ClickHouse couldn't store the data.",
  replays: "PostgreSQL couldn't store the chunk.",
  source_maps: "The object store or PostgreSQL couldn't store the map.",
};

/** What one reason means for one source, and what to do: one plain line. */
function reasonText(source: IngestSource, outcome: IngestOutcome, links: Links): React.ReactNode {
  switch (outcome) {
    case "accepted":
      return null;
    case "filtered_bot":
      return (
        <>
          Sent by a bot, or by a browser at a data center's address, and dropped. If real visitors
          use cloud desktops, turn off &quot;Ignore visits from data centers&quot; on the{" "}
          <TabLink links={links} tab="spam">
            Spam and bots
          </TabLink>{" "}
          tab.
        </>
      );
    case "filtered_spam":
      if (source === "replays") {
        return (
          <>
            Dropped: sent from one of the project's blocked addresses. The list is on the{" "}
            <TabLink links={links} tab="spam">
              Spam and bots
            </TabLink>{" "}
            tab.
          </>
        );
      }
      return (
        <>
          Dropped as spam: a blocked address or referrer, or a referrer on the spam list
          {source === "browser_events" || source === "errors" || source === "web_vitals"
            ? ", or a visitor past its 5,000 events a day"
            : ""}
          . The lists are on the{" "}
          <TabLink links={links} tab="spam">
            Spam and bots
          </TabLink>{" "}
          tab.
        </>
      );
    case "filtered_too_old":
      return (
        <>Dropped: it happened more than 24 hours before it was sent. Check the sender's clock.</>
      );
    case "refused_origin":
      return (
        <>
          The page's site isn't in Allowed sites. Add it on the{" "}
          <TabLink links={links} tab="general">
            General
          </TabLink>{" "}
          tab.
        </>
      );
    case "refused_disabled":
      return source === "heatmaps" ? (
        <>
          Heatmaps are off for this project. Turn them on on the{" "}
          <TabLink links={links} tab="install">
            Install
          </TabLink>{" "}
          tab.
        </>
      ) : (
        <>
          Session replay is off for this project, or the instance has no object store. Turn it on on
          the{" "}
          <TabLink links={links} tab="replay">
            Session replay
          </TabLink>{" "}
          tab.
        </>
      );
    case "refused_invalid":
      return source === "traces" || source === "logs" || source === "metrics" ? (
        <>
          The request, or some of its records, couldn't be read or stored. Check the exporter's
          settings; <ServerLogLink links={links} /> shows each refused request.
        </>
      ) : (
        <>
          The request was malformed or too large. Update the tracker or SDK, or check what your code
          sends; <ServerLogLink links={links} /> shows each refused request.
        </>
      );
    case "refused_rate_limited":
      return (
        <>
          Too many at once for this project. Senders retry; if it lasts, the project sends more than
          its limit.
        </>
      );
    case "refused_volume":
      if (source === "replays") {
        return <>The instance's replay storage is full, or a replay passed its 2 MB limit.</>;
      }
      if (source === "source_maps") {
        return (
          <>
            The instance's source map storage is full. Delete older releases on the{" "}
            <TabLink links={links} tab="source-maps">
              Source maps
            </TabLink>{" "}
            tab.
          </>
        );
      }
      return <>The instance's limit for all projects together was reached. Senders retry.</>;
    case "refused_unavailable":
      return (
        <>
          {UNAVAILABLE[source]} Senders retry; check <ServerLogLink links={links} />.
        </>
      );
    default:
      return null;
  }
}

/** The counts of one source: each outcome by window, the items stored, and each reason's line. */
function SourceSheet({
  activity,
  open,
  onOpenChange,
  links,
  since,
  timeZone,
}: {
  activity: SourceActivity | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  links: Links;
  since: ActivityWindows;
  timeZone: string | undefined;
}) {
  const id = React.useId();
  if (activity === null) return null;
  const { label, items } = SOURCES[activity.source];
  const shown = INGEST_OUTCOMES.flatMap((outcome) => {
    const counts = activity.outcomes[outcome];
    return counts === undefined || counts.week.count === 0 ? [] : [{ outcome, counts }];
  });
  const accepted = activity.outcomes.accepted;
  const reasons = shown.filter(({ outcome }) => outcome !== "accepted");
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-lg"
      >
        <SheetHeader className="border-b pr-12">
          <SheetTitle>{label}</SheetTitle>
          <SheetDescription className="text-pretty text-ink-subtle">
            Requests, in whole hours: this hour since {formatTime(since.hour, timeZone)}, and the 24
            hours and 7 days that end with it.
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
          <Table>
            <caption className="sr-only">{label}: requests by outcome</caption>
            <TableHeader>
              <TableRow>
                <TableHead>Outcome</TableHead>
                <TableHead className="text-right">This hour</TableHead>
                <TableHead className="text-right">24 h</TableHead>
                <TableHead className="text-right">7 days</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map(({ outcome, counts }) => (
                <TableRow key={outcome}>
                  <TableCell className="whitespace-normal">{OUTCOME_LABELS[outcome]}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatWhole(counts.hour.count)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatWhole(counts.day.count)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatWhole(counts.week.count)}
                  </TableCell>
                </TableRow>
              ))}
              {accepted !== undefined && accepted.week.items > 0 && (
                <TableRow>
                  <TableCell className="whitespace-normal text-ink-subtle">{items}</TableCell>
                  <TableCell className="text-right text-ink-subtle tabular-nums">
                    {formatWhole(accepted.hour.items)}
                  </TableCell>
                  <TableCell className="text-right text-ink-subtle tabular-nums">
                    {formatWhole(accepted.day.items)}
                  </TableCell>
                  <TableCell className="text-right text-ink-subtle tabular-nums">
                    {formatWhole(accepted.week.items)}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {reasons.length > 0 && (
            <section aria-labelledby={`${id}-reasons`} className="flex flex-col gap-3">
              <h3 id={`${id}-reasons`} className="text-sm font-medium text-ink">
                Why
              </h3>
              <ul className="flex flex-col gap-3 text-sm">
                {reasons.map(({ outcome }) => (
                  <li key={outcome} className="flex flex-col gap-0.5">
                    <span className="font-medium text-ink">{OUTCOME_LABELS[outcome]}</span>
                    <span className="text-pretty text-ink-muted">
                      {reasonText(activity.source, outcome, links)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ActivitySkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading the activity">
      {Array.from({ length: 5 }, (_, index) => (
        // oxlint-disable-next-line react/no-array-index-key
        <Skeleton key={index} className="h-10 w-full" />
      ))}
    </div>
  );
}

function SourceTable({
  sources,
  timeZone,
  onOpen,
}: {
  sources: SourceActivity[];
  timeZone: string | undefined;
  onOpen: (source: IngestSource) => void;
}) {
  return (
    <ScrollHint>
      <Table>
        <caption className="sr-only">Requests per source</caption>
        <TableHeader>
          <TableRow>
            <TableHead className={PINNED}>Source</TableHead>
            <TableHead>Last accepted</TableHead>
            <TableHead className="text-right">Accepted (this hour)</TableHead>
            <TableHead className="text-right">Accepted (24 h)</TableHead>
            <TableHead className="text-right">Refused (24 h)</TableHead>
            <TableHead className="text-right">Filtered (24 h)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sources.map((activity) => {
            const refused = sum(activity, "day", isRefused);
            const { label } = SOURCES[activity.source];
            return (
              <TableRow key={activity.source} {...clickableRow()}>
                <TableCell className={PINNED}>
                  <button
                    type="button"
                    {...ROW_LINK}
                    className="text-left whitespace-nowrap text-link hover:underline"
                    aria-label={`${label}, details`}
                    onClick={() => onOpen(activity.source)}
                  >
                    {label}
                  </button>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {activity.lastAcceptedAt === null ? (
                    <Missing label="None in 7 days" />
                  ) : (
                    <span title={formatMoment(activity.lastAcceptedAt, timeZone)}>
                      {timeAgo(new Date(activity.lastAcceptedAt))}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatWhole(sum(activity, "hour", (outcome) => outcome === "accepted"))}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatWhole(sum(activity, "day", (outcome) => outcome === "accepted"))}
                </TableCell>
                <TableCell className={cn("text-right tabular-nums", refused > 0 && "text-warning")}>
                  {formatWhole(refused)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatWhole(sum(activity, "day", isFiltered))}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </ScrollHint>
  );
}

/**
 * The Activity tab of a project's settings (docs/dashboard.md, "Activity"):
 * per source, when data was last accepted, and how many requests were
 * accepted, refused, and filtered, fetched every 30 seconds while the tab
 * is shown. Sources with nothing in 7 days are folded into one line under
 * the table; a row opens a sheet with each outcome's counts and what each
 * reason means.
 */
export function ActivityTab({ projectId }: { projectId: string }) {
  const [tab] = useSearchParam("tab");
  const shown = tab === ACTIVITY_TAB;
  const activity = useQuery({
    ...ingestActivityQuery(projectId),
    enabled: shown,
    refetchInterval: shown ? REFRESH_MS : false,
  });
  const { me, can } = useAccess();
  const owner = can("settings");
  const timeZone = me?.instance.timeZone;
  const [chosen, setChosen] = React.useState<IngestSource | null>(null);
  const [open, setOpen] = React.useState(false);

  const links: Links = { projectId, owner, onNavigate: () => setOpen(false) };

  const sources = activity.data?.sources ?? [];
  const active = sources.filter(anyIn7Days);
  const quiet = sources.filter((source) => !anyIn7Days(source));
  const sheetFor = sources.find((source) => source.source === chosen) ?? null;

  return (
    <SettingsSection
      title="Activity"
      description={
        <>
          Requests to this project, updated every 15 seconds. A request with a wrong key can&apos;t
          be matched to a project, so it isn&apos;t counted; <ServerLogLink links={links} /> shows
          it.
        </>
      }
      wide
    >
      {activity.isPending && <ActivitySkeleton />}
      {activity.isError && activity.data === undefined && (
        <Alert variant="destructive">
          <OctagonAlertIcon />
          <AlertTitle>The activity could not load</AlertTitle>
          <AlertDescription>{activity.error.message}</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={() => void activity.refetch()}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      )}
      {activity.isRefetchError && (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>The counts could not refresh</AlertTitle>
          <AlertDescription>Showing the last counts. {activity.error.message}</AlertDescription>
        </Alert>
      )}
      {activity.data !== undefined && active.length === 0 && (
        <Empty className="border border-dashed p-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ActivityIcon />
            </EmptyMedia>
            <EmptyTitle>Nothing received in 7 days</EmptyTitle>
            <EmptyDescription>
              Add the snippet from the Install tab to your site. A request with a wrong key can't be
              counted here.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <ButtonLink
              variant="outline"
              size="sm"
              to="/projects/$projectId/settings"
              params={{ projectId }}
              search={{}}
            >
              Open the Install tab
            </ButtonLink>
          </EmptyContent>
        </Empty>
      )}
      {activity.data !== undefined && active.length > 0 && (
        <div className={cn("flex flex-col gap-3", activity.isRefetchError && "opacity-60")}>
          <SourceTable
            sources={active}
            timeZone={timeZone}
            onOpen={(source) => {
              setChosen(source);
              setOpen(true);
            }}
          />
          {quiet.length > 0 && (
            <p className="text-sm text-ink-subtle">
              Nothing received in 7 days:{" "}
              {quiet.map((source) => SOURCES[source.source].label).join(", ")}.
            </p>
          )}
        </div>
      )}
      {activity.data !== undefined && (
        <SourceSheet
          activity={sheetFor}
          open={open}
          onOpenChange={setOpen}
          links={links}
          since={activity.data.since}
          timeZone={timeZone}
        />
      )}
    </SettingsSection>
  );
}
