/**
 * The heatmap overlay, as o.js runs it (overlay.ts; docs/web-analytics.md,
 * "The overlay on your site"): the project's heatmap for this page, drawn
 * over the live page for the owner who opened it from the dashboard.
 *
 * - It exchanges the link token the tracker took from the address for a
 *   session token, kept in this closure only: never stored, never in an
 *   address.
 * - It reads the page's aggregates (clicks per element in an 8 by 8 grid,
 *   scroll reach per 5%) for a device class and period.
 * - It draws them on a canvas in a fixed layer that lets every click
 *   through, inside a closed shadow root, so the page's styles and scripts
 *   cannot reach it and it changes nothing of the page's. A small panel
 *   holds the period, the device, the totals, and the elements not found
 *   on this page.
 *
 * Everything from the API is drawn as shapes or set as text
 * (textContent, fillText), never parsed as HTML.
 */
import { type Device, deviceOf, NAME_ATTRIBUTE, resolveKeys } from "./heatmap-path.ts";
import type { OverlayConfig } from "./overlay-names.ts";

export const PERIODS = [
  { value: "7d", label: "Last 7 days", days: 7 },
  { value: "30d", label: "Last 30 days", days: 30 },
  { value: "90d", label: "Last 90 days", days: 90 },
] as const;
type Period = (typeof PERIODS)[number]["value"];
const DEVICES: { value: Device; label: string }[] = [
  { value: "desktop", label: "Desktop" },
  { value: "tablet", label: "Tablet" },
  { value: "mobile", label: "Mobile" },
];
/** The grid the API counts clicks in, per element. */
const GRID = 8;
/** What the overlay takes from an answer at most, whatever the API sends. */
const MAX_ELEMENTS = 200;
const MAX_CELLS = 64;
/** Not-found elements listed at most; the rest are counted. */
const MAX_LISTED = 50;
/**
 * Elements are looked for again at most this often while the page's
 * elements change (scrolling and resizing only redraw).
 */
const RESOLVE_EVERY_MS = 1000;

/** The overlay's states (docs/web-analytics.md, "The overlay on your site"). */
export type OverlayState =
  | "loading"
  | "link_expired"
  | "no_access"
  | "session_expired"
  | "empty"
  | "failed"
  | "ready";

export const MESSAGES: Record<Exclude<OverlayState, "ready" | "empty">, string> = {
  loading: "Loading the heatmap…",
  link_expired: "This link has expired or was already used. Open it again from the dashboard.",
  no_access:
    "Your account cannot view this project's heatmaps. An owner or admin can give you Web analytics.",
  session_expired: "This heatmap session ended after 30 minutes. Open it again from the dashboard.",
  failed: "The heatmap could not load.",
};

export interface OverlayElement {
  label: string | null;
  element: string;
  clicks: number;
  rageClicks: number;
  cells: [number, number, number][];
}

