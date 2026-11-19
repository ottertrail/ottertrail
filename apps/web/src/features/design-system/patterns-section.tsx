import { InboxIcon, OctagonAlertIcon, RefreshCwIcon } from "lucide-react";
import * as React from "react";

import { BreakdownTable, type BreakdownRow } from "@/components/breakdown-table";
import { FilterBar, FilterBarRange } from "@/components/filter-bar";
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
import { relativeChange, pointsChange, formatWhole } from "@/features/analytics/format";
import { useDirtyForm } from "@/hooks/use-dirty-form";

import { Section, Specimen } from "./section";

// Example figures, from the browser tests' fixtures (tests/browser/fake-api.ts).
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
    count: 683,
  },
  { label: "Visits", value: "824", change: relativeChange(824, 824), before: "824", count: 824 },
  {
    label: "Pageviews",
    value: "1,820",
    change: relativeChange(1820, 2000),
    before: "2,000",
    count: 2000,
  },
  {
    label: "Bounce rate",
    value: "24%",
    change: pointsChange(0.24, 0.3),
    before: "30%",
    count: 824,
  },
  { label: "Visit duration", value: "4m 23s" },
];

const FEW_STATS: Stat[] = [
  { label: "Visitors", value: "6", change: relativeChange(6, 2), before: "2", count: 2 },
  { label: "Visits", value: "7", change: relativeChange(7, 2), before: "2", count: 2 },
  // No count: with a minimum set, its change is left out too.
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
        className="block"
      >
        <StatStrip stats={STATS} label="Summary" />
      </Specimen>
      <div className="grid gap-4 lg:grid-cols-2">
        <Specimen
          title="Too few to compare: minCount 20 hides a change that rests on 2 visits"
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
        title="Breakdown table: tabs in its header, bars in proportion, show all"
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
      <Specimen title="Stacked rows on phones (layout stack)" className="block">
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

export function PatternsSection() {
  return (
    <Section
      id="patterns"
      title="Screen patterns"
      description="The blocks every screen is built from: reports (Console), lists with detail (Workbench), and settings tabs with a Save bar. docs/design-system.md has the rules for each."
    >
      <div className="space-y-4">
        <FilterBarSpecimens />
        <StatStripSpecimens />
        <BreakdownSpecimens />
        <WorkbenchSpecimens />
        <SettingsSpecimens />
      </div>
    </Section>
  );
}
