import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";

import { ButtonLink } from "@/components/button-link";
import { DEFAULT_ENVIRONMENT } from "@/lib/analytics-api";
import { nowQuery } from "@/lib/now-api";

import { formatWhole } from "./format";

/** "3 visitors now", "1 visitor now", "No visitors now". */
const visitorsNowText = (visitors: number) =>
  visitors === 0
    ? "No visitors now"
    : `${formatWhole(visitors)} ${visitors === 1 ? "visitor" : "visitors"} now`;

/**
 * A dot, green while someone is there, before the count. Its pulse is an
 * opacity change, and only for those who allow motion.
 */
export function LiveDot({ live }: { live: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-slot="live-dot"
      data-live={live}
      className={cn(
        "size-2 shrink-0 rounded-full",
        live ? "bg-status-good motion-safe:animate-pulse" : "bg-ink-subtle",
      )}
    />
  );
}

/**
 * The Web analytics page's live count, in its title row: a link to the
 * Right now view. Nothing shows until the first answer, so a failed poll
 * never takes the page's place.
 */
export function NowIndicator({
  projectId,
  environment,
}: {
  projectId: string;
  environment: string;
}) {
  const now = useQuery(nowQuery(projectId, environment));
  if (now.data === undefined) return null;
  const { visitors } = now.data;
  return (
    <ButtonLink
      variant="outline"
      to="/projects/$projectId/web-analytics/now"
      params={{ projectId }}
      search={environment === DEFAULT_ENVIRONMENT ? {} : { env: environment }}
      data-slot="now-indicator"
      className="gap-2 tabular-nums"
    >
      <LiveDot live={visitors > 0} />
      {visitorsNowText(visitors)}
    </ButtonLink>
  );
}
