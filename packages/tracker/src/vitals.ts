/**
 * Web Vitals, built to dist/v.js and served beside the tracker at /v.js.
 * The tracker loads it after it starts (script.ts), unless the page says
 * data-vitals="off": the measuring code is Google's web-vitals library
 * (Apache-2.0), about as large as the tracker itself, so pages that do not
 * want it never download it.
 *
 * It measures the page load it runs in: Largest Contentful Paint,
 * Interaction to Next Paint, Cumulative Layout Shift, First Contentful
 * Paint, and Time to First Byte. Each change goes to the tracker, which
 * keeps the latest values and sends them as one "vitals" event when the
 * page is first hidden or left (docs/web-analytics.md, "Web Vitals"). The
 * browser keeps the entries the library reads, so loading it after the
 * page loses only interactions before it ran.
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
