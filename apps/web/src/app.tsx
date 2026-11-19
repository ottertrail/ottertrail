import { Outlet, useMatches, useParams, useRouter } from "@tanstack/react-router";
import * as React from "react";

import { AppHeader } from "@/components/app-shell/app-header";
import { AppSidebar } from "@/components/app-shell/app-sidebar";
import { SidebarInset, SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { rememberSidebar, sidebarOpen } from "@/lib/sidebar-state";

/** Under 60rem the sidebar is a sheet: a link chosen in it closes it, as the page changes. */
function CloseMenuOnNavigation() {
  const router = useRouter();
  const { setOpenMobile } = useSidebar();
  React.useEffect(
    () => router.subscribe("onResolved", () => setOpenMobile(false)),
    [router, setOpenMobile],
  );
  return null;
}

/** The signed-in dashboard: sidebar, header, and the current page. */
export function AppLayout() {
  const matches = useMatches();
  const { projectId } = useParams({ strict: false });
  const title = matches.findLast((match) => match.staticData.title !== undefined)?.staticData.title;
  // Expanded unless this browser collapsed it (Ctrl or ⌘ B, or the header's button).
  const [open, setOpen] = React.useState(sidebarOpen);
  const changeOpen = React.useCallback((next: boolean) => {
    setOpen(next);
    rememberSidebar(next);
  }, []);
  return (
    <SidebarProvider className="h-svh" open={open} onOpenChange={changeOpen}>
      <CloseMenuOnNavigation />
      <AppSidebar />
      <SidebarInset className="min-h-0 overflow-hidden min-[60rem]:ring-1 min-[60rem]:ring-border min-[60rem]:peer-data-[variant=inset]:shadow-none">
        <AppHeader title={title ?? "Ottertrail"} projectId={projectId} />
        <div data-slot="app-content" className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
