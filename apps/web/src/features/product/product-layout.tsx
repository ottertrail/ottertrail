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
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <nav aria-label="Product analytics reports" className={cn(tabsListVariants(), "h-8")}>
        {TABS.map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
            params={{ projectId }}
            search={kept}
            className="inline-flex h-full items-center rounded-md border border-transparent px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring data-[status=active]:border-hairline-strong data-[status=active]:bg-input-fill/30 data-[status=active]:text-foreground"
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