export interface OverlayData {
  firstDay: string;
  lastDay: string;
  totals: { pageviews: number; clicks: number; rageClicks: number };
  reach: { depth: number; share: number }[];
  elements: OverlayElement[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const whole = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
const text = (value: unknown, max: number): string =>
  typeof value === "string" ? value.slice(0, max) : "";

/** The parts of an answer the overlay uses, checked and capped: anything else is dropped. */
export function parseOverlay(value: unknown): OverlayData | null {
  if (!isRecord(value) || !isRecord(value.totals)) return null;
  const elements = Array.isArray(value.elements) ? value.elements.slice(0, MAX_ELEMENTS) : [];
  const reach = Array.isArray(value.reach) ? value.reach.slice(0, 20) : [];
  return {
    firstDay: text(value.firstDay, 10),
    lastDay: text(value.lastDay, 10),
    totals: {
      pageviews: whole(value.totals.pageviews),
      clicks: whole(value.totals.clicks),
      rageClicks: whole(value.totals.rageClicks),
    },
    reach: reach.filter(isRecord).map((step) => ({
      depth: Math.min(100, whole(step.depth)),
      share: Math.min(1, Math.max(0, Number(step.share) || 0)),
    })),
    elements: elements.filter(isRecord).map((item) => ({
      label: typeof item.label === "string" ? item.label.slice(0, 64) : null,
      element: text(item.element, 512),
      clicks: whole(item.clicks),
      rageClicks: whole(item.rageClicks),
      cells: (Array.isArray(item.cells) ? item.cells.slice(0, MAX_CELLS) : [])
        .filter((cell): cell is unknown[] => Array.isArray(cell))
        .map((cell): [number, number, number] => [
          Math.min(GRID - 1, whole(cell[0])),
          Math.min(GRID - 1, whole(cell[1])),
          whole(cell[2]),
        ]),
    })),
  };
}

/** An element's name for people: the site's own, or its path's last two steps. */
export function elementName(item: Pick<OverlayElement, "label" | "element">): string {
  return item.label ?? item.element.split(">").slice(-2).join(" > ");
}

const formatWhole = (value: number) => value.toLocaleString("en-US");
const plural = (count: number, one: string, many: string) =>
  `${formatWhole(count)} ${count === 1 ? one : many}`;

const STYLES = `
:host { all: initial; }
.layer { position: fixed; inset: 0; pointer-events: none; }
canvas { position: absolute; left: 0; top: 0; pointer-events: none; }
.panel {
  position: fixed; left: 16px; bottom: 16px; width: 300px; max-width: calc(100vw - 48px);
  max-height: 70vh; overflow: auto; pointer-events: auto; box-sizing: border-box;
  background: #fff; color: #18181b; border: 1px solid #d4d4d8; border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18); padding: 12px;
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; text-align: left;
}
.panel * { box-sizing: border-box; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
h2 { margin: 0; font-size: 14px; font-weight: 600; }
.path { margin: 2px 0 8px; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: #52525b; word-break: break-all; }
button, select {
  font: inherit; color: inherit; background: #fff; border: 1px solid #d4d4d8; border-radius: 6px;
  padding: 3px 8px; margin: 0; cursor: pointer;
}
button:hover, select:hover { background: #f4f4f5; }
button[aria-pressed="true"] { background: #18181b; border-color: #18181b; color: #fff; }
:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
.close { border: 0; font-size: 18px; line-height: 1; padding: 2px 6px; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 6px 0; }
.label { color: #52525b; margin-right: 2px; }
.status { margin: 8px 0 0; }
.status[data-tone="problem"] { color: #b91c1c; }
.totals { margin: 8px 0 0; font-variant-numeric: tabular-nums; }
.note { margin: 8px 0 0; color: #52525b; font-size: 12px; }
details { margin: 8px 0 0; }
summary { cursor: pointer; }
ol { margin: 4px 0 0; padding-left: 20px; max-height: 160px; overflow: auto; }
li { margin: 2px 0; }
.name { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
[hidden] { display: none !important; }
@media (prefers-reduced-motion: no-preference) {
  .panel { transition: opacity 120ms ease-out; }
}
`;

export interface OverlayOptions {
  window: Window;
  document: Document;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** The nonce of o.js's script, for a stylesheet when constructed ones are unsupported. */
  nonce?: string;
  /** For tests: called with each new state. */
  onState?: (state: OverlayState) => void;
}

/** What a request got: its status (0 without a readable answer), error code, and a success's body. */
interface Answer {
  status: number;
  error: string;
  body?: unknown;
}

/** What the exchange came to; a failure says its state, and whether it is worth a panel. */
type Exchanged =
  | { ok: true }
  | { ok: false; state: Exclude<OverlayState, "ready" | "empty" | "loading">; show: boolean };

/** Starts the overlay on this page. Returns its controls, for o.js and tests. */
export function startOverlay(config: OverlayConfig, options: OverlayOptions) {
  const { window: win, document: doc } = options;
  const api = new URL("/api/heatmap-overlay/", config.host).href;
  const pagePath = win.location.pathname;
  let link: string | null = config.token;
  let told = false;
  /** Tells the tracker, once, whether the overlay is shown. */
  const settled = (shown: boolean) => {
    if (told) return;
    told = true;
    try {
      config.settled(shown);
    } catch {
      // The tracker's own business.
    }
  };
  let session: { token: string; projectId: string } | null = null;
  let device: Device = deviceOf(win.innerWidth);
  let period: Period = "30d";
  let data: OverlayData | null = null;
  let found: { item: OverlayElement; node: Element }[] = [];
  let state: OverlayState = "loading";
  let closed = false;
  let frame: number | undefined;
  let resolveTimer: ReturnType<typeof setTimeout> | undefined;
  let lastResolve = 0;
  /** Each read: an answer for an earlier choice is dropped. */
  let asked = 0;
  /** The exchange in flight, which every read waits for. */
  let exchanging: Promise<Exchanged> | undefined;

  // The host: a custom element, fixed over the page, letting every pointer event through.
  const host = doc.createElement("ottertrail-heatmap");
  const hostStyle: [string, string][] = [
    ["all", "initial"],
    ["position", "fixed"],
    ["inset", "0"],
    ["z-index", "2147483647"],
    ["pointer-events", "none"],
    ["display", "block"],
  ];
  for (const [name, value] of hostStyle) host.style.setProperty(name, value, "important");
  const root = host.attachShadow({ mode: "closed" });
  const make = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: { className?: string; text?: string } = {},
    parent?: Node,
  ): HTMLElementTagNameMap[K] => {
    const element = doc.createElement(tag);
    if (props.className !== undefined) element.className = props.className;
    if (props.text !== undefined) element.textContent = props.text;
    parent?.appendChild(element);
    return element;
  };
  // Constructed stylesheets need no nonce under a strict CSP; else a <style> with o.js's nonce.
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(STYLES);
    root.adoptedStyleSheets = [sheet];
  } catch {
    const style = make("style", { text: STYLES }, root);
    if (options.nonce) style.nonce = options.nonce;
  }

