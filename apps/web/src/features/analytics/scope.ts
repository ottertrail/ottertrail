import type { VariantProps } from "class-variance-authority";
import * as React from "react";

import type { buttonVariants } from "@/components/ui/button";
import type { ListReport } from "@/lib/analytics-api";
import type { Analytics } from "@/lib/analytics-api";
import type { ReportSource } from "@/lib/analytics-queries";

import type { DayChartMarks } from "./day-chart";
import type { OtherPageSearch, PageSearch } from "./list-rows";

/*
 * Where the Web analytics page runs: in the signed-in dashboard, or on a
 * shared link (docs/web-analytics.md, "Shared links"). The page, its
 * lists, and its dialogs read the scope, so the same components serve
 * both, and a list added to the page shows on shared links too. The page
 * itself imports neither the router nor the access checks: the dashboard's
 * scope brings them (dashboard-analytics-page.tsx), and a shared link's
 * page loads without them (src/share/).
 */

export interface PageLinkProps {
  /** The page's address to open: its period, filters, environment, and goal. */
  search: PageSearch;
  className?: string | undefined;
  "aria-label"?: string | undefined;
  onClick?: (() => void) | undefined;
  /** Drawn as a button, with these styles. */
  button?: VariantProps<typeof buttonVariants> | undefined;
  children: React.ReactNode;
}

/** The chart's notes and releases, with their controls and their column in the table. */
export interface TrendMarks {
  controls: React.ReactNode;
  chart: DayChartMarks | undefined;
  /** null when no mark is shown in the range. */
  column: { heading: string; cell: (index: number) => React.ReactNode } | null;
}

/** What only the signed-in dashboard has: links to its other pages, and what the user may do. */
export interface DashboardExtras {
  projectId: string;
  /** When the project's first event arrived: null before it; undefined while unknown. */
  lastEventAt: string | null | undefined;
  /** Product analytics at view: the Goals table and saved goals. */
  showGoals: boolean;
  /** Product analytics at manage: adding and deleting goals, and the chart's notes. */
  canManageGoals: boolean;
  /** The project's settings: installing the snippet. */
  canInstall: boolean;
  /** The project's settings page, where the snippet is. */
  installLink: React.ReactNode;
  /** A page's heatmap, at the end of its row. */
  renderHeatmapLink: (search: OtherPageSearch, path: string) => React.ReactNode;
  /**
   * Show all's Download CSV for a list, with the search typed (csv-export.tsx),
   * passed in so a shared link's page never loads the export's code.
   */
  renderListDownload: (props: {
    search: PageSearch;
    report: ListReport;
    text: string;
    title: string;
  }) => React.ReactNode;
  /** A custom event's own page, at the end of its row; null without product analytics. */
  renderEventLink: ((search: OtherPageSearch, name: string) => React.ReactNode) | null;
  /** The filter bar's Segments menu (segments-menu.tsx). */
  renderSegments: (search: PageSearch) => React.ReactNode;
  /** The chart's notes and releases, handed to `children` (chart-marks.tsx). */
  ChartMarks: React.ComponentType<{
    analytics: Analytics;
    children: (marks: TrendMarks) => React.ReactNode;
  }>;
}

export interface AnalyticsScope {
  /** Where the reports are read. */
  source: ReportSource;
  /** A link to the page with another address (PageLink in filter-link.tsx draws it). */
  renderLink: (props: PageLinkProps) => React.ReactNode;
  /** Opens the page with another address. */
  show: (search: PageSearch) => void;
  /** What shows when the API answers 404: an unknown project, or a link that no longer works. */
  notFound: React.ReactNode;
  /** Drawn into the page's title row, for the page's address: the live count, and Export. */
  renderHeaderActions: (search: PageSearch) => React.ReactNode;
  /** The dashboard's extras; null on a shared link. */
  dashboard: DashboardExtras | null;
}

/** Provide it around the page: `<AnalyticsScopeContext value={scope}>`. */
export const AnalyticsScopeContext = React.createContext<AnalyticsScope | null>(null);

export function useAnalyticsScope(): AnalyticsScope {
  const scope = React.use(AnalyticsScopeContext);
  if (scope === null) {
    throw new Error("The Web analytics page needs an AnalyticsScopeContext");
  }
  return scope;
}
