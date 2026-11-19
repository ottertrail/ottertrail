import * as React from "react";

import { FilterBar, FilterBarRange } from "@/components/filter-bar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DEFAULT_ENVIRONMENT, isPeriod, PERIODS, type PageRange } from "@/lib/analytics-api";
import { loadChunk, PageLoadError } from "@/lib/lazy-page";
import { reloadPage } from "@/lib/reload";

/**
 * Loaded when "Custom range…" is first chosen, as on the analytics page:
 * its calendar is large. When its file cannot be downloaded (a tab left
 * open across a deploy), the dialog says so instead, and the page stays.
 */
const CustomRangeDialog = React.lazy(async () => {
  try {
    const loaded = await loadChunk(() => import("../analytics/custom-range-dialog"));
    return { default: loaded.CustomRangeDialog };
  } catch (error) {
    if (error instanceof PageLoadError) {
      return { default: CalendarUnavailable };
    }
    throw error;
  }
});

/** In place of the custom range dialog when its code could not be downloaded. */
function CalendarUnavailable({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>The calendar could not load</DialogTitle>
          <DialogDescription>
            Its code could not be downloaded. Ottertrail may have been updated since this tab was
            opened, or the connection dropped. Reload to get the current version, or choose a period
            instead.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={reloadPage}>Reload</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The period picker's choice for chosen days. */
const CUSTOM = "custom";
const PERIOD_ITEMS = [...PERIODS, { value: CUSTOM, label: "Custom range" }];

/** What the API said about the days and environments it answered for. */
export interface Answered {
  timeZone: string;
  firstDay: string;
  lastDay: string;
  /** The environments with data, when the response lists them. */
  environments?: string[];
}

/**
 * The period picker: a period that ends today, or "Custom range…", which
 * opens a dialog to choose the days. `answered` gives the dialog the days
 * shown now.
 */
export function PeriodSelect({
  range,
  answered,
  onRange,
}: {
  range: PageRange;
  answered: Answered | undefined;
  onRange: (range: PageRange) => void;
}) {
  const [choosingDays, setChoosingDays] = React.useState(false);
  return (
    <>
      <Select
        items={PERIOD_ITEMS}
        value={"period" in range ? range.period : CUSTOM}
        onValueChange={(value) => {
          if (isPeriod(value)) {
            onRange({ period: value });
          } else if (value === CUSTOM) {
            setChoosingDays(true);
          }
        }}
      >
        <SelectTrigger aria-label="Period" className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PERIOD_ITEMS.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.value === CUSTOM ? "Custom range…" : item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {choosingDays && (
        // Nothing while its code loads: a moment, from the same server.
        <React.Suspense fallback={null}>
          <CustomRangeDialog
            open
            onOpenChange={setChoosingDays}
            from={"from" in range ? range.from : (answered?.firstDay ?? "")}
            to={"to" in range ? range.to : (answered?.lastDay ?? "")}
            timeZone={answered?.timeZone}
            onApply={(from, to) => {
              setChoosingDays(false);
              onRange({ from, to });
            }}
          />
        </React.Suspense>
      )}
    </>
  );
}

/**
 * The environment picker, shown once there is a choice, and always while
 * another environment than the default is shown, so there is a way back.
 * Renders nothing otherwise.
 */
export function EnvironmentSelect({
  environment,
  answered,
  onEnvironment,
}: {
  environment: string;
  answered: Answered | undefined;
  onEnvironment: (environment: string) => void;
}) {
  const environments = answered?.environments ?? [environment];
  if (environments.length <= 1 && environment === DEFAULT_ENVIRONMENT) return null;
  return (
    <Select
      items={environments.map((name) => ({ value: name, label: name }))}
      value={environment}
      onValueChange={(value) => {
        if (typeof value === "string") {
          onEnvironment(value);
        }
      }}
    >
      <SelectTrigger aria-label="Environment" className="w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {environments.map((name) => (
          <SelectItem key={name} value={name}>
            {name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * A report's pinned filter bar (`FilterBar`): the period, the environment
 * once there is a choice, the report's own filters, and the days shown
 * with their timezone once the API has answered.
 */
export function ReportFilterBar({
  label = "Period and environment",
  range,
  environment,
  answered,
  onRange,
  onEnvironment,
  filters,
  actions,
}: {
  /** Names the bar for screen readers. */
  label?: string;
  range: PageRange;
  environment: string;
  answered: Answered | undefined;
  onRange: (range: PageRange) => void;
  onEnvironment: (environment: string) => void;
  /** The report's own controls, such as a device picker. */
  filters?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <FilterBar
      label={label}
      period={<PeriodSelect range={range} answered={answered} onRange={onRange} />}
      environment={
        <EnvironmentSelect
          environment={environment}
          answered={answered}
          onEnvironment={onEnvironment}
        />
      }
      filters={filters}
      range={
        answered !== undefined && (
          <FilterBarRange
            firstDay={answered.firstDay}
            lastDay={answered.lastDay}
            timeZone={answered.timeZone}
          />
        )
      }
      actions={actions}
    />
  );
}

/**
 * The period (or chosen days) and the environment, as on the analytics
 * page, in one row.
 */
export function RangeControls({
  range,
  environment,
  answered,
  onRange,
  onEnvironment,
  children,
}: {
  range: PageRange;
  environment: string;
  answered: Answered | undefined;
  onRange: (range: PageRange) => void;
  onEnvironment: (environment: string) => void;
  /** More controls in the same row, after these. */
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <PeriodSelect range={range} answered={answered} onRange={onRange} />
      <EnvironmentSelect
        environment={environment}
        answered={answered}
        onEnvironment={onEnvironment}
      />
      {children}
      {answered !== undefined && (
        <FilterBarRange
          firstDay={answered.firstDay}
          lastDay={answered.lastDay}
          timeZone={answered.timeZone}
        />
      )}
    </div>
  );
}
