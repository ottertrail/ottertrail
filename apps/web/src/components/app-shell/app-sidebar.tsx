import { useQuery } from "@tanstack/react-query";
import { Link, useMatchRoute, useNavigate, useParams } from "@tanstack/react-router";
import {
  ActivityIcon,
  ArrowLeftIcon,
  BugIcon,
  ChartColumnIcon,
  ChartLineIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  FolderIcon,
  GaugeIcon,
  HardDriveIcon,
  HeartPulseIcon,
  PaletteIcon,
  ScrollTextIcon,
  ServerIcon,
  SettingsIcon,
  UsersIcon,
  WaypointsIcon,
} from "lucide-react";

import { ApiStatus } from "@/components/api-status";
import { UserMenu } from "@/components/app-shell/user-menu";
import { BrandMark } from "@/components/brand-mark";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { projectsQuery } from "@/lib/projects-api";
import { settingsQuery } from "@/lib/settings-api";

/** The workspace level: things above any one project, under the instance's name. */
function WorkspaceMenu() {
  const matchRoute = useMatchRoute();
  const settings = useQuery(settingsQuery());
  // A neutral label until the settings load, or if they cannot.
  const label = settings.data?.name ?? "Workspace";
  return (
    <SidebarGroup>
      <SidebarGroupLabel className="truncate">{label}</SidebarGroupLabel>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            render={<Link to="/projects" />}
            isActive={matchRoute({ to: "/projects" }) !== false}
            tooltip="Projects"
          >
            <FolderIcon />
            <span>Projects</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton
            render={<Link to="/design-system" />}
            isActive={matchRoute({ to: "/design-system" }) !== false}
            tooltip="Design system"
          >
            <PaletteIcon />
            <span>Design system</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton
            render={<Link to="/settings" />}
            isActive={matchRoute({ to: "/settings" }) !== false}
            tooltip="Settings"
          >
            <SettingsIcon />
            <span>Settings</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
  );
}

/**
 * Names the current project and switches to another one, staying on the
 * same page (web analytics stays web analytics, with its days, but not
 * its filters).
 */
