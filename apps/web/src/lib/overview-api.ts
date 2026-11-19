import { keepPreviousData, queryOptions } from "@tanstack/react-query";

import type { Area } from "./access";
import { DEFAULT_ENVIRONMENT } from "./analytics-api";
import { apiRequest, expectShape } from "./api";
import { type GoalStep, isGoalStep } from "./goals-api";
import { type CheckCause, isCheckCause } from "./uptime-api";

/**
 * The project overview (docs/dashboard.md, "Overview"): each user's own
 * layout, and each widget's numbers from a route of its own, which needs
 * the widget's area (apps/api/src/overview/). The widgets and their areas
 * match the API's WIDGETS.
 */

export const WIDGETS = [
  { id: "attention", area: "uptime_alerts", title: "Needs attention now" },
  { id: "errors", area: "errors", title: "New and returning errors" },
  { id: "uptime", area: "uptime_alerts", title: "Uptime and response time" },
  { id: "services", area: "monitoring", title: "Server requests, failures and p95" },
  { id: "speed", area: "web_analytics", title: "Page speed" },
  { id: "main-goal", area: "product_analytics", title: "Main goal" },
  { id: "traffic", area: "web_analytics", title: "Traffic" },
  { id: "goals", area: "product_analytics", title: "Goals and conversion" },
  { id: "users", area: "product_analytics", title: "Signed-in users" },
  { id: "sources", area: "web_analytics", title: "Top sources and pages" },
] as const satisfies readonly { id: string; area: Area; title: string }[];

export type WidgetId = (typeof WIDGETS)[number]["id"];

export const widgetTitle = (id: WidgetId) =>
  WIDGETS.find((widget) => widget.id === id)?.title ?? id;

const isWidgetId = (value: unknown): value is WidgetId =>
  WIDGETS.some((widget) => widget.id === value);

/** The overview's periods. */
export const OVERVIEW_PERIODS = [
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
] as const;
export type OverviewPeriod = (typeof OVERVIEW_PERIODS)[number]["value"];
export const DEFAULT_OVERVIEW_PERIOD: OverviewPeriod = "7d";
export const isOverviewPeriod = (value: unknown): value is OverviewPeriod =>
  OVERVIEW_PERIODS.some((period) => period.value === value);

export interface Layout {
  /** The widgets the user may see, in their order. */
  widgets: { id: WidgetId; hidden: boolean }[];
  isDefault: boolean;
}

/** The days a widget counts and those it compares with: every widget's answer starts with them. */
export interface WidgetHeader {
  timeZone: string;
  environment: string;
  firstDay: string;
  lastDay: string;
  previous: { firstDay: string; lastDay: string };
}

export interface AttentionWidget extends WidgetHeader {
  alerts: {
    ruleId: string;
    ruleName: string;
    kind: string;
    subjectName: string;
    since: string;
    message: string;
  }[];
  down: {
    checkId: string;
    name: string;
    url: string;
    since: string | null;
    cause: CheckCause | null;
    statusCode: number | null;
  }[];
  certificates: {
    checkId: string;
    name: string;
    url: string;
    expiresAt: string;
    /** Already past its date. */
    expired: boolean;
  }[];
  checks: { total: number; up: number; paused: number };
  rules: number;
}

export interface ErrorsWidget extends WidgetHeader {
  received: boolean;
  occurrences: number;
  previousOccurrences: number;
  newGroups: number;
  regressedGroups: number;
  unresolvedGroups: number;
  top: {
    fingerprint: string;
    type: string;
    message: string;
    occurrences: number;
    users: number;
    visitors: number;
    status: "unresolved" | "regressed";
    isNew: boolean;
  }[];
  truncated: boolean;
}

export interface UptimeWidget extends WidgetHeader {
  checks: {
    id: string;
    name: string;
    url: string;
    state: "pending" | "up" | "down";
    paused: boolean;
    uptime: number | null;
    previousUptime: number | null;
    incidents: number;
    lastResponseMs: number | null;
  }[];
}

interface ServiceFigures {
  requests: number;
  failed: number;
  p95Us: number | null;
}

export interface ServicesWidget extends WidgetHeader {
  services: (ServiceFigures & { service: string; previous: ServiceFigures })[];
  more: boolean;
  received: boolean;
}

export interface SpeedDevice {
  deviceType: string | null;
  loads: number;
  lcp: number | null;
  inp: number | null;
  cls: number | null;
}

export interface SpeedWidget extends WidgetHeader {
  thresholds: Record<"lcp" | "inp" | "cls", [number, number]>;
  devices: SpeedDevice[];
  received: boolean;
}

interface Traffic {
  visitors: number;
  visits: number;
  pageviews: number;
}

export interface TrafficWidget extends WidgetHeader {
  received: boolean;
  summary: Traffic;
  previousSummary: Traffic;
  days: { day: string; visitors: number }[];
}

interface GoalFigures {
  visitors: number;
  events: number;
  conversionRate: number;
}

export interface OverviewGoal extends GoalFigures {
  id: string;
  name: string;
  step: GoalStep;
  previous: GoalFigures;
}

