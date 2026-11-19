import { cn } from "cn";
import { InboxIcon, OctagonAlertIcon, RefreshCwIcon } from "lucide-react";
import * as React from "react";

import { BreakdownTable, type BreakdownRow } from "@/components/breakdown-table";
import { FilterBar, FilterBarRange } from "@/components/filter-bar";
import { Missing } from "@/components/missing";
import { PINNED, PINNED_END } from "@/components/pinned-column";
import { ReportChart } from "@/components/report-chart";
import { ScrollHint } from "@/components/scroll-hint";
import { SettingsSection } from "@/components/settings-section";
import { SettingsTabs } from "@/components/settings-tabs";
import { type Stat, StatStrip } from "@/components/stat-strip";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Workbench, WorkbenchKeyHints } from "@/components/workbench";
import { DayChart } from "@/features/analytics/day-chart";
import { formatDay, formatWhole, pointsChange, relativeChange } from "@/features/analytics/format";
import { useDirtyForm } from "@/hooks/use-dirty-form";

import { Section, Specimen } from "./section";

// Sample figures, made up for the examples (some match the browser tests' fixtures).
const PERIODS = [
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
];

const STATS: Stat[] = [
  {
    label: "Visitors",
    value: "765",
    change: relativeChange(765, 683),
    before: "683",
    counts: { current: 765, previous: 683 },
  },
  {
    label: "Visits",
    value: "824",
    change: relativeChange(824, 824),
    before: "824",
    counts: { current: 824, previous: 824 },
  },
  {
    label: "Pageviews",
    value: "1,820",
    change: relativeChange(1820, 2000),
    before: "2,000",
    counts: { current: 1820, previous: 2000 },
  },
  {
    label: "Bounce rate",
    value: "24%",
    change: pointsChange(0.24, 0.3),
    before: "30%",
    counts: { current: 824, previous: 824 },
  },
  { label: "Visit duration", value: "4m 23s" },
];

const FEW_STATS: Stat[] = [
  {
    label: "Visitors",
    value: "6",
    change: relativeChange(6, 2),
    before: "2",
    counts: { current: 6, previous: 2 },
  },
  {
    label: "Visits",
    value: "7",
    change: relativeChange(7, 2),
    before: "2",
    counts: { current: 7, previous: 2 },
  },
  // No counts: with a minimum set, its change is left out too.
  { label: "Pageviews", value: "9", change: relativeChange(9, 3), before: "3" },
];

const PAGES: BreakdownRow[] = [
  { key: "/", label: "/", bar: 322, figures: [formatWhole(322), formatWhole(420)] },
  { key: "/pricing", label: "/pricing", bar: 201, figures: [formatWhole(201), formatWhole(260)] },
  { key: "/docs", label: "/docs/getting-started", bar: 88, figures: ["88", "97"] },
];

const ENTRY_PAGES: BreakdownRow[] = [
  { key: "/", label: "/", bar: 300, figures: ["300", "320"] },
  { key: "/pricing", label: "/pricing", bar: 145, figures: ["145", "150"] },
];

const COUNTRIES: BreakdownRow[] = [
  { key: "DE", label: "Germany", bar: 155, figures: ["155", "160"] },
  { key: "unknown", label: "Unknown", bar: 125, figures: ["125", "130"] },
  { key: "SG", label: "Singapore", bar: 90, figures: ["90", "95"] },
];

interface ExampleItem {
  id: string;
  name: string;
  message: string;
  occurrences: number;
}

const ITEMS: ExampleItem[] = [
  {
    id: "type-error",
    name: "TypeError",
    message: "Cannot read properties of undefined (reading 'id')",
    occurrences: 1234,
  },
  { id: "reference-error", name: "ReferenceError", message: "process is not defined", occurrences: 8 },
  { id: "network-error", name: "NetworkError", message: "Failed to fetch", occurrences: 3 },
];

