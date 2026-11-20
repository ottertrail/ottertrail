import { useQuery } from "@tanstack/react-query";
import { Link, useMatchRoute, useNavigate, useParams } from "@tanstack/react-router";
import {
  ActivityIcon,
  ArrowLeftIcon,
  BellIcon,
  BookOpenIcon,
  BugIcon,
  ChartColumnIcon,
  ChartLineIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  DatabaseIcon,
  FilmIcon,
  FolderIcon,
  GaugeIcon,
  HardDriveIcon,
  HeartPulseIcon,
  LayoutDashboardIcon,
  MousePointerClickIcon,
  ScrollTextIcon,
  ServerIcon,
  SettingsIcon,
  StarIcon,
  StarOffIcon,
  UsersIcon,
  WaypointsIcon,
} from "lucide-react";

import { ApiStatus } from "@/components/api-status";
import { InstanceName } from "@/components/app-shell/instance-name";
import { UserMenu } from "@/components/app-shell/user-menu";
import { BrandMark } from "@/components/brand-mark";
import { OverflowTooltip, TruncatedText } from "@/components/truncated-text";
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
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { canOpen, hasOverview, meQuery, useAccess } from "@/lib/access";
import { DOCS_URL } from "@/lib/docs";
import { starredProjectsQuery, useProjectStar } from "@/lib/project-stars";
import { projectsQuery } from "@/lib/projects-api";

