import { Link, Outlet, useSearch } from "@tanstack/react-router";

import { tabsListVariants } from "@/components/ui/tabs";
import { environmentFrom, rangeFrom } from "@/lib/analytics-api";
import { cn } from "@/lib/utils";

import { productSearchOf } from "./search";

const TABS = [
  { to: "/projects/$projectId/product/events", label: "Events" },
  { to: "/projects/$projectId/product/funnel", label: "Funnel" },
  { to: "/projects/$projectId/product/retention", label: "Retention" },
  { to: "/projects/$projectId/product/active-users", label: "Active users" },
] as const;

/** Keep period and environment across reports; steps and property filters stay with their page. */
export function ProductLayout({ projectId }: { projectId: string }) {
  const search: Record<string, unknown> = useSearch({ strict: false });
  const kept = productSearchOf({
    range: rangeFrom(search),
    environment: environmentFrom(search.env),
  });
  return (
    <div className="flex flex-col">
      {/* Draw focus rings inward to avoid clipping in the scrolling link row. Offset by px-3 to align the first label with the report. */}
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
