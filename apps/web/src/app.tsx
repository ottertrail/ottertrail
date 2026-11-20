import { useQuery } from "@tanstack/react-query";
import { Outlet, useMatches, useParams, useRouter } from "@tanstack/react-router";
import * as React from "react";

import { AppSidebar } from "@/components/app-shell/app-sidebar";
import { PageWithHeader } from "@/components/page-header";
import { SidebarInset, SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { documentTitle, useDocumentTitle, useStatusTitle } from "@/lib/document-title";
import { projectsQuery } from "@/lib/projects-api";
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

/** The tab's title: the page, then the project when inside one. */
function TabTitle({
  page,
  projectId,
}: {
  page: string | undefined;
  projectId?: string | undefined;
}) {
  const projects = useQuery({ ...projectsQuery(), enabled: projectId !== undefined });
  const project =
    projectId === undefined
      ? undefined
      : projects.data?.find((candidate) => candidate.id === projectId)?.name;
  const status = useStatusTitle();
  useDocumentTitle(documentTitle({ page: status ?? page, project }));
  return null;
}

/** The signed-in dashboard: the sidebar and the current page, with no header bar. */
export function AppLayout() {
  const matches = useMatches();
  const { projectId } = useParams({ strict: false });
  const title = matches.findLast((match) => match.staticData.title !== undefined)?.staticData.title;
  // Expanded unless this browser collapsed it (Ctrl or ⌘ B, or the sidebar's button).
  const [open, setOpen] = React.useState(sidebarOpen);
  const changeOpen = React.useCallback((next: boolean) => {
    setOpen(next);
    rememberSidebar(next);
  }, []);
  return (
    <SidebarProvider className="h-svh" open={open} onOpenChange={changeOpen}>
      <CloseMenuOnNavigation />
      <TabTitle page={title} projectId={projectId} />
      <AppSidebar />
      <SidebarInset className="min-h-0 overflow-hidden min-[60rem]:ring-1 min-[60rem]:ring-border min-[60rem]:peer-data-[variant=inset]:shadow-none">
        {/* No header bar: the page's title row scrolls with it. */}
        <PageWithHeader>
          <Outlet />
        </PageWithHeader>
      </SidebarInset>
    </SidebarProvider>
  );
}