function FilterBarSpecimens() {
  const [period, setPeriod] = React.useState("7d");
  return (
    <Specimen
      title="Filter bar: pinned under the header from 40rem, wrapping on narrow screens"
      sample
      className="block p-0"
    >
      <FilterBar
        className="sm:static"
        period={
          <Select
            items={PERIODS}
            value={period}
            onValueChange={(value) => {
              if (typeof value === "string") setPeriod(value);
            }}
          >
            <SelectTrigger aria-label="Period" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERIODS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
        environment={
          <p className="text-sm text-ink-subtle">
            Environment <span className="text-ink">production</span>
          </p>
        }
        filters={
          <ToggleGroup
            defaultValue={["unresolved"]}
            aria-label="Status"
            variant="outline"
            spacing={0}
          >
            <ToggleGroupItem value="unresolved">Unresolved</ToggleGroupItem>
            <ToggleGroupItem value="resolved">Resolved</ToggleGroupItem>
            <ToggleGroupItem value="all">All</ToggleGroupItem>
          </ToggleGroup>
        }
        range={
          <FilterBarRange firstDay="2026-11-10" lastDay="2026-11-16" timeZone="Asia/Singapore" />
        }
      />
    </Specimen>
  );
}

function StatStripSpecimens() {
  return (
    <div className="space-y-4">
      <Specimen
        title="Stat strip: figures in tabular numerals, the change from the period before"
        sample
        className="block"
      >
        <StatStrip stats={STATS} label="Summary" />
      </Specimen>
      <div className="grid gap-4 lg:grid-cols-2">
        <Specimen
          title="Too few to compare: minCount 20 hides a change when neither period reaches 20 visits"
          sample
          className="block"
        >
          <StatStrip stats={FEW_STATS} minCount={20} label="Summary with few visits" />
        </Specimen>
        <Specimen title="Loading: the strip's shape, without figures" className="block">
          <div aria-busy="true" aria-label="Loading the summary" className="grid grid-cols-4 gap-4">
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className="space-y-2">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-7 w-20" />
              </div>
            ))}
          </div>
        </Specimen>
      </div>
    </div>
  );
}

function BreakdownSpecimens() {
  const [pages, setPages] = React.useState("top");
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Specimen
        title="Breakdown table: a toggle group in its header, bars in proportion, show all"
        sample
        className="block"
      >
        <BreakdownTable
          title="Pages"
          caption="Pages, the most visitors first"
          nameHeading="Path"
          figureHeadings={["Visitors", "Views"]}
          rows={pages === "top" ? PAGES : ENTRY_PAGES}
          views={{
            value: pages,
            onValueChange: setPages,
            items: [
              { value: "top", label: "Top pages" },
              { value: "entry", label: "Entry" },
            ],
          }}
          showAll={
            <Button variant="ghost" size="sm" aria-label="Show all pages">
              Show all
            </Button>
          }
          empty="No visits in this period."
        />
      </Specimen>
      <Specimen title="Stacked rows on phones (layout stack)" sample className="block">
        <BreakdownTable
          title="Locations"
          caption="Countries, the most visitors first"
          nameHeading="Country"
          figureHeadings={["Visitors", "Visits"]}
          rows={COUNTRIES}
          layout="stack"
          empty="No visits in this period."
        />
      </Specimen>
      <Specimen title="Empty: why, in the table's place" className="block">
        <BreakdownTable
          title="Custom events"
          caption="Custom events, the most visitors first"
          nameHeading="Event"
          figureHeadings={["Visitors", "Events"]}
          rows={[]}
          empty="No custom events in this period. Send one with ottertrail.track()."
        />
      </Specimen>
      <Specimen title="Loading: rows of the table's shape" className="block">
        <div aria-busy="true" aria-label="Loading the table" className="space-y-3">
          <Skeleton className="h-4 w-24" />
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-5 w-full" />
          ))}
        </div>
      </Specimen>
    </div>
  );
}

