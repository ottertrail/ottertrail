import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRightIcon } from "lucide-react";
import { useId } from "react";

import { EventDot, ProjectTile } from "@/components/project-tile";
import { OverflowTooltip, TruncatedText } from "@/components/truncated-text";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  useSidebar,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { meQuery } from "@/lib/access";
import { byName, starredProjectsQuery } from "@/lib/project-stars";
import { eventStatus } from "@/lib/project-status";
import { initialOf } from "@/lib/project-tile";
import { type ProjectSummary, projectsQuery } from "@/lib/projects-api";

/** How many projects the group lists when none is starred. */
export const FALLBACK_PROJECTS = 5;

/** "Receiving events" read after the name: "Main site, receiving events". */
const lowerFirst = (text: string) => text.charAt(0).toLocaleLowerCase() + text.slice(1);

function ProjectItem({ project, collapsed }: { project: ProjectSummary; collapsed: boolean }) {
  const status = eventStatus(project.lastEventAt);
  return (
    <SidebarMenuItem>
      {/* One tooltip, always: the name, and the dot's meaning in words. */}
      <OverflowTooltip
        always
        side="right"
        content={
          <>
            <span className="font-medium">{project.name}</span>
            <span className="text-xs">{status.label}</span>
          </>
        }
        render={
          <SidebarMenuButton
            data-slot="sidebar-project"
            // The name, then the dot's meaning: "Main site, receiving events".
            aria-label={`${project.name}, ${lowerFirst(status.label)}`}
            className="group-data-[collapsible=icon]:p-1.5!"
            render={<Link to="/projects/$projectId" params={{ projectId: project.id }} />}
          />
        }
      >
        <ProjectTile projectId={project.id} name={project.name} />
        <TruncatedText text={project.name} className="flex-1" />
        <EventDot state={status.state} className={collapsed ? "hidden" : "mr-1"} />
      </OverflowTooltip>
    </SidebarMenuItem>
  );
}

/**
 * The workspace sidebar's projects, under its menu: the user's starred
 * projects by name, or with none starred the first few they may open, so
 * the space is never empty; then a link to all of them. Each opens its
 * project (its overview, or the first page the user may open).
 */
export function SidebarProjects() {
  const projects = useQuery(projectsQuery());
  // A list that cannot load counts as no stars: the projects still show.
  const starred = useQuery(starredProjectsQuery());
  const labelId = useId();
  const { isMobile, state } = useSidebar();
  const collapsed = state === "collapsed" && !isMobile;

  // The Projects page says why a list could not load, or how to start without one.
  if (projects.isError || projects.data?.length === 0) return null;
  if (projects.data === undefined || starred.isPending) {
    return (
      <SidebarGroup aria-busy="true" aria-label="Loading your projects">
        <Skeleton className="mx-2 my-2 h-3 w-16" />
        {[0, 1, 2].map((index) => (
          <SidebarMenuSkeleton key={index} showIcon />
        ))}
      </SidebarGroup>
    );
  }

  const ids = new Set(starred.data ?? []);
  const stars = byName(projects.data.filter((project) => ids.has(project.id)));
  const shown = stars.length > 0 ? stars : byName(projects.data).slice(0, FALLBACK_PROJECTS);
  return (
    <nav aria-labelledby={labelId}>
      <SidebarGroup>
        <SidebarGroupLabel id={labelId}>
          {stars.length > 0 ? "Starred" : "Projects"}
        </SidebarGroupLabel>
        <SidebarMenu>
          {shown.map((project) => (
            <ProjectItem key={project.id} project={project} collapsed={collapsed} />
          ))}
          {/* Collapsed, the workspace menu's Projects is the way to the list. */}
          <SidebarMenuItem className="group-data-[collapsible=icon]:hidden">
            <SidebarMenuButton render={<Link to="/projects" />} className="text-ink-subtle">
              <ArrowRightIcon />
              <span>All projects</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
    </nav>
  );
}

/**
 * The workspace sidebar's head under the mark: the instance's initial,
 * name, and "Instance", as the project switcher names a project.
 */
export function InstanceName() {
  const me = useQuery(meQuery());
  if (me.isPending) return <Skeleton className="h-12 w-full" />;
  // Without /api/me the page says what failed; the head keeps the mark alone.
  if (me.isError) return null;
  const { name } = me.data.instance;
  return (
    <div
      data-slot="instance-name"
      className="flex h-12 items-center gap-2 rounded-md p-2 text-sm group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:p-0"
    >
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-md bg-sidebar-accent text-xs font-semibold text-ink"
      >
        {initialOf(name)}
      </span>
      <div className="grid min-w-0 flex-1 leading-tight group-data-[collapsible=icon]:hidden">
        <TruncatedText text={name} className="text-sm font-medium text-ink" />
        <span className="truncate text-xs text-ink-subtle">Instance</span>
      </div>
    </div>
  );
}
