import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cn } from "cn";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import "../../src/styles/globals.css";
import { BreakdownTable, type BreakdownRow } from "../../src/components/breakdown-table.tsx";
import { FilterBar, FilterBarRange } from "../../src/components/filter-bar.tsx";
import { Missing } from "../../src/components/missing.tsx";
import { PINNED, PINNED_END } from "../../src/components/pinned-column.ts";
import { ReportChart } from "../../src/components/report-chart.tsx";
import { ScrollHint } from "../../src/components/scroll-hint.tsx";
import { SettingsSection } from "../../src/components/settings-section.tsx";
import { SettingsTabs } from "../../src/components/settings-tabs.tsx";
import { type Stat, StatStrip } from "../../src/components/stat-strip.tsx";
import { StatusBadge } from "../../src/components/status-badge.tsx";
import { Button } from "../../src/components/ui/button.tsx";
import { Checkbox } from "../../src/components/ui/checkbox.tsx";
import { Field, FieldDescription, FieldLabel } from "../../src/components/ui/field.tsx";
import { Input } from "../../src/components/ui/input.tsx";
import { Kbd, KbdGroup } from "../../src/components/ui/kbd.tsx";
import { Label } from "../../src/components/ui/label.tsx";
import { RadioGroup, RadioGroupItem } from "../../src/components/ui/radio-group.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../src/components/ui/select.tsx";
import { Switch } from "../../src/components/ui/switch.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../src/components/ui/table.tsx";
import { ToggleGroup, ToggleGroupItem } from "../../src/components/ui/toggle-group.tsx";
import { TooltipProvider } from "../../src/components/ui/tooltip.tsx";
import { ROW_LINK, workbenchRow } from "../../src/components/workbench-rows.ts";
import { Workbench, WorkbenchKeyHints } from "../../src/components/workbench.tsx";
import { DayChart } from "../../src/features/analytics/day-chart.tsx";
import {
  formatDay,
  formatWhole,
  pointsChange,
  relativeChange,
} from "../../src/features/analytics/format.ts";
import { useDirtyForm } from "../../src/hooks/use-dirty-form.ts";
import { trackMounted } from "./mounted.ts";

/*
 * The shared screen blocks (components/filter-bar.tsx, stat-strip.tsx,
 * report-chart.tsx, breakdown-table.tsx, pinned-column.ts, missing.tsx,
 * workbench.tsx, settings-tabs.tsx, settings-section.tsx, ui/kbd.tsx,
 * ui/toggle-group.tsx and hooks/use-dirty-form.ts), rendered directly with
 * test content on one page of a small router of their own (the workbench and
 * the settings tabs keep their state in the address), beside a link to
 * /projects to leave by.
 */

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

