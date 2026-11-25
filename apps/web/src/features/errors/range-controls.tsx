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

/** Load the large calendar on demand. Handle missing chunks after a deploy without losing the page. */
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
            The calendar download failed. Reload to try again, or choose a preset period.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={reloadPage}>Reload</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const CUSTOM = "custom";

export type PeriodItem = (typeof PERIODS)[number];

export interface Answered {
  timeZone: string;
  firstDay: string;
  lastDay: string;
  environments?: string[];
}

/** `answered` supplies the displayed days as the custom range default. */
export function PeriodSelect({
  range,
  answered,
  onRange,
  periods = PERIODS,
}: {
  range: PageRange;
  answered: Answered | undefined;
  onRange: (range: PageRange) => void;
  /** The presets offered; a page that needs longer periods leaves the short ones out. */
  periods?: readonly PeriodItem[];
}) {
  const [choosingDays, setChoosingDays] = React.useState(false);
  const PERIOD_ITEMS = [...periods, { value: CUSTOM, label: "Custom range" }];
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

/** Keep the picker visible for a selected environment so the user can switch back. */
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

export function ReportFilterBar({
  label = "Period and environment",
  range,
  environment,
  answered,
  onRange,
  onEnvironment,
  filters,
  actions,
  period,
  periods,
}: {
  label?: string;
  range: PageRange;
  environment: string;
  answered: Answered | undefined;
  onRange: (range: PageRange) => void;
  onEnvironment: (environment: string) => void;
  filters?: React.ReactNode;
  actions?: React.ReactNode;
  /** Replaces both the period picker and dates, as in the Logs live view. */
  period?: React.ReactNode;
  /** The period presets offered, when not all. */
  periods?: readonly PeriodItem[];
}) {
  return (
    <FilterBar
      label={label}
      period={
        period ?? (
          <PeriodSelect range={range} answered={answered} onRange={onRange} periods={periods} />
        )
      }
      environment={
        <EnvironmentSelect
          environment={environment}
          answered={answered}
          onEnvironment={onEnvironment}
        />
      }
      filters={filters}
      range={
        answered !== undefined &&
        period === undefined && (
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