export interface GoalsWidget extends WidgetHeader {
  mainGoalId: string | null;
  visitors: number;
  previousVisitors: number;
  goals: OverviewGoal[];
}

export type MainGoalWidget = WidgetHeader &
  (
    | { kind: "goal"; visitors: number; previousVisitors: number; goal: OverviewGoal }
    | { kind: "new_users"; newUsers: number; previousNewUsers: number; received: boolean }
  );

/** A cohort's users active a later week; `current` while that week is still running. */
export interface Retained {
  users: number;
  current: boolean;
}

export interface UsersWidget extends WidgetHeader {
  active: number;
  new: number;
  /** In the period before. */
  previousActive: number;
  previousNew: number;
  /** null for a week that has not begun. */
  cohorts: { week: string; users: number; week1: Retained | null; week4: Retained | null }[];
  currentWeek: string;
  received: boolean;
  /** null without the users area. */
  newest: { userId: string; firstSeenAt: string }[] | null;
}

export interface SourcesWidget extends WidgetHeader {
  sources: { value: string | null; visitors: number }[];
  pages: { path: string; visitors: number }[];
}

export interface WidgetData {
  attention: AttentionWidget;
  errors: ErrorsWidget;
  uptime: UptimeWidget;
  services: ServicesWidget;
  speed: SpeedWidget;
  "main-goal": MainGoalWidget;
  traffic: TrafficWidget;
  goals: GoalsWidget;
  users: UsersWidget;
  sources: SourcesWidget;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number";
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isTextOrNull = (value: unknown) => value === null || isText(value);
const isNumberOrNull = (value: unknown) => value === null || isNumber(value);
const isListOf = <T>(value: unknown, isItem: (item: unknown) => item is T): value is T[] =>
  Array.isArray(value) && value.every(isItem);
/** Every key of `shape` holds a value its check accepts. */
const has = (value: unknown, shape: Record<string, (item: unknown) => boolean>) =>
  isRecord(value) && Object.entries(shape).every(([key, check]) => check(value[key]));

const isHeader = (value: unknown) =>
  has(value, {
    timeZone: isText,
    environment: isText,
    firstDay: isText,
    lastDay: isText,
    previous: (item) => has(item, { firstDay: isText, lastDay: isText }),
  });

const isRetained = (value: unknown) =>
  value === null || has(value, { users: isNumber, current: isBoolean });
const isPair = (value: unknown) =>
  Array.isArray(value) && value.length === 2 && value.every(isNumber);
const isGoalFigures = (value: unknown) =>
  has(value, { visitors: isNumber, events: isNumber, conversionRate: isNumber });
const isOverviewGoal = (value: unknown): value is OverviewGoal =>
  isGoalFigures(value) &&
  has(value, { id: isText, name: isText, step: isGoalStep, previous: isGoalFigures });
const isServiceFigures = (value: unknown) =>
  has(value, { requests: isNumber, failed: isNumber, p95Us: isNumberOrNull });

const SHAPES: { [K in WidgetId]: (value: unknown) => boolean } = {
  attention: (value) =>
    has(value, {
      alerts: (list) =>
        isListOf(list, (item): item is AttentionWidget["alerts"][number] =>
          has(item, {
            ruleId: isText,
            ruleName: isText,
            kind: isText,
            subjectName: isText,
            since: isText,
            message: isText,
          }),
        ),
      down: (list) =>
        isListOf(list, (item): item is AttentionWidget["down"][number] =>
          has(item, {
            checkId: isText,
            name: isText,
            url: isText,
            since: isTextOrNull,
            cause: (cause) => cause === null || isCheckCause(cause),
            statusCode: isNumberOrNull,
          }),
        ),
      certificates: (list) =>
        isListOf(list, (item): item is AttentionWidget["certificates"][number] =>
          has(item, {
            checkId: isText,
            name: isText,
            url: isText,
            expiresAt: isText,
            expired: isBoolean,
          }),
        ),
      checks: (item) => has(item, { total: isNumber, up: isNumber, paused: isNumber }),
      rules: isNumber,
    }),
  errors: (value) =>
    has(value, {
      received: isBoolean,
      occurrences: isNumber,
      previousOccurrences: isNumber,
      newGroups: isNumber,
      regressedGroups: isNumber,
      unresolvedGroups: isNumber,
      truncated: isBoolean,
      top: (list) =>
        isListOf(list, (item): item is ErrorsWidget["top"][number] =>
          has(item, {
            fingerprint: isText,
            type: isText,
            message: isText,
            occurrences: isNumber,
            users: isNumber,
            visitors: isNumber,
            status: (status) => status === "unresolved" || status === "regressed",
            isNew: isBoolean,
          }),
        ),
    }),
  uptime: (value) =>
    has(value, {
      checks: (list) =>
        isListOf(list, (item): item is UptimeWidget["checks"][number] =>
          has(item, {
            id: isText,
            name: isText,
            url: isText,
            state: (state) => state === "pending" || state === "up" || state === "down",
            paused: isBoolean,
            uptime: isNumberOrNull,
            previousUptime: isNumberOrNull,
            incidents: isNumber,
            lastResponseMs: isNumberOrNull,
          }),
        ),
    }),
  services: (value) =>
    has(value, {
      more: isBoolean,
      received: isBoolean,
      services: (list) =>
        isListOf(
          list,
          (item): item is ServicesWidget["services"][number] =>
            isServiceFigures(item) && has(item, { service: isText, previous: isServiceFigures }),
        ),
    }),
  speed: (value) =>
    has(value, {
      received: isBoolean,
      thresholds: (item) => has(item, { lcp: isPair, inp: isPair, cls: isPair }),
      devices: (list) =>
        isListOf(list, (item): item is SpeedDevice =>
          has(item, {
            deviceType: isTextOrNull,
            loads: isNumber,
            lcp: isNumberOrNull,
            inp: isNumberOrNull,
            cls: isNumberOrNull,
          }),
        ),
    }),
  "main-goal": (value) =>
    (has(value, { kind: (kind) => kind === "goal" }) &&
      has(value, { visitors: isNumber, previousVisitors: isNumber, goal: isOverviewGoal })) ||
    (has(value, { kind: (kind) => kind === "new_users" }) &&
      has(value, { newUsers: isNumber, previousNewUsers: isNumber, received: isBoolean })),
  traffic: (value) => {
    const isTraffic = (item: unknown) =>
      has(item, { visitors: isNumber, visits: isNumber, pageviews: isNumber });
    return has(value, {
      received: isBoolean,
      summary: isTraffic,
      previousSummary: isTraffic,
      days: (list) =>
        isListOf(list, (item): item is TrafficWidget["days"][number] =>
          has(item, { day: isText, visitors: isNumber }),
        ),
    });
  },
  goals: (value) =>
    has(value, {
      mainGoalId: isTextOrNull,
      visitors: isNumber,
      previousVisitors: isNumber,
      goals: (list) => isListOf(list, isOverviewGoal),
    }),
  users: (value) =>
    has(value, {
      active: isNumber,
      new: isNumber,
      previousActive: isNumber,
      previousNew: isNumber,
      currentWeek: isText,
      received: isBoolean,
      cohorts: (list) =>
        isListOf(list, (item): item is UsersWidget["cohorts"][number] =>
          has(item, { week: isText, users: isNumber, week1: isRetained, week4: isRetained }),
        ),
      newest: (list) =>
        list === null ||
        isListOf(list, (item): item is { userId: string; firstSeenAt: string } =>
          has(item, { userId: isText, firstSeenAt: isText }),
        ),
    }),
  sources: (value) =>
    has(value, {
      sources: (list) =>
        isListOf(list, (item): item is SourcesWidget["sources"][number] =>
          has(item, { value: isTextOrNull, visitors: isNumber }),
        ),
      pages: (list) =>
        isListOf(list, (item): item is SourcesWidget["pages"][number] =>
          has(item, { path: isText, visitors: isNumber }),
        ),
    }),
};

/**
 * The layout as the API sent it, with any widget this dashboard does not
 * know left out (an API newer than the page): the others still show.
 */
const layoutOf = (value: unknown): Layout => {
  const body = expectShape(value, (item): item is { isDefault: boolean; widgets: unknown[] } =>
    has(item, { isDefault: isBoolean, widgets: Array.isArray }),
  );
  return {
    isDefault: body.isDefault,
    widgets: body.widgets.filter((item): item is Layout["widgets"][number] =>
      has(item, { id: isWidgetId, hidden: isBoolean }),
    ),
  };
};

const overviewPath = (projectId: string, path: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/overview/${path}`;

export const layoutQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["overview-layout", projectId],
    queryFn: async ({ signal }) =>
      layoutOf(await apiRequest(overviewPath(projectId, "layout"), { signal })),
  });

/** Saves the user's layout: every widget they see, in order, and those hidden. */
export async function saveLayout(
  projectId: string,
  layout: { order: WidgetId[]; hidden: WidgetId[] },
): Promise<Layout> {
  return layoutOf(
    await apiRequest(overviewPath(projectId, "layout"), { method: "PUT", body: layout }),
  );
}

/** Back to the default layout. */
export async function resetLayout(projectId: string): Promise<Layout> {
  return layoutOf(await apiRequest(overviewPath(projectId, "layout"), { method: "DELETE" }));
}

export const widgetQuery = <K extends WidgetId>(
  projectId: string,
  id: K,
  period: OverviewPeriod,
  environment: string,
) =>
  queryOptions({
    queryKey: ["overview", projectId, id, period, environment],
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({
        period,
        ...(environment === DEFAULT_ENVIRONMENT ? {} : { environment }),
      });
      const body = await apiRequest(overviewPath(projectId, `${id}?${query.toString()}`), {
        signal,
      });
      return expectShape(
        body,
        (value): value is WidgetData[K] => isHeader(value) && SHAPES[id](value),
      );
    },
    // While another period loads, keep showing this one.
    placeholderData: keepPreviousData,
  });