function ExampleList({
  items,
  selected,
  select,
}: {
  items: ExampleItem[];
  selected: string | undefined;
  select: (id: string) => void;
}) {
  return (
    <Table>
      <caption className="sr-only">Example errors, the most occurrences first</caption>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead scope="col" className="pl-4 text-xs font-normal text-ink-subtle">
            Error
          </TableHead>
          <TableHead scope="col" className="pr-4 text-right text-xs font-normal text-ink-subtle">
            Occurrences
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => (
          <TableRow
            key={item.id}
            data-workbench-id={item.id}
            data-state={item.id === selected ? "selected" : undefined}
            className="data-[state=selected]:shadow-[inset_2px_0_0_var(--brand)]"
          >
            <TableCell className="max-w-0 pl-4 whitespace-normal">
              <button
                type="button"
                aria-current={item.id === selected ? "true" : undefined}
                title={`${item.name}: ${item.message}`}
                onClick={() => select(item.id)}
                className="block w-full truncate rounded-sm text-left text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                {item.name}: <span className="text-ink">{item.message}</span>
              </button>
            </TableCell>
            <TableCell className="pr-4 text-right tabular-nums">
              {formatWhole(item.occurrences)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function WorkbenchSpecimens() {
  const [resolved, setResolved] = React.useState<ReadonlySet<string>>(() => new Set());
  const [opened, setOpened] = React.useState<string | undefined>();
  const toggle = React.useCallback(
    (id: string) =>
      setResolved((previous) => {
        const next = new Set(previous);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  const action = React.useMemo(
    () => ({ key: "e", label: "resolve or reopen", onAction: toggle }),
    [toggle],
  );
  const openPage = React.useCallback((id: string) => setOpened(id), []);
  return (
    <div className="space-y-4">
      <Specimen
        title="Workbench: the list, the selection in the address (?ds-item=), the detail beside it"
        sample
        className="block p-0"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
          <p className="text-sm text-ink-subtle">Choose a row, or press j</p>
          <WorkbenchKeyHints action={action} />
        </div>
        <Workbench
          label="Example errors"
          className="h-80"
          ids={ITEMS.map((item) => item.id)}
          param="ds-item"
          action={action}
          onOpenPage={openPage}
          renderList={({ selected, select }) => (
            <ExampleList items={ITEMS} selected={selected} select={select} />
          )}
          summary={
            <div className="space-y-2 p-4">
              <h3 className="text-sm font-medium text-ink">3 unresolved errors</h3>
              <p className="text-sm text-ink-subtle">
                1,245 occurrences in this period. Nothing is selected: this pane sums up the list.
              </p>
            </div>
          }
          renderDetail={(id) => {
            const item = ITEMS.find((candidate) => candidate.id === id);
            if (item === undefined) {
              return <p className="p-4 text-sm text-ink-subtle">This item is not in the list.</p>;
            }
            const isResolved = resolved.has(id);
            return (
              <div className="space-y-3 p-4">
                <h3 className="text-base font-medium text-ink">{item.name}</h3>
                <p className="font-mono text-code text-ink-muted">{item.message}</p>
                <div className="flex items-center gap-2">
                  <StatusBadge tone={isResolved ? "good" : "neutral"}>
                    {isResolved ? "Resolved" : "Unresolved"}
                  </StatusBadge>
                  <Button size="sm" variant="outline" onClick={() => toggle(id)}>
                    {isResolved ? "Reopen" : "Resolve"}
                  </Button>
                </div>
              </div>
            );
          }}
        />
        {opened !== undefined && (
          <output className="block border-t px-4 py-2 text-sm text-ink-subtle">
            Under 64rem, choosing {opened} opens its own page.
          </output>
        )}
      </Specimen>
      <div className="grid gap-4 lg:grid-cols-3">
        <Specimen title="List loading" className="block">
          <div aria-busy="true" aria-label="Loading the list" className="space-y-2">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        </Specimen>
        <Specimen title="List empty: the detail pane shows how to start" className="block">
          <Empty className="border p-4">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <InboxIcon />
              </EmptyMedia>
              <EmptyTitle>No unresolved errors in this period</EmptyTitle>
              <EmptyDescription>Errors appear here once the tracker reports one.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </Specimen>
        <Specimen title="List failed" className="block">
          <Alert variant="destructive">
            <OctagonAlertIcon />
            <AlertTitle>The errors could not load</AlertTitle>
            <AlertDescription>The server did not answer.</AlertDescription>
            <AlertAction>
              <Button variant="outline" size="sm">
                <RefreshCwIcon data-icon="inline-start" />
                Retry
              </Button>
            </AlertAction>
          </Alert>
        </Specimen>
      </div>
    </div>
  );
}

interface GeneralValues {
  name: string;
  keep: string;
  ignoreDataCenters: boolean;
}

const KEEP_ITEMS = [
  { value: "forever", label: "Forever" },
  { value: "365", label: "1 year" },
  { value: "90", label: "90 days" },
];

function GeneralTab({ onDirty }: { onDirty: (dirty: boolean) => void }) {
  const form = useDirtyForm<GeneralValues>({
    name: "Main site",
    keep: "forever",
    ignoreDataCenters: true,
  });
  const { dirty } = form;
  React.useEffect(() => onDirty(dirty), [dirty, onDirty]);
  return (
    <SettingsSection
      title="Settings"
      description="An example form. Save keeps the values on this page only; nothing is sent."
      form={form}
      onSave={(values) => form.saved(values)}
    >
      <Field>
        <FieldLabel htmlFor="ds-settings-name">Name</FieldLabel>
        <Input
          id="ds-settings-name"
          name="name"
          autoComplete="off"
          value={form.values.name}
          onChange={(event) => form.set("name", event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="ds-settings-keep">Keep events</FieldLabel>
        <Select
          items={KEEP_ITEMS}
          value={form.values.keep}
          onValueChange={(value) => {
            if (typeof value === "string") form.set("keep", value);
          }}
        >
          <SelectTrigger id="ds-settings-keep" className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KEEP_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>Older events are deleted one whole day at a time.</FieldDescription>
      </Field>
      <Field orientation="horizontal">
        <Checkbox
          id="ds-settings-data-centers"
          checked={form.values.ignoreDataCenters}
          onCheckedChange={(checked) => form.set("ignoreDataCenters", checked)}
        />
        <Label htmlFor="ds-settings-data-centers">Ignore visits from data centers</Label>
      </Field>
    </SettingsSection>
  );
}

interface ReplayValues {
  signed: boolean;
  mode: string;
}

function ReplayTab({ onDirty }: { onDirty: (dirty: boolean) => void }) {
  const form = useDirtyForm<ReplayValues>({ signed: false, mode: "off" });
  const { dirty } = form;
  React.useEffect(() => onDirty(dirty), [dirty, onDirty]);
  return (
    <>
      <SettingsSection
        title="Session replay"
        description="A switch and a choice that used to save at once now belong to the form."
        form={form}
        onSave={(values) => form.saved(values)}
      >
        <Field orientation="horizontal">
          <Switch
            id="ds-settings-signed"
            checked={form.values.signed}
            onCheckedChange={(checked) => form.set("signed", checked)}
          />
          <Label htmlFor="ds-settings-signed">Only accept user IDs signed by your server</Label>
        </Field>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-3 text-sm font-medium text-ink">Record replays</legend>
          <RadioGroup
            value={form.values.mode}
            onValueChange={(value) => {
              if (typeof value === "string") form.set("mode", value);
            }}
          >
            <Field orientation="horizontal">
              <RadioGroupItem value="off" id="ds-replay-off" />
              <Label htmlFor="ds-replay-off">Off</Label>
            </Field>
            <Field orientation="horizontal">
              <RadioGroupItem value="errors" id="ds-replay-errors" />
              <Label htmlFor="ds-replay-errors">Around errors</Label>
            </Field>
          </RadioGroup>
        </fieldset>
      </SettingsSection>
      <SettingsSection
        title="Danger zone"
        description="No fields, so no Save bar. A destructive action asks first."
      >
        <Dialog>
          <DialogTrigger render={<Button variant="destructive" className="self-start" />}>
            Delete all replays
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete all replays?</DialogTitle>
              <DialogDescription>
                This example deletes nothing. The real one cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
              <DialogClose render={<Button variant="destructive" />}>
                Delete all replays
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </SettingsSection>
    </>
  );
}

function SettingsSpecimens() {
  const [generalDirty, setGeneralDirty] = React.useState(false);
  const [replayDirty, setReplayDirty] = React.useState(false);
  return (
    <Specimen
      title="Settings tabs (?ds-tab=) and the Save bar: Save waits for a change, undoing it disables Save again"
      sample
      className="block p-0"
    >
      <SettingsTabs
        label="Example settings"
        param="ds-tab"
        tabs={[
          {
            value: "general",
            label: "Settings",
            dirty: generalDirty,
            content: <GeneralTab onDirty={setGeneralDirty} />,
          },
          {
            value: "replay",
            label: "Session replay",
            dirty: replayDirty,
            content: <ReplayTab onDirty={setReplayDirty} />,
          },
        ]}
      />
    </Specimen>
  );
}

const CHART_DAYS = [
  "2026-11-10",
  "2026-11-11",
  "2026-11-12",
  "2026-11-13",
  "2026-11-14",
  "2026-11-15",
  "2026-11-16",
];
const CHART_METRICS = [
  { value: "visitors", label: "Visitors", values: [96, 120, 104, 131, 88, 72, 154] },
  { value: "pageviews", label: "Pageviews", values: [230, 286, 241, 312, 205, 160, 386] },
];

function ReportChartSpecimens() {
  const [metric, setMetric] = React.useState("visitors");
  const chosen = CHART_METRICS.find((item) => item.value === metric) ?? CHART_METRICS[0];
  const values = chosen?.values ?? [];
  const points = CHART_DAYS.map((day, index) => ({ day, value: values[index] ?? null }));
  return (
    <Specimen
      title="Report chart: a short chart with its title, a toggle group, and Show the numbers"
      sample
      className="block"
    >
      <ReportChart
        title={`${chosen?.label ?? ""} per day`}
        description="One series a chart, so no legend. The numbers are a table under it once asked for."
        actions={
          <ToggleGroup
            value={[metric]}
            onValueChange={(next: string[]) => {
              const [value] = next;
              if (value !== undefined) setMetric(value);
            }}
            aria-label="Which figure to chart"
            variant="outline"
            size="sm"
            spacing={0}
          >
            {CHART_METRICS.map((item) => (
              <ToggleGroupItem key={item.value} value={item.value}>
                {item.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        }
        table={
          <Table>
            <caption className="sr-only">{chosen?.label} per day, sample data</caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col" className="text-xs font-normal text-ink-subtle">
                  Day
                </TableHead>
                <TableHead scope="col" className="text-right text-xs font-normal text-ink-subtle">
                  {chosen?.label}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {points.map((point) => (
                <TableRow key={point.day}>
                  <TableCell>{formatDay(point.day)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {point.value === null ? <Missing label="No data" /> : formatWhole(point.value)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        }
      >
        <DayChart
          points={points}
          label={`${chosen?.label ?? ""} per day, sample data`}
          tooltipRows={(index) => [
            {
              label: chosen?.label ?? "",
              value: formatWhole(points[index]?.value ?? 0),
              plotted: true,
            },
          ]}
          plotHeight={140}
        />
      </ReportChart>
    </Specimen>
  );
}

interface SampleHost {
  name: string;
  cpu: string;
  memory: string;
  disk: string | null;
  load: string;
  seen: string;
}

const SAMPLE_HOSTS: SampleHost[] = [
  {
    name: "web-1",
    cpu: "42%",
    memory: "61%",
    disk: "48%",
    load: "1.20",
    seen: "16 Nov 2026, 10:05",
  },
  {
    name: "web-2",
    cpu: "38%",
    memory: "57%",
    disk: null,
    load: "0.96",
    seen: "16 Nov 2026, 10:04",
  },
  {
    name: "worker-1",
    cpu: "71%",
    memory: "80%",
    disk: "63%",
    load: "2.41",
    seen: "16 Nov 2026, 10:05",
  },
];

function PinnedSpecimens() {
  const head = "text-xs font-normal whitespace-nowrap text-ink-subtle";
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <Specimen
        title="Pinned columns: on a phone the table scrolls inside itself, the name and the actions stay, and a fade says more waits"
        sample
        className="block p-0"
      >
        <ScrollHint>
          <Table>
            <caption className="sr-only">Sample hosts, with a scroll hint on a phone</caption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col" className={cn(head, "pl-4", PINNED)}>
                  Host
                </TableHead>
                <TableHead scope="col" className={cn(head, "text-right")}>
                  CPU
                </TableHead>
                <TableHead scope="col" className={cn(head, "text-right")}>
                  Memory
                </TableHead>
                <TableHead scope="col" className={cn(head, "text-right")}>
                  Disk
                </TableHead>
                <TableHead scope="col" className={cn(head, "text-right")}>
                  Load
                </TableHead>
                <TableHead scope="col" className={head}>
                  Last seen
                </TableHead>
                <TableHead scope="col" className={cn(head, "pr-4", PINNED_END)}>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {SAMPLE_HOSTS.map((host) => (
                <TableRow key={host.name}>
                  <TableCell className={cn("pl-4 font-mono", PINNED)}>{host.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{host.cpu}</TableCell>
                  <TableCell className="text-right tabular-nums">{host.memory}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {host.disk ?? <Missing label="Not sent" />}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{host.load}</TableCell>
                  <TableCell className="whitespace-nowrap text-ink-muted tabular-nums">
                    {host.seen}
                  </TableCell>
                  <TableCell className={cn("pr-4 text-right", PINNED_END)}>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Add an alert rule for ${host.name}`}
                    >
                      Add rule
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollHint>
      </Specimen>
      <Specimen
        title="A missing value: the dash for the eye, the words for a screen reader"
        className="block"
      >
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-ink-subtle">Disk</dt>
          <dd>
            <Missing label="Not sent" />
          </dd>
          <dt className="text-ink-subtle">Release</dt>
          <dd>
            <Missing label="No release" />
          </dd>
        </dl>
        <p className="mt-3 text-xs text-ink-subtle">
          The en dash is the only dash in the interface. A screen reader hears &ldquo;Not
          sent&rdquo; instead.
        </p>
      </Specimen>
    </div>
  );
}

const KEY_HINTS: { keys: string[]; text: string }[] = [
  { keys: ["j", "k"], text: "move through a list" },
  { keys: ["e"], text: "act on the chosen item" },
  { keys: ["Esc"], text: "clear the choice" },
  { keys: ["Ctrl", "B"], text: "collapse the sidebar" },
];

function KeyHintSpecimens() {
  const [filter, setFilter] = React.useState("unresolved");
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Specimen
        title="Key hints: each key in a Kbd, then what it does in plain words"
        className="block"
      >
        <ul aria-label="Key hints" className="flex flex-col gap-2 text-sm text-ink-subtle">
          {KEY_HINTS.map((hint) => (
            <li key={hint.text} className="flex items-center gap-2">
              <KbdGroup>
                {hint.keys.map((key) => (
                  <Kbd key={key}>{key}</Kbd>
                ))}
              </KbdGroup>
              {hint.text}
            </li>
          ))}
        </ul>
      </Specimen>
      <Specimen
        title="Toggle groups: one list of one kind at a time, the chosen one pressed"
        className="block"
      >
        <div className="flex flex-col gap-3">
          <ToggleGroup
            value={[filter]}
            onValueChange={(next: string[]) => {
              const [value] = next;
              if (value !== undefined) setFilter(value);
            }}
            aria-label="Which errors to list"
            variant="outline"
            spacing={0}
          >
            <ToggleGroupItem value="unresolved">Unresolved</ToggleGroupItem>
            <ToggleGroupItem value="resolved">Resolved</ToggleGroupItem>
            <ToggleGroupItem value="all">All</ToggleGroupItem>
          </ToggleGroup>
          <output className="text-sm text-ink-subtle">
            {filter === "all" ? "Every error is listed." : `Only ${filter} errors are listed.`}
          </output>
          <p className="text-xs text-ink-subtle">
            Not tabs: the lists share one table, so there is no panel per choice. Each button says
            whether it is pressed.
          </p>
        </div>
      </Specimen>
    </div>
  );
}

export function PatternsSection() {
  return (
    <Section
      id="patterns"
      title="Screen patterns"
      description="The blocks every screen is built from: reports (Console), lists with detail (Workbench), and settings tabs with a Save bar, each with made-up sample content. docs/design-system.md has the rules for each."
    >
      <div className="space-y-4">
        <FilterBarSpecimens />
        <StatStripSpecimens />
        <ReportChartSpecimens />
        <BreakdownSpecimens />
        <PinnedSpecimens />
        <WorkbenchSpecimens />
        <KeyHintSpecimens />
        <SettingsSpecimens />
      </div>
    </Section>
  );
}