/** A card around one block, as a page puts it. */
function Block({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "min-w-0 overflow-hidden rounded-xl bg-card p-4 ring-1 ring-border [--block-surface:var(--card)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

function FilterBarBlock() {
  const [period, setPeriod] = React.useState("7d");
  return (
    <Block className="p-0">
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
    </Block>
  );
}

function StatStripBlocks() {
  return (
    <>
      <Block>
        <StatStrip stats={STATS} label="Summary" />
      </Block>
      <Block>
        <StatStrip stats={FEW_STATS} minCount={20} label="Summary with few visits" />
      </Block>
    </>
  );
}

function BreakdownBlocks() {
  const [pages, setPages] = React.useState("top");
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Block>
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
      </Block>
      <Block>
        <BreakdownTable
          title="Locations"
          caption="Countries, the most visitors first"
          nameHeading="Country"
          figureHeadings={["Visitors", "Visits"]}
          rows={COUNTRIES}
          layout="stack"
          empty="No visits in this period."
        />
      </Block>
      <Block>
        <BreakdownTable
          title="Custom events"
          caption="Custom events, the most visitors first"
          nameHeading="Event"
          figureHeadings={["Visitors", "Events"]}
          rows={[]}
          empty="No custom events in this period. Send one with ottertrail.track()."
        />
      </Block>
    </div>
  );
}

function ExampleList({
  selected,
  select,
}: {
  selected: string | undefined;
  select: (id: string) => void;
}) {
  return (
    <Table>
      <caption className="sr-only">Example errors, the most occurrences first</caption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Error</TableHead>
          <TableHead scope="col" className="text-right">
            Occurrences
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {ITEMS.map((item) => (
          <TableRow key={item.id} {...workbenchRow(item.id, item.id === selected)}>
            <TableCell className="max-w-0 whitespace-normal">
              <button
                type="button"
                {...ROW_LINK}
                aria-current={item.id === selected ? "true" : undefined}
                onClick={() => select(item.id)}
                className="block w-full truncate text-left"
              >
                {item.name}: <span>{item.message}</span>
              </button>
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatWhole(item.occurrences)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function WorkbenchBlock() {
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
    <Block className="p-0">
      <WorkbenchKeyHints action={action} />
      <Workbench
        label="Example errors"
        className="h-80"
        ids={ITEMS.map((item) => item.id)}
        param="item"
        action={action}
        onOpenPage={openPage}
        renderList={({ selected, select }) => <ExampleList selected={selected} select={select} />}
        summary={<h3>3 unresolved errors</h3>}
        renderDetail={(id) => {
          const item = ITEMS.find((candidate) => candidate.id === id);
          if (item === undefined) return <p>This item is not in the list.</p>;
          const isResolved = resolved.has(id);
          return (
            <div>
              <h3>{item.name}</h3>
              <StatusBadge tone={isResolved ? "good" : "neutral"}>
                {isResolved ? "Resolved" : "Unresolved"}
              </StatusBadge>
            </div>
          );
        }}
      />
      {opened !== undefined && <output>Under 64rem, choosing {opened} opens its own page.</output>}
    </Block>
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
      description="Save keeps the values in the test only."
      form={form}
      onSave={(values) => form.saved(values)}
    >
      <Field>
        <FieldLabel htmlFor="settings-name">Name</FieldLabel>
        <Input
          id="settings-name"
          name="name"
          autoComplete="off"
          value={form.values.name}
          onChange={(event) => form.set("name", event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="settings-keep">Keep events</FieldLabel>
        <Select
          items={KEEP_ITEMS}
          value={form.values.keep}
          onValueChange={(value) => {
            if (typeof value === "string") form.set("keep", value);
          }}
        >
          <SelectTrigger id="settings-keep" className="w-48">
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
          id="settings-data-centers"
          checked={form.values.ignoreDataCenters}
          onCheckedChange={(checked) => form.set("ignoreDataCenters", checked)}
        />
        <Label htmlFor="settings-data-centers">Ignore visits from data centers</Label>
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
    <SettingsSection title="Session replay" form={form} onSave={(values) => form.saved(values)}>
      <Field orientation="horizontal">
        <Switch
          id="settings-signed"
          checked={form.values.signed}
          onCheckedChange={(checked) => form.set("signed", checked)}
        />
        <Label htmlFor="settings-signed">Only accept user IDs signed by your server</Label>
      </Field>
      <fieldset>
        <legend>Record replays</legend>
        <RadioGroup
          value={form.values.mode}
          onValueChange={(value) => {
            if (typeof value === "string") form.set("mode", value);
          }}
        >
          <Field orientation="horizontal">
            <RadioGroupItem value="off" id="replay-off" />
            <Label htmlFor="replay-off">Off</Label>
          </Field>
          <Field orientation="horizontal">
            <RadioGroupItem value="errors" id="replay-errors" />
            <Label htmlFor="replay-errors">Around errors</Label>
          </Field>
        </RadioGroup>
      </fieldset>
    </SettingsSection>
  );
}

function SettingsBlock() {
  const [generalDirty, setGeneralDirty] = React.useState(false);
  const [replayDirty, setReplayDirty] = React.useState(false);
  return (
    <Block className="p-0">
      <SettingsTabs
        label="Example settings"
        param="tab"
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
    </Block>
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

function ReportChartBlock() {
  const [metric, setMetric] = React.useState("visitors");
  const chosen = CHART_METRICS.find((item) => item.value === metric) ?? CHART_METRICS[0];
  const values = chosen?.values ?? [];
  const points = CHART_DAYS.map((day, index) => ({ day, value: values[index] ?? null }));
  return (
    <Block>
      <ReportChart
        title={`${chosen?.label ?? ""} per day`}
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
            <caption className="sr-only">{chosen?.label} per day, test data</caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Day</TableHead>
                <TableHead scope="col" className="text-right">
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
          label={`${chosen?.label ?? ""} per day, test data`}
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
    </Block>
  );
}

interface TestHost {
  name: string;
  cpu: string;
  memory: string;
  disk: string | null;
  load: string;
  seen: string;
}

const HOSTS: TestHost[] = [
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

function PinnedBlock() {
  const head = "whitespace-nowrap";
  return (
    <Block className="p-0">
      <ScrollHint>
        <Table>
          <caption className="sr-only">Hosts, with a scroll hint on a phone</caption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col" className={cn(head, PINNED)}>
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
              <TableHead scope="col" className={cn(head, PINNED_END)}>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {HOSTS.map((host) => (
              <TableRow key={host.name}>
                <TableCell className={cn("font-mono", PINNED)}>{host.name}</TableCell>
                <TableCell className="text-right tabular-nums">{host.cpu}</TableCell>
                <TableCell className="text-right tabular-nums">{host.memory}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {host.disk ?? <Missing label="Not sent" />}
                </TableCell>
                <TableCell className="text-right tabular-nums">{host.load}</TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">{host.seen}</TableCell>
                <TableCell className={cn("text-right", PINNED_END)}>
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
    </Block>
  );
}

const KEY_HINTS: { keys: string[]; text: string }[] = [
  { keys: ["j", "k"], text: "move through a list" },
  { keys: ["e"], text: "act on the chosen item" },
  { keys: ["Esc"], text: "clear the choice" },
  { keys: ["Ctrl", "B"], text: "collapse the sidebar" },
];

function KeyHintBlocks() {
  const [filter, setFilter] = React.useState("unresolved");
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Block>
        <ul aria-label="Key hints">
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
      </Block>
      <Block>
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
        <output>
          {filter === "all" ? "Every error is listed." : `Only ${filter} errors are listed.`}
        </output>
      </Block>
    </div>
  );
}

function PatternsPage() {
  return (
    <main className="mx-auto max-w-6xl space-y-4 px-gutter py-10">
      <Link to="/projects">Projects</Link>
      <FilterBarBlock />
      <StatStripBlocks />
      <ReportChartBlock />
      <BreakdownBlocks />
      <PinnedBlock />
      <WorkbenchBlock />
      <KeyHintBlocks />
      <SettingsBlock />
    </main>
  );
}

/** The address the blocks are shown at. */
const PATTERNS = "/patterns";

/** Renders the blocks at `path` (PATTERNS, with a search string if wanted). */
function renderPatterns(path: string = PATTERNS) {
  document.documentElement.classList.add("dark");
  const root = createRootRoute({
    component: () => (
      <TooltipProvider>
        <Outlet />
      </TooltipProvider>
    ),
  });
  const routes = [
    createRoute({ getParentRoute: () => root, path: PATTERNS, component: PatternsPage }),
    createRoute({ getParentRoute: () => root, path: "/projects", component: () => "Projects" }),
  ];
  const router = createRouter({
    routeTree: root.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const reactRoot = createRoot(container);
  reactRoot.render(<RouterProvider router={router} />);
  trackMounted(() => {
    reactRoot.unmount();
    container.remove();
  });
  return router;
}

afterEach(async () => {
  await page.viewport(1280, 900);
});

const search = (router: ReturnType<typeof renderPatterns>) =>
  new URLSearchParams(router.state.location.searchStr);

describe("the filter bar", () => {
  test("holds the period and the filters, and shows the days and the timezone as two items", async () => {
    renderPatterns();

    await expect.element(page.getByText("10 to 16 Nov 2026", { exact: true })).toBeVisible();
    const element = document.querySelector("search[aria-label='Report filters']");
    if (element === null) throw new Error("No filter bar");
    const bar = page.elementLocator(element);
    await expect.element(bar.getByRole("combobox", { name: "Period" })).toBeVisible();
    await expect.element(bar.getByRole("group", { name: "Status" })).toBeVisible();
    await expect.element(bar.getByText("10 to 16 Nov 2026", { exact: true })).toBeVisible();
    await expect.element(bar.getByText("Asia/Singapore", { exact: true })).toBeVisible();
    expect(bar.element().textContent).not.toMatch(/[·–]/);
  });
});

describe("the stat strip", () => {
  test("shows each figure in tabular numerals, with its change read out as a sentence", async () => {
    renderPatterns();

    const strip = page.getByRole("definition").filter({ hasText: "1,820" });
    await expect.element(strip).toBeVisible();
    expect(getComputedStyle(strip.element()).fontVariantNumeric).toContain("tabular-nums");
    await expect.element(page.getByText("Up 12% from 683")).toBeInTheDocument();
    await expect.element(page.getByText("Down 6 points from 30%")).toBeInTheDocument();
    await expect.element(page.getByText("No change from 824")).toBeInTheDocument();
  });

  test("leaves out a change that rests on fewer than its minimum count", async () => {
    renderPatterns();

    // Up from 2 visits would read as 200%: the figures stand alone.
    await expect
      .poll(() => document.querySelector("dl[aria-label='Summary with few visits']")?.textContent)
      .toBe("Visitors6Visits7Pageviews9");
  });
});

describe("the breakdown table", () => {
  test("lists rows with bars in proportion, switches lists with its tabs, and offers show all", async () => {
    renderPatterns();

    const pages = page.getByRole("region", { name: "Pages" });
    const table = pages.getByRole("table", { name: "Pages, the most visitors first" });
    await expect.element(table).toBeVisible();
    const bars = [...pages.element().querySelectorAll<HTMLElement>("[data-slot=breakdown-bar]")];
    expect(bars.map((bar) => Math.round(Number.parseFloat(bar.style.width)))).toEqual([
      100,
      Math.round((201 / 322) * 100),
      Math.round((88 / 322) * 100),
    ]);
    await expect.element(table.getByRole("cell", { name: "/docs/getting-started" })).toBeVisible();

    // One table whose rows change: toggle buttons, not tabs without panels.
    expect(pages.element().querySelector("[role=tab], [role=tablist]")).toBeNull();
    const views = pages.getByRole("group", { name: "Which pages to list" });
    await expect
      .element(views.getByRole("button", { name: "Top pages" }))
      .toHaveAttribute("aria-pressed", "true");
    await views.getByRole("button", { name: "Entry" }).click();
    await expect
      .element(views.getByRole("button", { name: "Entry" }))
      .toHaveAttribute("aria-pressed", "true");
    // Pressing the shown list again keeps it shown.
    await views.getByRole("button", { name: "Entry" }).click();
    await expect
      .element(views.getByRole("button", { name: "Entry" }))
      .toHaveAttribute("aria-pressed", "true");

    await expect
      .element(table.getByRole("cell", { name: "/docs/getting-started" }))
      .not.toBeInTheDocument();
    await expect.element(pages.getByRole("button", { name: "Show all pages" })).toBeVisible();
  });

  test("says why it is empty instead of drawing an empty table", async () => {
    renderPatterns();

    const events = page.getByRole("region", { name: "Custom events" });
    await expect.element(events.getByText(/No custom events in this period/)).toBeVisible();
    await expect.element(events.getByRole("table")).not.toBeInTheDocument();
  });

  test("on a phone, stacks each row with its figures labelled, or scrolls inside itself", async () => {
    await page.viewport(390, 844);
    renderPatterns();

    const locations = page.getByRole("region", { name: "Locations" });
    const row = locations.getByRole("row").filter({ hasText: "Germany" });
    await expect.element(row).toBeVisible();
    expect(getComputedStyle(row.element()).display).toBe("grid");
    expect(row.element().textContent).toBe("GermanyVisitors155Visits160");

    const pages = page.getByRole("region", { name: "Pages" });
    await expect.element(pages.getByRole("table")).toBeVisible();
    const scroller = pages.element().querySelector<HTMLElement>("[data-slot=table-container]");
    expect(scroller?.scrollWidth).toBeGreaterThan(scroller?.clientWidth ?? 0);
    // The page itself never scrolls sideways.
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  });
});

describe("the workbench", () => {
  test("shows a summary until an item is chosen, and keeps the choice in the address", async () => {
    const router = renderPatterns();

    const summary = page.getByRole("region", { name: "Example errors, summary" });
    await expect.element(summary.getByText("3 unresolved errors")).toBeVisible();
    expect(search(router).get("item")).toBeNull();

    await page.getByRole("button", { name: /^ReferenceError/ }).click();

    await expect.poll(() => search(router).get("item")).toBe("reference-error");
    const detail = page.getByRole("region", { name: "Example errors, selected" });
    await expect.element(detail.getByRole("heading", { name: "ReferenceError" })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: /^ReferenceError/ }))
      .toHaveAttribute("aria-current", "true");
  });

  test("moves with j and k, acts with its key, and clears with Escape", async () => {
    const router = renderPatterns();
    await expect.element(page.getByText("3 unresolved errors")).toBeVisible();

    await userEvent.keyboard("j");
    await expect.poll(() => search(router).get("item")).toBe("type-error");
    await userEvent.keyboard("j");
    await expect.poll(() => search(router).get("item")).toBe("reference-error");
    await userEvent.keyboard("j");
    await userEvent.keyboard("j");
    // The last item stays chosen at the end of the list.
    await expect.poll(() => search(router).get("item")).toBe("network-error");
    await userEvent.keyboard("k");
    await expect.poll(() => search(router).get("item")).toBe("reference-error");

    const detail = page.getByRole("region", { name: "Example errors, selected" });
    await expect.element(detail.getByText("Unresolved")).toBeVisible();
    await userEvent.keyboard("e");
    await expect.element(detail.getByText("Resolved", { exact: true })).toBeVisible();

    await userEvent.keyboard("{Escape}");
    await expect.poll(() => search(router).get("item")).toBeNull();
    await expect.element(page.getByText("3 unresolved errors")).toBeVisible();
  });

  test("answers the keys again once a choice is made in a Select", async () => {
    const router = renderPatterns();

    await page.getByRole("combobox", { name: "Period" }).first().click();
    await page.getByRole("option", { name: "Last 30 days" }).click();
    await expect
      .element(page.getByRole("option", { name: "Last 30 days" }))
      .not.toBeInTheDocument();
    await userEvent.keyboard("j");

    await expect.poll(() => search(router).get("item")).toBe("type-error");
  });

  test("leaves the keys alone while a field has focus", async () => {
    const router = renderPatterns();

    const name = page.getByRole("textbox", { name: "Name" });
    await name.click();
    await userEvent.keyboard("j");

    expect(search(router).get("item")).toBeNull();
    await expect.element(name).toHaveValue("Main sitej");
  });

  test("under 64rem, shows the list alone and opens an item's own page", async () => {
    await page.viewport(800, 900);
    const router = renderPatterns();

    await expect.element(page.getByRole("button", { name: /^TypeError/ })).toBeVisible();
    await expect
      .element(page.getByRole("region", { name: "Example errors, summary" }))
      .not.toBeInTheDocument();

    await page.getByRole("button", { name: /^TypeError/ }).click();

    await expect
      .element(
        page.getByRole("status").filter({ hasText: "choosing type-error opens its own page" }),
      )
      .toBeVisible();
    expect(search(router).get("item")).toBeNull();
  });
});

const saveBar = () => page.getByRole("form", { name: "Settings" });
const exampleTabs = () => page.getByRole("tablist", { name: "Example settings" });

/** Whether closing the tab now would ask first. */
function unloadAsks() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("settings tabs and the save bar", () => {
  test("Save waits for a change, and undoing the change disables it again", async () => {
    renderPatterns();

    const form = saveBar();
    const save = form.getByRole("button", { name: "Save changes" });
    await expect.element(save).toHaveAttribute("aria-disabled", "true");
    await expect.element(form.getByText("No unsaved changes")).toBeVisible();
    await expect.element(form.getByRole("button", { name: "Discard" })).not.toBeInTheDocument();

    await form.getByRole("textbox", { name: "Name" }).fill("Main site 2");

    await expect.element(save).not.toHaveAttribute("aria-disabled", "true");
    await expect.element(form.getByText("Unsaved changes", { exact: true })).toBeVisible();
    await expect
      .element(exampleTabs().getByRole("tab", { name: /^Settings\s*, unsaved changes$/ }))
      .toBeVisible();

    await form.getByRole("textbox", { name: "Name" }).fill("Main site");

    await expect.element(save).toHaveAttribute("aria-disabled", "true");
    await expect.element(form.getByText("No unsaved changes")).toBeVisible();
  });

  test("Discard puts the saved values back, and Save makes the edits the saved ones", async () => {
    renderPatterns();

    const form = saveBar();
    const data = form.getByRole("checkbox", { name: "Ignore visits from data centers" });
    await data.click();
    await expect.element(data).not.toBeChecked();

    await form.getByRole("button", { name: "Discard" }).click();

    await expect.element(data).toBeChecked();
    await expect
      .element(form.getByRole("button", { name: "Save changes" }))
      .toHaveAttribute("aria-disabled", "true");

    await form.getByRole("textbox", { name: "Name" }).fill("Docs");
    await form.getByRole("button", { name: "Save changes" }).click();

    await expect.element(form.getByText("No unsaved changes")).toBeVisible();
    await expect.element(form.getByRole("textbox", { name: "Name" })).toHaveValue("Docs");
    await expect
      .element(form.getByRole("button", { name: "Save changes" }))
      .toHaveAttribute("aria-disabled", "true");
  });

  test("a switch and a choice join their section's form", async () => {
    const router = renderPatterns();

    await exampleTabs().getByRole("tab", { name: "Session replay" }).click();

    await expect.poll(() => search(router).get("tab")).toBe("replay");
    const form = page.getByRole("form", { name: "Session replay" });
    await form.getByRole("switch", { name: "Only accept user IDs signed by your server" }).click();
    await expect
      .element(form.getByRole("button", { name: "Save changes" }))
      .not.toHaveAttribute("aria-disabled", "true");
    await form.getByRole("switch", { name: "Only accept user IDs signed by your server" }).click();
    await expect
      .element(form.getByRole("button", { name: "Save changes" }))
      .toHaveAttribute("aria-disabled", "true");

    await form.getByRole("radio", { name: "Around errors" }).click();
    await expect
      .element(form.getByRole("button", { name: "Save changes" }))
      .not.toHaveAttribute("aria-disabled", "true");
  });

  test("the chosen tab comes from the address, and edits survive a visit to another tab", async () => {
    const router = renderPatterns(`${PATTERNS}?tab=replay`);

    await expect
      .element(exampleTabs().getByRole("tab", { name: "Session replay" }))
      .toHaveAttribute("aria-selected", "true");

    await exampleTabs()
      .getByRole("tab", { name: /^Settings/ })
      .click();
    await expect.poll(() => search(router).get("tab")).toBeNull();
    await saveBar().getByRole("textbox", { name: "Name" }).fill("Blog");
    await exampleTabs().getByRole("tab", { name: "Session replay" }).click();
    await exampleTabs()
      .getByRole("tab", { name: /^Settings/ })
      .click();

    await expect.element(saveBar().getByRole("textbox", { name: "Name" })).toHaveValue("Blog");
  });

  test("leaving with unsaved changes asks first, in the app and when the tab closes", async () => {
    const router = renderPatterns();

    await expect.element(saveBar()).toBeVisible();
    expect(unloadAsks()).toBe(false);

    await saveBar().getByRole("textbox", { name: "Name" }).fill("Blog");
    expect(unloadAsks()).toBe(true);

    await page.getByRole("link", { name: "Projects" }).click();
    const dialog = page.getByRole("dialog", { name: "Leave without saving?" });
    await expect.element(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Stay on this page" }).click();
    await expect.element(dialog).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe(PATTERNS);
    await expect.element(saveBar().getByRole("textbox", { name: "Name" })).toHaveValue("Blog");

    await page.getByRole("link", { name: "Projects" }).click();
    await page.getByRole("button", { name: "Leave and discard" }).click();
    await expect.poll(() => router.state.location.pathname).toBe("/projects");
  });
});

describe("the report chart", () => {
  test("switches its figure with a toggle group, and shows its numbers on request", async () => {
    renderPatterns();
    const chart = page.getByRole("region", { name: "Visitors per day", exact: true });
    const which = chart.getByRole("group", { name: "Which figure to chart" });
    await expect
      .element(which.getByRole("button", { name: "Visitors" }))
      .toHaveAttribute("aria-pressed", "true");

    await chart.getByRole("button", { name: "Show the numbers" }).click();
    const numbers = chart.getByRole("table", { name: "Visitors per day, test data" });
    await expect.element(numbers).toBeVisible();
    await expect.element(numbers.getByRole("cell", { name: "154" })).toBeVisible();

    await which.getByRole("button", { name: "Pageviews" }).click();
    const pageviews = page.getByRole("region", { name: "Pageviews per day", exact: true });
    await expect.element(pageviews).toBeVisible();
    await expect
      .element(pageviews.getByRole("button", { name: "Pageviews" }))
      .toHaveAttribute("aria-pressed", "true");
    await expect.element(pageviews.getByRole("cell", { name: "386" })).toBeVisible();
    await pageviews.getByRole("button", { name: "Hide the numbers" }).click();
    await expect.element(pageviews.getByRole("table")).not.toBeInTheDocument();
  });
});

const hosts = () => page.getByRole("table", { name: "Hosts, with a scroll hint on a phone" });

describe("a table with pinned columns", () => {
  test("a missing value shows the dash and reads out what is missing", async () => {
    renderPatterns();
    const missing = hosts().getByRole("cell", { name: "Not sent" });
    await expect.element(missing).toBeVisible();
    expect(missing.element().querySelector("[aria-hidden=true]")?.textContent).toBe("–");
  });

  test("at 390 it scrolls inside itself, its host and action pinned, and nothing else scrolls sideways", async () => {
    await page.viewport(390, 844);
    renderPatterns();
    await expect.element(hosts()).toBeInTheDocument();

    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    const container = hosts().element().closest<HTMLElement>("[data-slot=table-container]");
    expect(container?.scrollWidth ?? 0).toBeGreaterThan(container?.clientWidth ?? 0);
    const first = hosts().getByRole("cell", { name: "web-1" }).element();
    expect(getComputedStyle(first).position).toBe("sticky");
    const action = hosts()
      .getByRole("button", { name: "Add an alert rule for web-1" })
      .element()
      .closest("td");
    expect(action === null ? "" : getComputedStyle(action).position).toBe("sticky");
    await expect
      .poll(() => container?.parentElement?.querySelector("[data-slot=scroll-hint]") ?? null)
      .not.toBeNull();
  });

  test("at 1440 it fits, and nothing scrolls sideways", async () => {
    await page.viewport(1440, 900);
    renderPatterns();
    await expect.element(hosts()).toBeVisible();

    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(1440);
    const container = hosts().element().closest<HTMLElement>("[data-slot=table-container]");
    expect(container?.scrollWidth).toBeLessThanOrEqual(container?.clientWidth ?? 0);
  });
});

describe("key hints and toggle groups", () => {
  test("key hints name each key, and the status toggle group says which list it shows", async () => {
    renderPatterns();
    const hints = page.getByRole("list", { name: "Key hints" });
    await expect.element(hints).toMatchTextContent(/^jk\s*move through a list/);
    expect(hints.element().querySelectorAll("[data-slot=kbd]").length).toBe(6);

    const which = page.getByRole("group", { name: "Which errors to list" });
    await which.getByRole("button", { name: "Resolved" }).click();
    await expect
      .element(which.getByRole("button", { name: "Resolved" }))
      .toHaveAttribute("aria-pressed", "true");
    await expect
      .element(which.getByRole("button", { name: "Unresolved" }))
      .toHaveAttribute("aria-pressed", "false");
    await expect.element(page.getByText("Only resolved errors are listed.")).toBeVisible();
  });
});
