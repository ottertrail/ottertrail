import { Outlet } from "@tanstack/react-router";

import { AppHeader } from "@/components/app-shell/app-header";
import { AppSidebar } from "@/components/app-shell/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

/** The signed-in dashboard: sidebar, header, and the current page. */
export function AppLayout() {
  return (
    <SidebarProvider className="h-svh">
      <AppSidebar />
      <SidebarInset className="min-h-0 overflow-hidden md:ring-1 md:ring-border md:peer-data-[variant=inset]:shadow-none">
        <AppHeader title="Design system" />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
