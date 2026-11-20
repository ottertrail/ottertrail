import { Link, Outlet, useSearch } from "@tanstack/react-router";

import { tabsListVariants } from "@/components/ui/tabs";
import { environmentFrom, rangeFrom } from "@/lib/analytics-api";
import { cn } from "@/lib/utils";

import { productSearchOf } from "./search";

const TABS = [
  { to: "/projects/$projectId/product/events", label: "Events" },
  { to: "/projects/$projectId/product/funnel", label: "Funnel" },
  { to: "/projects/$projectId/product/retention", label: "Retention" },
] as const;

/**
 * Product analytics: its reports as tabs. Each tab is its own page and
 * link, and keeps the period and environment; a funnel's steps and an
 * event's filters belong to their own page.
 */
export function ProductLayout({ projectId }: { projectId: string }) {
  const search: Record<string, unknown> = useSearch({ strict: false });
  const kept = productSearchOf({
    range: rangeFrom(search),
    environment: environmentFrom(search.env),
  });
  return (
    <div className="flex flex-col">
      {/*
       * Links, not tabs: each report is a page of its own, at its own address.
       * They take the look of shadcn's line tabs (TabsList variant="line"),
       * and the global focus ring, drawn inward: the row scrolls, so it would
       * clip a ring drawn outside. The row starts a link's padding (px-3)
       * to the left, so the first label lines up with the report below.
       */}
      <nav aria-label="Product analytics reports" className="overflow-x-auto border-b px-gutter">
        <div className={cn(tabsListVariants({ variant: "line" }), "-ms-3 h-10 p-0")}>
          {TABS.map((tab) => (
            <Link
              key={tab.to}
              to={tab.to}
              params={{ projectId }}
              search={kept}
              className="relative inline-flex h-10 flex-none items-center rounded-md px-3 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-primary after:opacity-0 after:transition-opacity hover:text-foreground focus-visible:-outline-offset-2 data-[status=active]:text-foreground data-[status=active]:after:opacity-100"
            >
              {tab.label}
            </Link>
          ))}
        </div>
      </nav>
      <Outlet />
    </div>
  );
}