  const layer = make("div", { className: "layer" }, root);
  const canvas = make("canvas", {}, layer);
  canvas.setAttribute("aria-hidden", "true");
  const context = canvas.getContext("2d");

  const panel = make("aside", { className: "panel" }, root);
  panel.setAttribute("aria-label", "Ottertrail heatmap");
  const head = make("div", { className: "head" }, panel);
  make("h2", { text: "Heatmap" }, head);
  const close = make("button", { className: "close", text: "×" }, head);
  close.type = "button";
  close.setAttribute("aria-label", "Close the heatmap");
  make("p", { className: "path", text: pagePath }, panel);

  const periodRow = make("div", { className: "row" }, panel);
  const periodLabel = make("label", { className: "label", text: "Period" }, periodRow);
  const periodSelect = make("select", {}, periodRow);
  periodSelect.id = "period";
  periodLabel.htmlFor = "period";
  for (const item of PERIODS) {
    const option = make("option", { text: item.label }, periodSelect);
    option.value = item.value;
  }
  periodSelect.value = period;

  const deviceRow = make("div", { className: "row" }, panel);
  deviceRow.setAttribute("role", "group");
  deviceRow.setAttribute("aria-label", "Device");
  make("span", { className: "label", text: "Device" }, deviceRow).setAttribute(
    "aria-hidden",
    "true",
  );
  const deviceButtons = DEVICES.map((item) => {
    const button = make("button", { text: item.label }, deviceRow);
    button.type = "button";
    button.dataset.device = item.value;
    return button;
  });

  const status = make("p", { className: "status" }, panel);
  status.setAttribute("role", "status");
  const retry = make("button", { text: "Retry" }, panel);
  retry.type = "button";
  const totals = make("p", { className: "totals" }, panel);
  const missing = make("details", {}, panel);
  const missingSummary = make("summary", {}, missing);
  const missingList = make("ol", {}, missing);
  const note = make(
    "p",
    {
      className: "note",
      text: "Only you see this overlay, and this visit is not counted.",
    },
    panel,
  );

