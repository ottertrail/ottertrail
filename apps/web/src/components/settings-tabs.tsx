import { cn } from "cn";
import type * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UnsavedChangesGuard } from "@/components/unsaved-changes-guard";
import { useSearchParam } from "@/hooks/use-search-param";

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
           * content below it.
           */}
          <TabsList variant="line" aria-label={label} className="-ms-3 h-10 p-0">
            {tabs.map((tab) => (
              <TabsTrigger
                key={tab.value}
                value={tab.value}
                className="h-10 flex-none px-3 after:bg-primary"
              >
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
