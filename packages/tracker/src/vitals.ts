/**
 * Load web-vitals separately so data-vitals="off" avoids its download.
 * The tracker sends the latest values when the page is first hidden or left.
 * Browser entries survive late loading; earlier interactions are lost.
 * See docs/web-analytics.md, "Web Vitals".
 */
import { type Metric, onCLS, onFCP, onINP, onLCP, onTTFB } from "web-vitals";

import { RECORD_PROPERTY, type RecordVital } from "./vital-names.ts";

const isRecordVital = (value: unknown): value is RecordVital => typeof value === "function";

const script = document.currentScript;
const record: unknown = script === null ? undefined : Reflect.get(script, RECORD_PROPERTY);
if (isRecordVital(record)) {
  const report = (metric: Metric) => {
    try {
      record(metric.name, metric.value);
    } catch {
      // Never break the page the tracker runs on.
    }
  };
  // Every change, not only the final value: the tracker sends what it has
  // when the page is first hidden, whichever listener runs first then.
  for (const on of [onLCP, onINP, onCLS, onFCP, onTTFB]) {
    on(report, { reportAllChanges: true });
  }
}
