import { parsePageUrl } from "../collection/normalize.ts";

/**
 * What the dashboard lists and shows about a replay, worked out once, when
 * the worker joins it (replays.ts), so neither the list nor the browser
 * reads a whole recording again (docs/session-replay.md, "Finding
 * replays"). Pure: tested on its own.
 *
 * It reads only what the recorder kept after masking it in the visitor's
 * browser (packages/tracker/src/replay-filter.ts), and from that only:
 * the page's address (already origin and path), the times, a clicked or
 * typed-in element's tag, its `role` and an input's `type` (structure
 * attributes the filter keeps as they are, and here only matched against
 * fixed lists), click positions, and scroll positions. Never text, typed
 * values, or any other attribute.
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
/** The custom event the recorder adds when the page's error happens. */
const ERROR_TAG = "error";

/** The most timeline items kept: the latest, nearest the error. */
export const MAX_TIMELINE_ITEMS = 500;
/** The most paths kept per replay. */
export const MAX_PAGES = 30;
/** Scrolls closer together than this are one item. */
const SCROLL_GAP_MS = 1_000;
/**
 * A visitor's clock this far off the server's is corrected. Far beyond the
 * tracker's retries (eight attempts, at most a minute apart): a first chunk
 * that came only on a retry, minutes late, does not move a right clock.
 */
export const CLOCK_TOLERANCE_MS = 10 * 60_000;
/** A recording longer than this has a forged or broken clock: its start is stored this far before its end. */
const MAX_STORED_DURATION_MS = 24 * 3_600_000;
/** How far up from a clicked element a button, link, or field is looked for. */
const ANCESTOR_STEPS = 6;

/** A field, button, or link's role: what the timeline says was clicked or typed in. */
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
 * Why items were left out past MAX_TIMELINE_ITEMS: only the earliest
 * scrolls ("scrolls"), or every scroll and then the earliest other items
 * ("earliest"); false when none were.
 */
export type Truncation = false | "scrolls" | "earliest";

export interface Timeline {
  items: TimelineItem[];
  truncated: Truncation;
}

/** A stored timeline item, as deriveReplay writes them. */
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
  /** The `role` attribute, when it is one of ROLES. */
  role: ElementRole | null;
  /** An input's `type`, lower case, when short and plain. */
  type: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value);
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** A tag name as the timeline may show it: plain, lower case; anything else is "element". */
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

/** An input's role from its type, as browsers give it. */
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

/** The element's role: its own `role` when known, otherwise its tag's. */
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

/** Adds a serialized node and everything inside it to the map, without recursion. */
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
 * What was clicked or typed in: the nearest button, link, or field at or
 * above the target (a click lands on the icon inside a button), else the
 * target itself; "element" when the recording does not know it.
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

/** The path of a page address, as page URLs are cleaned: no origin, query string, or fragment. */
export function pathOf(href: unknown): string | null {
  if (typeof href !== "string" || href === "") return null;
  return parsePageUrl(href)?.path ?? null;
}

/**
 * The items within the cap: as few scrolls as needed go first, the
 * earliest; then, with none left, the earliest of the rest.
 */
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
 * The details of a recording's events, which joinChunks checked are objects
 * with a numeric type and timestamp. `firstReceivedAt` is when its first
 * chunk arrived: the recorder sends it as the recording ends, so a
 * recording ending more than CLOCK_TOLERANCE_MS away from it was made on a
 * clock that is off, and its times are moved by the difference.
 */
export function deriveReplay(
  events: readonly { type: number; timestamp: number; data?: unknown }[],
  firstReceivedAt: Date,
): ReplayDetails {
  // As the player plays them: by time, the first event at 0.
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
  /** When the current run of scrolls last moved. */
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
