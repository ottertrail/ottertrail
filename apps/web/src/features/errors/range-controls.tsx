import * as React from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DEFAULT_ENVIRONMENT, isPeriod, PERIODS, type PageRange } from "@/lib/analytics-api";

import { formatDayRange } from "../analytics/format";

/**
 * Loaded when "Custom range…" is first chosen, as on the analytics page:
 * its calendar is large.
 */
const CustomRangeDialog = React.lazy(async () => ({
  default: (await import("../analytics/custom-range-dialog")).CustomRangeDialog,
}));

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
 * The period (or chosen days) and the environment, as on the analytics
 * page. The environment picker shows once there is a choice, and always
 * while another environment than the default is shown, so there is a way
 * back.
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
  const [choosingDays, setChoosingDays] = React.useState(false);
  const environments = answered?.environments ?? [environment];
  return (
    <div className="flex flex-wrap items-center gap-2">
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
      {(environments.length > 1 || environment !== DEFAULT_ENVIRONMENT) && (
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
      )}
      {children}
      {answered !== undefined && (
        <p className="text-sm text-ink-subtle">
          {formatDayRange(answered.firstDay, answered.lastDay)} · {answered.timeZone}
        </p>
      )}
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
    </div>
  );
}
