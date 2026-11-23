import { parsePageUrl } from "../collection/normalize.ts";

/**
 * Derive list and timeline data once at join time (replays.ts), avoiding
 * full-recording reads (docs/session-replay.md, "Finding replays"). Read only
 * masked data from packages/tracker/src/replay-filter.ts: origin and path,
 * times, tags, allowed roles and input types, click and scroll positions.
 * Never read text, typed values, or other attributes.
 */

/** rrweb's event types, sources, and node type (rrweb 2.2.2's documented enums). */
const FULL_SNAPSHOT = 2;
const INCREMENTAL = 3;
const META = 4;
const CUSTOM = 5;
const MUTATION = 0;
const MOUSE_INTERACTION = 2;
const SCROLL = 3;
const INPUT = 5;
const CLICK = 2;
const ELEMENT_NODE = 2;
const ERROR_TAG = "error";

/** The most timeline items kept: the latest, nearest the error. */
export const MAX_TIMELINE_ITEMS = 500;
export const MAX_PAGES = 30;
/** Scrolls closer together than this are one item. */
const SCROLL_GAP_MS = 1_000;
/**
 * Allow 10 minutes of clock drift so delayed retries do not trigger
 * correction (eight attempts, at most a minute apart).
 */
export const CLOCK_TOLERANCE_MS = 10 * 60_000;
/** Clamp longer recordings to this duration to limit forged or broken clocks. */
const MAX_STORED_DURATION_MS = 24 * 3_600_000;
const ANCESTOR_STEPS = 6;

export type ElementRole =
  | "button"
  | "link"
  | "checkbox"
  | "radio"
  | "switch"
  | "tab"
  | "menuitem"
  | "option"
  | "textbox"
  | "searchbox"
  | "combobox"
  | "listbox"
  | "slider"
  | "spinbutton";

const ROLES: ReadonlySet<string> = new Set<ElementRole>([
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "option",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "slider",
  "spinbutton",
]);

/** Elements that are clicked or typed in themselves, without a role. */
const INTERACTIVE_TAGS = new Set([
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "option",
]);

/** One moment of the timeline, `at` ms after the recording's first event. */
export type TimelineItem =
  | { at: number; kind: "page"; path: string }
  | { at: number; kind: "click"; tag: string; role: ElementRole | null; x: number; y: number }
  | { at: number; kind: "input"; tag: string; role: ElementRole | null }
  | { at: number; kind: "scroll"; y: number }
  | { at: number; kind: "error" };

/**
 * Truncation drops earliest scrolls first ("scrolls"), then other earliest
 * items ("earliest"); false means nothing was dropped.
 */
export type Truncation = false | "scrolls" | "earliest";

export interface Timeline {
  items: TimelineItem[];
  truncated: Truncation;
}

export function isTimelineItem(value: unknown): value is TimelineItem {
  if (!isRecord(value) || !isFiniteNumber(value.at)) return false;
  const role = value.role === null || (typeof value.role === "string" && isRole(value.role));
  switch (value.kind) {
    case "page":
      return typeof value.path === "string";
    case "click":
      return (
        typeof value.tag === "string" && role && isFiniteNumber(value.x) && isFiniteNumber(value.y)
      );
    case "input":
      return typeof value.tag === "string" && role;
    case "scroll":
      return isFiniteNumber(value.y);
    case "error":
      return true;
    default:
      return false;
  }
}

export interface ReplayDetails {
  /** The recording's first and last event, on the server's clock. */
  startedAt: Date;
  endedAt: Date;
  /** The server's clock minus the recording's, in ms: 0 unless the visitor's was off. */
  clockOffsetMs: number;
  /** Paths, in the order first seen. */
  pages: string[];
  clicks: number;
  pageChanges: number;
  timeline: Timeline;
}

interface NodeInfo {
  parent: number | undefined;
  tag: string;
  role: ElementRole | null;
  type: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value);
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Invalid tag names become "element". */
export function cleanTag(value: unknown): string {
  if (typeof value !== "string") return "element";
  const tag = value.toLowerCase();
  return /^[a-z][a-z0-9-]{0,39}$/.test(tag) ? tag : "element";
}

const isRole = (value: string): value is ElementRole => ROLES.has(value);

function roleOf(value: unknown): ElementRole | null {
  if (typeof value !== "string") return null;
  const role = value.trim().toLowerCase();
  return isRole(role) ? role : null;
}

function inputRole(type: string | null): ElementRole {
  switch (type) {
    case "checkbox":
    case "radio":
      return type;
    case "button":
    case "submit":
    case "reset":
    case "image":
      return "button";
    case "range":
      return "slider";
    case "number":
      return "spinbutton";
    case "search":
      return "searchbox";
    default:
      return "textbox";
  }
}

/** Prefer a recognized role attribute over the tag default. */
export function elementRole(info: { tag: string; role: ElementRole | null; type: string | null }) {
  if (info.role !== null) return info.role;
  switch (info.tag) {
    case "a":
      return "link";
    case "button":
    case "summary":
      return "button";
    case "select":
      return "combobox";
    case "textarea":
      return "textbox";
    case "option":
      return "option";
    case "input":
      return inputRole(info.type);
    default:
      return null;
  }
}

/** Avoid recursion when walking untrusted serialized nodes. */
function addNodes(nodes: Map<number, NodeInfo>, root: unknown, parent: number | undefined) {
  const stack: [unknown, number | undefined][] = [[root, parent]];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const [node, parentId] = next;
    if (!isRecord(node) || !isId(node.id)) continue;
    if (node.type === ELEMENT_NODE) {
      const attributes = isRecord(node.attributes) ? node.attributes : {};
      const { type } = attributes;
      nodes.set(node.id, {
        parent: parentId,
        tag: cleanTag(node.tagName),
        role: roleOf(attributes.role),
        type: typeof type === "string" && /^[a-z-]{1,20}$/i.test(type) ? type.toLowerCase() : null,
      });
    }
    if (Array.isArray(node.childNodes)) {
      for (const child of node.childNodes) stack.push([child, node.id]);
    }
  }
}

