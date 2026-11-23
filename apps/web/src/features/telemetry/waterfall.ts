import type { WaterfallSpan } from "@/lib/traces-api";

export interface WaterfallRow {
  span: WaterfallSpan;
  depth: number;
  /** Show spans with missing parents at the top level. */
  orphan: boolean;
}

const byStart = (a: WaterfallSpan, b: WaterfallSpan) => a.offsetUs - b.offsetUs;

/** Show missing parents at the top level and cut parent cycles so each span appears once. */
export function waterfallRows(spans: readonly WaterfallSpan[]): WaterfallRow[] {
  const ids = new Set(spans.map((span) => span.spanId));
  const children = new Map<string, WaterfallSpan[]>();
  const tops: WaterfallSpan[] = [];
  for (const span of spans) {
    if (
      span.parentSpanId !== "" &&
      ids.has(span.parentSpanId) &&
      span.parentSpanId !== span.spanId
    ) {
      const siblings = children.get(span.parentSpanId) ?? [];
      siblings.push(span);
      children.set(span.parentSpanId, siblings);
    } else {
      tops.push(span);
    }
  }
  const rows: WaterfallRow[] = [];
  const placed = new Set<WaterfallSpan>();
  const visit = (span: WaterfallSpan, depth: number, orphan: boolean) => {
    if (placed.has(span)) return;
    placed.add(span);
    rows.push({ span, depth, orphan });
    for (const child of (children.get(span.spanId) ?? []).toSorted(byStart)) {
      visit(child, depth + 1, false);
    }
  };
  for (const span of tops.toSorted(byStart)) {
    visit(span, 0, span.parentSpanId !== "");
  }
  for (const span of spans.toSorted(byStart)) {
    if (!placed.has(span)) visit(span, 0, true);
  }
  return rows;
}
