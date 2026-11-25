import { ChevronRightIcon } from "lucide-react";

import { ChangedValue } from "@/components/changed-value";

import { formatWhole, relativeChange } from "../analytics/format";
import { MIN_LOADS_FOR_CHANGE } from "../overview/format";

/** A count with its change from the period before, hidden while both are under 20. */
export function CountChange({ now, before }: { now: number; before: number }) {
  return (
    <ChangedValue
      value={formatWhole(now)}
      change={relativeChange(now, before)}
      counts={{ current: now, previous: before }}
      min={MIN_LOADS_FOR_CHANGE}
      before={formatWhole(before)}
    />
  );
}

/**
 * What the Events pages count (docs/product-analytics.md, "Events"), folded
 * as the Funnel tab's notes are. `list` adds what only the list needs.
 */
export function EventNotes({ list = false }: { list?: boolean }) {
  return (
    <details className="group border-t pt-5">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-ink [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          aria-hidden="true"
          className="size-4 text-ink-subtle transition-transform group-open:rotate-90 motion-reduce:transition-none"
        />
        How events are counted
      </summary>
      <ul className="mt-2 flex max-w-prose list-disc flex-col gap-1 pl-5 text-xs text-pretty text-ink-subtle">
        {list && (
          <li>
            The events your site sends with <code className="font-mono">track()</code> or from its
            server, the 100 most frequent. Pageviews, errors, and Web Vitals are not listed.
          </li>
        )}
        <li>
          Visitors are daily visitor IDs: one browser counts once a day. Events from a server have
          none.
        </li>
        <li>Users are your site's IDs for signed-in users, from events sent while signed in.</li>
        <li>
          Changes compare with the same number of days just before, up to the same time of day while
          the period runs. Under 20 in both periods, no change shows.
        </li>
        {!list && (
          <li>
            Property values compare as text. Numbers, true, false, and null use their JSON text.
          </li>
        )}
      </ul>
    </details>
  );
}
