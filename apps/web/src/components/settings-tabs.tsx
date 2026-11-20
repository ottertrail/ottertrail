import { cn } from "cn";
import type * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UnsavedChangesGuard } from "@/components/unsaved-changes-guard";
import { useSearchParam } from "@/hooks/use-search-param";

/** The tab row's list: 40px high, starting a tab's padding to the left. */
const LINE_TABS_LIST = "-ms-3 p-0 group-data-horizontal/tabs:h-10";
/** A tab as tall as the row, its underline on the row's bottom edge. */
const LINE_TAB = "h-10 flex-none px-3 after:bg-primary group-data-horizontal/tabs:after:bottom-0";

export interface SettingsTab {
  /** In the address: `?tab=<value>`. The first tab is the default and is left out. */
  value: string;
  label: string;
  /** Marks the tab while a form in it has unsaved changes. */
  dirty?: boolean;
  content: React.ReactNode;
}

/**
 * A settings page's sections as tabs (project Settings, instance Settings,
 * Members), the chosen one in the address so it can be linked and
 * reloaded. Every tab stays mounted, so edits in one survive a visit to
 * another, and leaving the page with unsaved edits in any of them asks
 * first (`UnsavedChangesGuard`). Under 40rem the tab row scrolls sideways
 * rather than wrapping.
 */
export function SettingsTabs({
  tabs,
  label,
  param = "tab",
  className,
}: {
  tabs: SettingsTab[];
  /** Names the tab list for screen readers: "Project settings". */
  label: string;
  param?: string;
  className?: string;
}) {
  const [chosen, setChosen] = useSearchParam(param);
  const first = tabs[0]?.value;
  const value = tabs.some((tab) => tab.value === chosen) ? chosen : first;
  return (
    <UnsavedChangesGuard>
      <Tabs
        value={value}
        onValueChange={(next) => {
          if (typeof next === "string") setChosen(next === first ? undefined : next);
        }}
        className={cn("gap-0", className)}
      >
        <div className="overflow-x-auto border-b px-gutter">
          {/*
           * The list starts a tab's padding (px-3) to the left, and without
           * the list's own 3px, so the first tab's label lines up with the
           * content below it. Its height and the underline are set on the
           * selectors ui/tabs.tsx uses (a plain h-10 loses to its h-8), and the
           * underline sits inside the tab: below it, the row would scroll.
           */}
          <TabsList variant="line" aria-label={label} className={LINE_TABS_LIST}>
            {tabs.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value} className={LINE_TAB}>
                {tab.label}
                {tab.dirty === true && (
                  <>
                    <Badge
                      variant="outline"
                      aria-hidden="true"
                      className="font-normal text-warning"
                    >
                      Unsaved
                    </Badge>
                    <span className="sr-only">, unsaved changes</span>
                  </>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {tabs.map((tab) => (
          <TabsContent key={tab.value} value={tab.value} keepMounted className="px-gutter">
            {tab.content}
          </TabsContent>
        ))}
      </Tabs>
    </UnsavedChangesGuard>
  );
}
