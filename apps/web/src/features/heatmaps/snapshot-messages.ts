/** Accept only matching messages from this origin and snapshot frame (packages/replay-player/src/snapshot.ts, snapshotMissingMessage). The API page's CSP prevents snapshot scripts. */
export const SNAPSHOT_MISSING_MESSAGE = "ottertrail:snapshot-missing";
/** Match the snapshot frame's message limit. */
const MAX_MISSING = 200;

export interface MissingElements {
  items: { label: string | null; element: string; clicks: number }[];
  /** How many in all; `items` lists the first 200. */
  total: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isItem = (value: unknown): value is MissingElements["items"][number] =>
  isRecord(value) &&
  Object.keys(value).length === 3 &&
  (value.label === null || (typeof value.label === "string" && value.label.length <= 64)) &&
  typeof value.element === "string" &&
  value.element.length <= 512 &&
  isCount(value.clicks);

export function readSnapshotMissingMessage(
  event: { origin: string; source: unknown; data: unknown },
  frame: object | null | undefined,
  origin: string,
): MissingElements | null {
  if (frame === null || frame === undefined || event.source !== frame || event.origin !== origin) {
    return null;
  }
  const { data } = event;
  if (!isRecord(data) || data.type !== SNAPSHOT_MISSING_MESSAGE) return null;
  if (Object.keys(data).length !== 4 || !isCount(data.total) || !isCount(data.found)) return null;
  const { missing } = data;
  if (!Array.isArray(missing) || missing.length > MAX_MISSING || !missing.every(isItem)) {
    return null;
  }
  return { items: missing.filter(isItem), total: Math.max(data.total, missing.length) };
}