  const showDevice = () => {
    for (const button of deviceButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.device === device));
    }
  };
  showDevice();

  const setState = (next: OverlayState) => {
    state = next;
    const problem = next !== "loading" && next !== "ready" && next !== "empty";
    status.dataset.tone = problem ? "problem" : "";
    retry.hidden = next !== "failed";
    const ended = next === "link_expired" || next === "no_access" || next === "session_expired";
    periodRow.hidden = ended;
    deviceRow.hidden = ended;
    if (next === "ready" || next === "empty") {
      const days = PERIODS.find((item) => item.value === period)?.days ?? 30;
      const where = DEVICES.find((item) => item.value === device)?.label ?? device;
      status.textContent =
        next === "empty"
          ? `Nothing recorded for this page on ${where.toLowerCase()} in the last ${days} days.`
          : "";
      status.hidden = next === "ready";
    } else {
      status.hidden = false;
      status.textContent = MESSAGES[next];
    }
    if (next !== "ready") {
      totals.hidden = true;
      missing.hidden = true;
    }
    options.onState?.(next);
  };

  const request = async (url: string, init: RequestInit): Promise<Answer> => {
    let response: Response;
    try {
      response = await options.fetch(url, {
        ...init,
        credentials: "omit",
        cache: "no-store",
        mode: "cors",
      });
    } catch {
      // Offline, or an answer the page may not read (a site that is not the project's).
      return { status: 0, error: "" };
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const error = isRecord(body) && typeof body.error === "string" ? body.error : "";
    return response.ok
      ? { status: response.status, error, body }
      : { status: response.status, error };
  };

  /**
   * The link for a session, once: one request at a time, shared by every
   * read that needs it. What the answer means, and whether it is worth a
   * panel: only a link the server knows (used, expired, or of an account
   * without access) and a server that could not answer (Retry sends the
   * link again) are; a token the server never made, a refusal of this
   * site, and no readable answer show nothing.
   */
  const exchange = (): Promise<Exchanged> => {
    if (session !== null) return Promise.resolve({ ok: true });
    exchanging ??= (async (): Promise<Exchanged> => {
      if (link === null) return { ok: false, state: "link_expired", show: true };
      const answer = await request(`${api}session`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ token: link }),
      });
      // A session from another request meanwhile stands: a failure is not news.
      if (session !== null) return { ok: true };
      const { status: code, error } = answer;
      if (code === 429 || code >= 500) return { ok: false, state: "failed", show: true };
      // Anything else was the link's one use, or never will be.
      link = null;
      const body = answer.body;
      if (
        code === 200 &&
        isRecord(body) &&
        typeof body.token === "string" &&
        typeof body.projectId === "string" &&
        /^[0-9a-f-]{36}$/i.test(body.projectId)
      ) {
        session = { token: body.token, projectId: body.projectId };
        return { ok: true };
      }
      if (code === 200) return { ok: false, state: "failed", show: true };
      if (code === 410 && error === "link_expired") {
        return { ok: false, state: "link_expired", show: true };
      }
      if (code === 403 && error === "no_access") {
        return { ok: false, state: "no_access", show: true };
      }
      return { ok: false, state: "failed", show: false };
    })().finally(() => {
      exchanging = undefined;
    });
    return exchanging;
  };

  const load = async () => {
    const mine = (asked += 1);
    const current = () => !closed && mine === asked;
    data = null;
    found = [];
    draw();
    setState("loading");
    const exchanged = await exchange();
    if (!current()) return;
    if (!exchanged.ok || session === null) {
      setState(exchanged.ok ? "failed" : exchanged.state);
      return;
    }
    const query = new URLSearchParams({ path: pagePath, device, period });
    if (config.environment !== undefined) query.set("environment", config.environment);
    const answer = await request(
      `${api}${encodeURIComponent(session.projectId)}/heatmap?${query.toString()}`,
      { method: "GET", headers: { authorization: `Bearer ${session.token}` } },
    );
    if (!current()) return;
    if (answer.body === undefined) {
      const ended = answer.status === 401;
      const denied = answer.status === 403 || answer.status === 404;
      if (ended || denied) session = null;
      setState(ended ? "session_expired" : denied ? "no_access" : "failed");
      return;
    }
    const parsed = parseOverlay(answer.body);
    if (parsed === null) {
      setState("failed");
      return;
    }
    data = parsed;
    if (parsed.totals.pageviews === 0 && parsed.totals.clicks === 0) {
      setState("empty");
      return;
    }
    setState("ready");
    showTotals();
    resolveAll();
  };

  const showTotals = () => {
    if (data === null) return;
    const { pageviews, clicks, rageClicks } = data.totals;
    totals.textContent = [
      plural(pageviews, "pageview", "pageviews"),
      plural(clicks, "click", "clicks"),
      plural(rageClicks, "rage click", "rage clicks"),
    ].join(" · ");
    totals.hidden = false;
  };

  /** Whether a single-page app moved to another path: this heatmap is not its. */
  const away = () => win.location.pathname !== pagePath;

  /** Finds each element on the page again, and lists those not found. */
  const resolveAll = () => {
    lastResolve = Date.now();
    if (data === null || state !== "ready") return;
    if (away()) {
      status.hidden = false;
      status.textContent = `This heatmap is for ${pagePath}. Go back to that page to see it.`;
      found = [];
      draw();
      return;
    }
    status.hidden = true;
    found = [];
    const absent: OverlayElement[] = [];
    let nodes: (Element | null)[] = [];
    try {
      nodes = resolveKeys(doc, data.elements);
    } catch {
      nodes = [];
    }
    for (const [index, item] of data.elements.entries()) {
      const node = nodes[index] ?? null;
      if (node === null || host.contains(node)) absent.push(item);
      else found.push({ item, node });
    }
    missing.hidden = absent.length === 0;
    missingSummary.textContent = `Not on this page (${formatWhole(absent.length)})`;
    const items = absent.slice(0, MAX_LISTED).map((item) => {
      const entry = doc.createElement("li");
      const name = make("span", { className: "name", text: elementName(item) }, entry);
      name.title = item.label === null ? item.element : `${item.label}: ${item.element}`;
      entry.append(`: ${plural(item.clicks, "click", "clicks")}`);
      return entry;
    });
    if (absent.length > MAX_LISTED) {
      const more = doc.createElement("li");
      more.textContent = `and ${formatWhole(absent.length - MAX_LISTED)} more`;
      items.push(more);
    }
    missingList.replaceChildren(...items);
    draw();
  };

  /** Draws the dots and the scroll bands for the page as it is now. */
  function draw() {
    if (context === null) return;
    const width = doc.documentElement.clientWidth || win.innerWidth;
    const height = doc.documentElement.clientHeight || win.innerHeight;
    const ratio = win.devicePixelRatio || 1;
    if (
      canvas.width !== Math.round(width * ratio) ||
      canvas.height !== Math.round(height * ratio)
    ) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    if (data === null || state !== "ready" || away()) return;

    // Clicks: a dot per cell with clicks, larger and hotter for more.
    let most = 1;
    for (const { item } of found) for (const cell of item.cells) most = Math.max(most, cell[2]);
    for (const { item, node } of found) {
      if (!node.isConnected) continue;
      const box = node.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) continue;
      if (box.bottom < 0 || box.top > height || box.right < 0 || box.left > width) continue;
      context.lineWidth = 1;
      context.strokeStyle =
        item.rageClicks > 0 ? "rgba(220, 38, 38, 0.9)" : "rgba(37, 99, 235, 0.6)";
      context.strokeRect(box.left + 0.5, box.top + 0.5, box.width - 1, box.height - 1);
      for (const [column, row, clicks] of item.cells) {
        const heat = clicks / most;
        const x = box.left + ((column + 0.5) / GRID) * box.width;
        const y = box.top + ((row + 0.5) / GRID) * box.height;
        const radius = 5 + 15 * Math.sqrt(heat);
        const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
        const hue = Math.round(220 - 220 * heat);
        gradient.addColorStop(0, `hsla(${hue}, 95%, 50%, 0.85)`);
        gradient.addColorStop(1, `hsla(${hue}, 95%, 50%, 0)`);
        context.fillStyle = gradient;
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fill();
      }
      // The element's clicks, as text drawn on the canvas.
      const label =
        item.rageClicks > 0
          ? `${formatWhole(item.clicks)} · ${formatWhole(item.rageClicks)} rage`
          : formatWhole(item.clicks);
      context.font = "600 11px system-ui, sans-serif";
      const labelWidth = context.measureText(label).width + 8;
      const labelX = Math.max(0, Math.min(box.left, width - labelWidth));
      const labelY = Math.max(0, box.top - 16);
      context.fillStyle =
        item.rageClicks > 0 ? "rgba(185, 28, 28, 0.95)" : "rgba(24, 24, 27, 0.85)";
      context.fillRect(labelX, labelY, labelWidth, 16);
      context.fillStyle = "#fff";
      context.textBaseline = "middle";
      context.fillText(label, labelX + 4, labelY + 8);
    }

    // Scroll reach: a band at the right edge, each 5% of the page shaded
    // by the share of pageviews that reached it, with its share every 25%.
    const pageHeight = Math.max(
      doc.documentElement.scrollHeight,
      doc.body?.scrollHeight ?? 0,
      height,
    );
    const bandWidth = 14;
    let previous = 0;
    for (const step of data.reach) {
      const top = (previous / 100) * pageHeight - win.scrollY;
      const bottom = (step.depth / 100) * pageHeight - win.scrollY;
      previous = step.depth;
      if (bottom < 0 || top > height) continue;
      context.fillStyle = `hsla(${Math.round(220 * (1 - step.share))}, 85%, 45%, ${0.25 + 0.6 * step.share})`;
      context.fillRect(width - bandWidth, top, bandWidth, bottom - top);
      if (step.depth % 25 === 0) {
        const reached = `${Math.round(step.share * 100)}% reached`;
        context.font = "600 11px system-ui, sans-serif";
        const textWidth = context.measureText(reached).width + 8;
        const y = Math.min(Math.max(bottom - 16, 0), height - 16);
        context.fillStyle = "rgba(24, 24, 27, 0.85)";
        context.fillRect(width - bandWidth - textWidth - 2, y, textWidth, 16);
        context.fillStyle = "#fff";
        context.textBaseline = "middle";
        context.fillText(reached, width - bandWidth - textWidth + 2, y + 8);
      }
    }
  }

  const scheduleDraw = () => {
    if (frame !== undefined || closed) return;
    frame = win.requestAnimationFrame(() => {
      frame = undefined;
      try {
        draw();
      } catch {
        // Never break the page.
      }
    });
  };

  /** DOM changes: find the elements again, at most every RESOLVE_EVERY_MS. */
  const scheduleResolve = () => {
    if (resolveTimer !== undefined || closed) return;
    const wait = Math.max(0, lastResolve + RESOLVE_EVERY_MS - Date.now());
    resolveTimer = setTimeout(() => {
      resolveTimer = undefined;
      try {
        resolveAll();
      } catch {
        // Never break the page.
      }
    }, wait);
  };

  const observer =
    typeof MutationObserver === "function" ? new MutationObserver(scheduleResolve) : null;
  const resized =
    typeof ResizeObserver === "function" ? new ResizeObserver(() => scheduleDraw()) : null;
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") stop();
  };

  function stop() {
    if (closed) return;
    closed = true;
    session = null;
    link = null;
    data = null;
    observer?.disconnect();
    resized?.disconnect();
    win.removeEventListener("scroll", scheduleDraw, { capture: true });
    win.removeEventListener("resize", scheduleDraw);
    if (frame !== undefined) win.cancelAnimationFrame(frame);
    if (resolveTimer !== undefined) clearTimeout(resolveTimer);
    host.remove();
  }

  close.addEventListener("click", stop);
  panel.addEventListener("keydown", onKey);
  retry.addEventListener("click", () => void load());
  periodSelect.addEventListener("change", () => {
    const next = PERIODS.find((item) => item.value === periodSelect.value);
    if (next === undefined) return;
    period = next.value;
    void load();
  });
  for (const button of deviceButtons) {
    button.addEventListener("click", () => {
      const next = DEVICES.find((item) => item.value === button.dataset.device);
      if (next === undefined || next.value === device) return;
      device = next.value;
      showDevice();
      void load();
    });
  }

  const reveal = () => {
    doc.documentElement.append(host);
    // Scrolling anywhere, a scrolling box inside the page too, moves elements.
    win.addEventListener("scroll", scheduleDraw, { capture: true, passive: true });
    win.addEventListener("resize", scheduleDraw, { passive: true });
    // Elements come and go, or are named: keys may find others. Layout
    // alone only moves them, which the redraw follows.
    observer?.observe(doc.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [NAME_ATTRIBUTE],
    });
    if (doc.body !== null) resized?.observe(doc.body);
  };

  // Nothing shows until the server has answered about the link: a made-up
  // token shows nothing, and the tracker records the page load.
  void (async () => {
    let shown = false;
    try {
      const exchanged = await exchange();
      shown = exchanged.ok;
      if (closed) return;
      if (exchanged.ok) {
        reveal();
        void load();
      } else if (exchanged.show) {
        // A link refused: the tracker records this visit.
        note.hidden = true;
        setState(exchanged.state);
        reveal();
      } else {
        stop();
      }
    } finally {
      settled(shown);
    }
  })();

  return {
    /** Removes the overlay and forgets its tokens. */
    close: stop,
    /** For tests. */
    state: () => state,
    redraw: () => resolveAll(),
  };
}
