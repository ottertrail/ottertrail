/**
 * Store status lists without spaces (formatStatuses), for example "200-399" or
 * "200,204,300-302".
 */
export interface StatusRange {
  from: number;
  to: number;
}

export const DEFAULT_STATUSES = "200-399";

export const MAX_STATUS_PARTS = 10;

/** Reject codes outside 100 to 599 and descending ranges. */
export function parseStatuses(text: string): StatusRange[] | null {
  const parts = text.split(",").map((part) => part.trim());
  if (parts.length === 0 || parts.length > MAX_STATUS_PARTS) return null;
  const ranges: StatusRange[] = [];
  for (const part of parts) {
    const match = /^(\d{3})(?:\s*-\s*(\d{3}))?$/.exec(part);
    if (match === null) return null;
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    if (from < 100 || to > 599 || to < from) return null;
    ranges.push({ from, to });
  }
  return ranges;
}

export function formatStatuses(ranges: readonly StatusRange[]): string {
  return ranges
    .map((range) => (range.from === range.to ? String(range.from) : `${range.from}-${range.to}`))
    .join(",");
}

export function statusMatches(status: number, ranges: readonly StatusRange[]): boolean {
  return ranges.some((range) => status >= range.from && status <= range.to);
}