function ProjectSwitcher({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const projects = useQuery(projectsQuery());
  const current = projects.data?.find((project) => project.id === projectId);

  if (projects.data === undefined) {
    return <Skeleton className="h-12 w-full" />;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <SidebarMenuButton
            size="lg"
            className="data-popup-open:bg-sidebar-accent"
            aria-label={`Project: ${current?.name ?? "unknown"}. Switch project`}
          />
        }
      >
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-sidebar-accent text-xs font-semibold text-ink">
          {(current?.name ?? "?").slice(0, 1).toUpperCase()}
        </div>
        <div className="grid min-w-0 flex-1 text-left leading-tight">
          <span className="truncate text-sm font-medium text-ink">
            {current?.name ?? "Unknown project"}
          </span>
          <span className="truncate text-xs text-ink-subtle">Project</span>
        </div>
        <ChevronsUpDownIcon className="ml-auto text-ink-subtle" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Projects</DropdownMenuLabel>
          {projects.data.map((project) => (
            <DropdownMenuItem
              key={project.id}
              onClick={() =>
                void navigate({
                  to: ".",
                  params: (previous) => ({ ...previous, projectId: project.id }),
                  // Keep the days; filters (a page, a campaign) belong to one project.
                  search: (previous) => ({
                    ...("period" in previous && previous.period !== undefined
                      ? { period: previous.period }
                      : {}),
                    ...("from" in previous && previous.from !== undefined
                      ? { from: previous.from, to: previous.to }
                      : {}),
                  }),
                })
              }
            >
              <span className="flex-1 truncate">{project.name}</span>
              {project.id === projectId && <CheckIcon aria-label="Current project" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void navigate({ to: "/projects" })}>
          All projects
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Inside one project: its modules, then its settings, in one list. */
function ProjectMenu({ projectId }: { projectId: string }) {
  const matchRoute = useMatchRoute();
  return (
    <>
      <SidebarGroup>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton render={<Link to="/projects" />} tooltip="All projects">
              <ArrowLeftIcon />
              <span>All projects</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>

      <SidebarGroup>
        <SidebarGroupLabel>Project</SidebarGroupLabel>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link to="/projects/$projectId/web-analytics" params={{ projectId }} />}
              isActive={
                matchRoute({ to: "/projects/$projectId/web-analytics", params: { projectId } }) !==
                false
              }
              tooltip="Web analytics"
            >
              <ChartLineIcon />
              <span>Web analytics</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link to="/projects/$projectId/speed" params={{ projectId }} />}
              isActive={
                matchRoute({ to: "/projects/$projectId/speed", params: { projectId } }) !== false
              }
              tooltip="Speed"
            >
              <GaugeIcon />
              <span>Speed</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link to="/projects/$projectId/users" params={{ projectId }} />}
              isActive={
                matchRoute({
                  to: "/projects/$projectId/users",
                  params: { projectId },
                  fuzzy: true,
                }) !== false
              }
              tooltip="Users"
            >
              <UsersIcon />
              <span>Users</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link to="/projects/$projectId/errors" params={{ projectId }} />}
              isActive={
                matchRoute({
                  to: "/projects/$projectId/errors",
                  params: { projectId },
                  fuzzy: true,
                }) !== false
              }
              tooltip="Errors"
            >
              <BugIcon />
              <span>Errors</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link to="/projects/$projectId/traces" params={{ projectId }} />}
              isActive={
                matchRoute({
                  to: "/projects/$projectId/traces",
                  params: { projectId },
                  fuzzy: true,
                }) !== false
              }
              tooltip="Traces"
            >
              <WaypointsIcon />
              <span>Traces</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link to="/projects/$projectId/logs" params={{ projectId }} />}
              isActive={
                matchRoute({ to: "/projects/$projectId/logs", params: { projectId } }) !== false
              }
              tooltip="Logs"
            >
              <ScrollTextIcon />
              <span>Logs</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link to="/projects/$projectId/metrics" params={{ projectId }} />}
              isActive={
                matchRoute({
                  to: "/projects/$projectId/metrics",
                  params: { projectId },
                  fuzzy: true,
                }) !== false
              }
              tooltip="Metrics"
            >
              <ActivityIcon />
              <span>Metrics</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link to="/projects/$projectId/services" params={{ projectId }} />}
              isActive={
                matchRoute({ to: "/projects/$projectId/services", params: { projectId } }) !== false
              }
              tooltip="Services"
            >
              <ServerIcon />
              <span>Services</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link to="/projects/$projectId/hosts" params={{ projectId }} />}
              isActive={
                matchRoute({
                  to: "/projects/$projectId/hosts",
                  params: { projectId },
                  fuzzy: true,
                }) !== false
              }
              tooltip="Hosts"
            >
              <HardDriveIcon />
              <span>Hosts</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link to="/projects/$projectId/uptime" params={{ projectId }} />}
              isActive={
                matchRoute({
                  to: "/projects/$projectId/uptime",
                  params: { projectId },
                  fuzzy: true,
                }) !== false
              }
              tooltip="Uptime"
            >
              <HeartPulseIcon />
              <span>Uptime</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link to="/projects/$projectId/product/events" params={{ projectId }} />}
              isActive={
                matchRoute({
                  to: "/projects/$projectId/product",
                  params: { projectId },
                  fuzzy: true,
                }) !== false
              }
              tooltip="Product analytics"
            >
              <ChartColumnIcon />
              <span>Product analytics</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link to="/projects/$projectId/settings" params={{ projectId }} />}
              isActive={
                matchRoute({ to: "/projects/$projectId/settings", params: { projectId } }) !== false
              }
              tooltip="Settings"
            >
              <SettingsIcon />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
    </>
  );
}

/**
 * Two levels, like a hosting dashboard: the workspace (all projects), and
 * inside a project, that project's own menu with a switcher and a way back.
 */
export function AppSidebar() {
  const { projectId } = useParams({ strict: false });
  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader>
        <div className="flex h-8 items-center gap-2 px-1.5">
          <BrandMark className="size-5 shrink-0" />
          <span className="truncate text-sm font-semibold tracking-tight text-ink group-data-[collapsible=icon]:hidden">
            Ottertrail
          </span>
        </div>
        {projectId !== undefined && (
          <SidebarMenu>
            <SidebarMenuItem>
              <ProjectSwitcher projectId={projectId} />
            </SidebarMenuItem>
          </SidebarMenu>
        )}
      </SidebarHeader>

      <SidebarContent>
        <nav
          aria-label={projectId === undefined ? "Workspace" : "Project"}
          className="flex flex-1 flex-col gap-2"
        >
          {projectId === undefined ? <WorkspaceMenu /> : <ProjectMenu projectId={projectId} />}
        </nav>
      </SidebarContent>

      <SidebarFooter className="gap-3 group-data-[collapsible=icon]:hidden">
        <UserMenu />
        <div className="px-1.5 pb-1">
          <ApiStatus />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
