import {
  BugIcon,
  ChartColumnIcon,
  ChartLineIcon,
  MailIcon,
  PaletteIcon,
  UsersIcon,
} from "lucide-react";

import { ApiStatus } from "@/components/api-status";
import { BrandMark } from "@/components/brand-mark";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

/** First-release modules that are not built yet. Shown disabled and labeled. */
const plannedModules = [
  { title: "Web analytics", icon: ChartLineIcon },
  { title: "Product analytics", icon: ChartColumnIcon },
  { title: "Users", icon: UsersIcon },
  { title: "Errors", icon: BugIcon },
  { title: "Email", icon: MailIcon },
];

export function AppSidebar() {
  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader>
        <div className="flex h-8 items-center gap-2 px-1.5">
          <BrandMark className="size-5 shrink-0" />
          <span className="truncate text-sm font-semibold tracking-tight text-ink group-data-[collapsible=icon]:hidden">
            Ottertrail
          </span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton isActive aria-current="page" tooltip="Design system">
                <PaletteIcon />
                <span>Design system</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Planned</SidebarGroupLabel>
          <SidebarMenu>
            {plannedModules.map((module) => (
              <SidebarMenuItem key={module.title}>
                <SidebarMenuButton disabled>
                  <module.icon />
                  <span>{module.title}</span>
                </SidebarMenuButton>
                <SidebarMenuBadge className="text-ink-subtle">Planned</SidebarMenuBadge>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="group-data-[collapsible=icon]:hidden">
        <div className="px-1.5 pb-1">
          <ApiStatus />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
