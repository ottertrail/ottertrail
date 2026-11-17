import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CORE_VITALS, type CoreVital, type Speed, type SpeedRow } from "@/lib/speed-api";
import { cn } from "@/lib/utils";

import { formatWhole } from "../analytics/format";
import { deviceLabel, formatVital, rate, VITALS } from "./format";
import { RatingIcon } from "./rating";

/** A p75 with its rating's icon; "–" when no load in the row had a value. */
function VitalCell({ name, row, speed }: { name: CoreVital; row: SpeedRow; speed: Speed }) {
  const value = row[name];
  return (
    <TableCell className="text-right tabular-nums">
      <span className="inline-flex items-center justify-end gap-1.5">
        {formatVital(name, value)}
        {value !== null && <RatingIcon rating={rate(name, value, speed.thresholds[name])} />}
      </span>
    </TableCell>
  );
}

function VitalHeads({ className }: { className?: string }) {
  return CORE_VITALS.map((name) => (
    <TableHead
      key={name}
      className={cn("text-right", className)}
      title={`${VITALS[name].name}, p75`}
    >
      {VITALS[name].short}
    </TableHead>
  ));
}

/** The Core Web Vitals per kind of device. */
export function DeviceTable({ speed }: { speed: Speed }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>By device</h3>
        </CardTitle>
        <CardDescription>p75 of each Core Web Vital, on each kind of device.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <caption className="sr-only">Speed by device</caption>
          <TableHeader>
            <TableRow>
              <TableHead>Device</TableHead>
              <TableHead className="text-right">Loads</TableHead>
              <VitalHeads />
            </TableRow>
          </TableHeader>
          <TableBody>
            {speed.devices.map((device) => (
              <TableRow key={device.deviceType ?? ""}>
                <TableCell>{deviceLabel(device.deviceType)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatWhole(device.loads)}
                </TableCell>
                {CORE_VITALS.map((name) => (
                  <VitalCell key={name} name={name} row={device} speed={speed} />
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/** The pages with the most measured loads, and their Core Web Vitals. */
export function PageTable({ speed }: { speed: Speed }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>Pages</h3>
        </CardTitle>
        <CardDescription>
          The {speed.pages.length === 20 ? "20 " : ""}pages with the most measured loads. A page
          load counts for the page the visitor landed on.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table className="table-fixed">
          <caption className="sr-only">Pages, most measured loads first</caption>
          <TableHeader>
            <TableRow>
              <TableHead>Page</TableHead>
              <TableHead className="w-20 text-right">Loads</TableHead>
              <VitalHeads className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {speed.pages.map((page) => (
              <TableRow key={page.path}>
                <TableCell className="truncate" title={page.path}>
                  {page.path}
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatWhole(page.loads)}</TableCell>
                {CORE_VITALS.map((name) => (
                  <VitalCell key={name} name={name} row={page} speed={speed} />
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