/**
 * Use the nearest button, link, or field ancestor so clicks on nested
 * icons describe the control. Fall back to the target or "element".
 */
function describe(nodes: Map<number, NodeInfo>, id: unknown) {
  const own = isId(id) ? nodes.get(id) : undefined;
  let info = own;
  for (let step = 0; info !== undefined && step < ANCESTOR_STEPS; step += 1) {
    if (info.role !== null || INTERACTIVE_TAGS.has(info.tag)) {
      return { tag: info.tag, role: elementRole(info) };
    }
    info = info.parent === undefined ? undefined : nodes.get(info.parent);
  }
  return { tag: own?.tag ?? "element", role: null };
}

/** Remove origin, query, and fragment to match cleaned page URLs. */
export function pathOf(href: unknown): string | null {
  if (typeof href !== "string" || href === "") return null;
  return parsePageUrl(href)?.path ?? null;
}

/** Drop earliest scrolls first, then other earliest items to meet the cap. */
function capped(items: TimelineItem[]): Timeline {
  const excess = items.length - MAX_TIMELINE_ITEMS;
  if (excess <= 0) return { items, truncated: false };
  const scrolls = items.filter((item) => item.kind === "scroll").length;
  if (scrolls >= excess) {
    let dropped = 0;
    const kept = items.filter((item) => {
      if (item.kind !== "scroll" || dropped >= excess) return true;
      dropped += 1;
      return false;
    });
    return { items: kept, truncated: "scrolls" };
  }
  const withoutScrolls = items.filter((item) => item.kind !== "scroll");
  return { items: withoutScrolls.slice(-MAX_TIMELINE_ITEMS), truncated: "earliest" };
}

/**
 * joinChunks validates event objects, types, and timestamps. The recorder
 * sends its first chunk when recording ends; correct clock drift when that
 * end differs from firstReceivedAt by more than CLOCK_TOLERANCE_MS.
 */
export function deriveReplay(
  events: readonly { type: number; timestamp: number; data?: unknown }[],
  firstReceivedAt: Date,
): ReplayDetails {
  const sorted = events.toSorted((a, b) => a.timestamp - b.timestamp);
  const start = sorted[0]?.timestamp ?? firstReceivedAt.getTime();
  const end = sorted.at(-1)?.timestamp ?? start;

  const nodes = new Map<number, NodeInfo>();
  const items: TimelineItem[] = [];
  const pages: string[] = [];
  let currentPath: string | null = null;
  let clicks = 0;
  let pageChanges = 0;
  /** The input being typed in: one item per run of inputs in one field. */
  let typingIn: number | null = null;
  let lastScrollAt = Number.NEGATIVE_INFINITY;

  const push = (item: TimelineItem) => {
    items.push(item);
    if (item.kind !== "input") typingIn = null;
    if (item.kind !== "scroll") lastScrollAt = Number.NEGATIVE_INFINITY;
  };

  for (const event of sorted) {
    const at = Math.max(0, Math.round(event.timestamp - start));
    const data = isRecord(event.data) ? event.data : {};
    if (event.type === META) {
      const path = pathOf(data.href);
      if (path === null || path === currentPath) continue;
      if (currentPath !== null) pageChanges += 1;
      currentPath = path;
      if (!pages.includes(path) && pages.length < MAX_PAGES) pages.push(path);
      push({ at, kind: "page", path });
    } else if (event.type === FULL_SNAPSHOT) {
      // A new snapshot numbers the page's nodes afresh.
      nodes.clear();
      addNodes(nodes, data.node, undefined);
    } else if (event.type === CUSTOM) {
      if (data.tag === ERROR_TAG) push({ at, kind: "error" });
    } else if (event.type === INCREMENTAL) {
      switch (data.source) {
        case MUTATION:
          if (Array.isArray(data.adds)) {
            for (const add of data.adds) {
              if (isRecord(add))
                addNodes(nodes, add.node, isId(add.parentId) ? add.parentId : undefined);
            }
          }
          break;
        case MOUSE_INTERACTION:
          if (data.type === CLICK) {
            clicks += 1;
            push({
              at,
              kind: "click",
              ...describe(nodes, data.id),
              x: isFiniteNumber(data.x) ? Math.round(data.x) : 0,
              y: isFiniteNumber(data.y) ? Math.round(data.y) : 0,
            });
          }
          break;
        case INPUT:
          if (isId(data.id) && data.id !== typingIn) {
            push({ at, kind: "input", ...describe(nodes, data.id) });
            typingIn = data.id;
          }
          break;
        case SCROLL: {
          const y = isFiniteNumber(data.y) ? Math.round(data.y) : 0;
          const last = items.at(-1);
          if (last?.kind === "scroll" && event.timestamp - lastScrollAt < SCROLL_GAP_MS) {
            last.y = y;
          } else {
            push({ at, kind: "scroll", y });
          }
          lastScrollAt = event.timestamp;
          break;
        }
        default:
          break;
      }
    }
  }

  const received = firstReceivedAt.getTime();
  const clockOffsetMs =
    Math.abs(received - end) > CLOCK_TOLERANCE_MS ? Math.round(received - end) : 0;
  const endedAt = end + clockOffsetMs;
  return {
    startedAt: new Date(endedAt - Math.min(end - start, MAX_STORED_DURATION_MS)),
    endedAt: new Date(endedAt),
    clockOffsetMs,
    pages,
    clicks,
    pageChanges,
    timeline: capped(items),
  };
}
