import { useQuery } from "@tanstack/react-query";
import { Outlet, useMatches, useParams, useRouter } from "@tanstack/react-router";
import * as React from "react";

import { AppSidebar } from "@/components/app-shell/app-sidebar";
import { PageWithHeader } from "@/components/page-header";
import { SidebarInset, SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { documentTitle, useDocumentTitle, useStatusTitle } from "@/lib/document-title";
import { projectsQuery } from "@/lib/projects-api";
import { rememberSidebar, sidebarOpen } from "@/lib/sidebar-state";

/** Closes the sidebar sheet after navigation below 60rem. */
function CloseMenuOnNavigation() {
  const router = useRouter();
  const { setOpenMobile } = useSidebar();
  React.useEffect(
    () => router.subscribe("onResolved", () => setOpenMobile(false)),
    [router, setOpenMobile],
  );
  return null;
}

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

export function AppLayout() {
  const matches = useMatches();
  const { projectId } = useParams({ strict: false });
  const title = matches.findLast((match) => match.staticData.title !== undefined)?.staticData.title;
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
        <PageWithHeader>
          <Outlet />
        </PageWithHeader>
      </SidebarInset>
    </SidebarProvider>
  );
}
