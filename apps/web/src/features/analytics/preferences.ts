import type { Period } from "@/lib/analytics-api";

export const DEFAULT_PERIOD: Period = "7d";

const LAST_PROJECT_KEY = "ottertrail.analytics.project";

/** The project the analytics page showed last in this browser, if storage allows. */
export function lastAnalyticsProject(): string | null {
  try {
    return window.localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    return null;
  }
}

export function rememberAnalyticsProject(projectId: string) {
  try {
    window.localStorage.setItem(LAST_PROJECT_KEY, projectId);
  } catch {
    // Storage can be off or full; the page then opens the first project.
  }
}