/** The workspace level: things above any one project, under the instance's name. */
function WorkspaceMenu() {
  const matchRoute = useMatchRoute();
  const { can } = useAccess();
  // The Settings page holds the instance's settings (the owner) and the channels (admins too).
  const showSettings = can("settings") || can("channels");
  return (
    <SidebarGroup>
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
        {can("members") && (
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link to="/settings/members" />}
              isActive={matchRoute({ to: "/settings/members" }) !== false}
              tooltip="Members"
            >
              <UsersIcon />
              <span>Members</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}
        {showSettings && (
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
        )}
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
  const starredIds = useQuery(starredProjectsQuery()).data;
  const star = useProjectStar();
  const current = projects.data?.find((project) => project.id === projectId);
  const isStarred = (id: string) => starredIds?.includes(id) === true;
  // Starred projects first, then the rest, each in the list's own order.
  const list = (projects.data ?? []).toSorted(
    (a, b) => Number(isStarred(b.id)) - Number(isStarred(a.id)),
  );
  const { isMobile, state } = useSidebar();
  // Collapsed to icons, the button shows only the initial: its tooltip names the project.
  const collapsed = state === "collapsed" && !isMobile;

  if (projects.data === undefined) {
    return <Skeleton className="h-12 w-full" />;
  }
  return (
    <DropdownMenu>
      <OverflowTooltip
        always={collapsed}
        side={collapsed ? "right" : "bottom"}
        content={current?.name ?? "Unknown project"}
        render={
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className="data-popup-open:bg-sidebar-accent"
                aria-label={`Project: ${current?.name ?? "unknown"}. Switch project`}
              />
            }
          />
        }
      >
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-sidebar-accent text-xs font-semibold text-ink">
          {(current?.name ?? "?").slice(0, 1).toUpperCase()}
        </div>
        <div className="grid min-w-0 flex-1 text-left leading-tight">
          <TruncatedText
            text={current?.name ?? "Unknown project"}
            className="text-sm font-medium text-ink"
          />
          <span className="truncate text-xs text-ink-subtle">Project</span>
        </div>
        <ChevronsUpDownIcon className="ml-auto text-ink-subtle" />
      </OverflowTooltip>
      <DropdownMenuContent className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Projects</DropdownMenuLabel>
          {list.map((project) => (
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
              {/* Wrapped, not cut off: the menu shows each name whole. */}
              <span className="min-w-0 flex-1 break-words">{project.name}</span>
              {isStarred(project.id) && (
                <StarIcon aria-label="Starred" className="fill-current text-ink-subtle" />
              )}
              {project.id === projectId && <CheckIcon aria-label="Current project" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {current !== undefined && starredIds !== undefined && (
          <DropdownMenuItem
            onClick={() => star.mutate({ projectId: current.id, starred: !isStarred(current.id) })}
          >
            {isStarred(current.id) ? <StarOffIcon /> : <StarIcon />}
            {isStarred(current.id) ? "Unstar this project" : "Star this project"}
          </DropdownMenuItem>
        )}
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
  // Only the areas this user has, and the settings for those who manage projects.
  const me = useQuery(meQuery()).data;
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
          {hasOverview(me) && (
            <SidebarMenuItem>
              <SidebarMenuButton
                render={<Link to="/projects/$projectId/overview" params={{ projectId }} />}
                isActive={
                  matchRoute({ to: "/projects/$projectId/overview", params: { projectId } }) !==
                  false
                }
                tooltip="Overview"
              >
                <LayoutDashboardIcon />
                <span>Overview</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          {canOpen(me, "web_analytics") && (
            <SidebarMenuItem>
              <SidebarMenuButton
                render={<Link to="/projects/$projectId/web-analytics" params={{ projectId }} />}
                isActive={
                  matchRoute({
                    to: "/projects/$projectId/web-analytics",
                    params: { projectId },
                  }) !== false
                }
                tooltip="Web analytics"
              >
                <ChartLineIcon />
                <span>Web analytics</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          {canOpen(me, "web_analytics") && (
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
          )}
          {canOpen(me, "web_analytics") && (
            <SidebarMenuItem>
              <SidebarMenuButton
                render={<Link to="/projects/$projectId/heatmaps" params={{ projectId }} />}
                isActive={
                  matchRoute({ to: "/projects/$projectId/heatmaps", params: { projectId } }) !==
                  false
                }
                tooltip="Heatmaps"
              >
                <MousePointerClickIcon />
                <span>Heatmaps</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          {canOpen(me, "users") && (
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
          )}
          {canOpen(me, "errors") && (
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
          )}
          {canOpen(me, "replays") && (
            <SidebarMenuItem>
              <SidebarMenuButton
                render={<Link to="/projects/$projectId/replays" params={{ projectId }} />}
                isActive={
                  matchRoute({
                    to: "/projects/$projectId/replays",
                    params: { projectId },
                    fuzzy: true,
                  }) !== false
                }
                tooltip="Replays"
              >
                <FilmIcon />
                <span>Replays</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          {canOpen(me, "monitoring") && (
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
          )}
          {canOpen(me, "monitoring") && (
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
          )}
          {canOpen(me, "monitoring") && (
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
          )}
          {canOpen(me, "monitoring") && (
            <SidebarMenuItem>
              <SidebarMenuButton
                render={<Link to="/projects/$projectId/services" params={{ projectId }} />}
                isActive={
                  matchRoute({
                    to: "/projects/$projectId/services",
                    params: { projectId },
                    fuzzy: true,
                  }) !== false
                }
                tooltip="Services"
              >
                <ServerIcon />
                <span>Services</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          {canOpen(me, "monitoring") && (
            <SidebarMenuItem>
              <SidebarMenuButton
                render={<Link to="/projects/$projectId/databases" params={{ projectId }} />}
                isActive={
                  matchRoute({
                    to: "/projects/$projectId/databases",
                    params: { projectId },
                    fuzzy: true,
                  }) !== false
                }
                tooltip="Databases"
              >
                <DatabaseIcon />
                <span>Databases</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          {canOpen(me, "monitoring") && (
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
          )}
          {canOpen(me, "uptime_alerts") && (
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
          )}
          {canOpen(me, "uptime_alerts") && (
            <SidebarMenuItem>
              <SidebarMenuButton
                render={<Link to="/projects/$projectId/alerts" params={{ projectId }} />}
                isActive={
                  matchRoute({
                    to: "/projects/$projectId/alerts",
                    params: { projectId },
                    fuzzy: true,
                  }) !== false
                }
                tooltip="Alerts"
              >
                <BellIcon />
                <span>Alerts</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          {canOpen(me, "product_analytics") && (
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
          )}
          {canOpen(me, "project_settings") && (
            <SidebarMenuItem>
              <SidebarMenuButton
                render={<Link to="/projects/$projectId/settings" params={{ projectId }} />}
                isActive={
                  matchRoute({ to: "/projects/$projectId/settings", params: { projectId } }) !==
                  false
                }
                tooltip="Settings"
              >
                <SettingsIcon />
                <span>Settings</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      </SidebarGroup>
    </>
  );
}

/**
 * The API's health beside the name: "Ottertrail …… API online". Collapsed
 * to icons, a dot on the mark's corner, with the same accessible name.
 */
function SidebarApiStatus() {
  const { isMobile, state } = useSidebar();
  const collapsed = state === "collapsed" && !isMobile;
  return (
    <ApiStatus
      compact={collapsed}
      className={collapsed ? "absolute right-0.5 bottom-0" : "ml-auto shrink-0"}
    />
  );
}

/**
 * The docs site's start, in a new tab, at the foot of the menu on every
 * page. The header's Docs link opens the page about the current screen.
 */
function SidebarDocs() {
  return (
    <SidebarGroup className="mt-auto">
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              // `noreferrer` keeps the instance's address from the docs site.
              render={
                <a
                  href={DOCS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Docs (opens in a new tab)"
                />
              }
              tooltip="Docs"
            >
              <BookOpenIcon aria-hidden="true" />
              <span>Docs</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
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
        <div className="relative flex h-8 items-center gap-2 px-1.5">
          <BrandMark className="size-5 shrink-0" />
          <span className="truncate text-sm font-semibold tracking-tight text-ink group-data-[collapsible=icon]:hidden">
            Ottertrail
          </span>
          <SidebarApiStatus />
        </div>
        {projectId === undefined ? (
          <InstanceName />
        ) : (
          <SidebarMenu>
            <SidebarMenuItem>
              <ProjectSwitcher projectId={projectId} />
            </SidebarMenuItem>
          </SidebarMenu>
        )}
      </SidebarHeader>

      <SidebarContent>
        <nav
          aria-label={projectId === undefined ? "Instance" : "Project"}
          className="flex flex-col gap-2"
        >
          {projectId === undefined ? <WorkspaceMenu /> : <ProjectMenu projectId={projectId} />}
        </nav>
        <SidebarDocs />
      </SidebarContent>

      <SidebarFooter>
        <UserMenu />
      </SidebarFooter>
    </Sidebar>
  );
}
