import { BreakdownTable } from "@/components/breakdown-table";
import { CORE_VITALS, type Speed, type SpeedRow } from "@/lib/speed-api";

import { formatWhole } from "../analytics/format";
import { deviceLabel, formatVital, rate, VITALS } from "./format";
import { RatingIcon } from "./rating";

function figuresOf(row: SpeedRow, speed: Speed) {
  return [
    formatWhole(row.loads),
    ...CORE_VITALS.map((name) => {
      const value = row[name];
      return (
        <span key={name} className="inline-flex items-center justify-end gap-1.5">
          {formatVital(name, value)}
          {value !== null && <RatingIcon rating={rate(name, value, speed.thresholds[name])} />}
        </span>
      );
    }),
  ];
}

/** Each vital's heading names the percentile, so a stacked row on a phone reads "LCP p75". */
const HEADINGS = ["Loads", ...CORE_VITALS.map((name) => `${VITALS[name].short} p75`)];

export function DeviceTable({ speed }: { speed: Speed }) {
  return (
    <BreakdownTable
      title="By device"
      headingLevel={2}
      caption="Speed by device"
      nameHeading="Device"
      figureHeadings={HEADINGS}
      rows={speed.devices.map((device) => ({
        key: device.deviceType ?? "",
        label: deviceLabel(device.deviceType),
        bar: device.loads,
        figures: figuresOf(device, speed),
      }))}
      empty="No page loads in this period."
      layout="stack"
    />
  );
}

export function PageTable({ speed }: { speed: Speed }) {
  return (
    <BreakdownTable
      title="Pages"
      headingLevel={2}
      caption="Pages, most measured loads first"
      nameHeading="Page"
      figureHeadings={HEADINGS}
      rows={speed.pages.map((page) => ({
        key: page.path,
        label: page.path,
        title: page.path,
        bar: page.loads,
        figures: figuresOf(page, speed),
      }))}
      empty="No page loads in this period."
      layout="stack"
    />
  );
}

export function SpeedTablesNote({ speed }: { speed: Speed }) {
  return (
    <p className="max-w-4xl text-xs text-pretty text-ink-subtle">
      Each table shows the p75 of each Core Web Vital. Pages lists the{" "}
      {speed.pages.length === 20 ? "20 " : ""}pages with the most measured loads. A page load counts
      for the page the visitor landed on.
    </p>
  );
}
