import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { FolderIcon, OctagonAlertIcon } from "lucide-react";

import { ButtonLink } from "@/components/button-link";
import { clickableRow, ROW_LINK } from "@/components/clickable-row";
import { PINNED, PINNED_END } from "@/components/pinned-column";
import { ScrollHint } from "@/components/scroll-hint";
import { StatusBadge } from "@/components/status-badge";
import { TruncatedText } from "@/components/truncated-text";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { GUTTER_END, GUTTER_START, LIST_HEAD } from "@/components/workbench-rows";
import { useAccess } from "@/lib/access";
import { isFullProject, type ProjectSummary, projectsQuery } from "@/lib/projects-api";

import { formatDay, formatMoment } from "../users/format";
import { keepText, timeAgo } from "./format";
import { NewProjectDialog } from "./new-project-dialog";

function LastEvent({ project, timeZone }: { project: ProjectSummary; timeZone?: string }) {
  if (project.lastEventAt === null) {
    return <StatusBadge tone="neutral">No events yet</StatusBadge>;
  }
  return (
    <span className="text-ink-muted" title={formatMoment(project.lastEventAt, timeZone)}>
      {timeAgo(new Date(project.lastEventAt))}
    </span>
  );
}

/** The table's rows while the list loads: its columns' shape. */
function ProjectsSkeleton() {
  return (
    <div
      className="flex flex-col gap-3 px-gutter py-4"
      aria-busy="true"
      aria-label="Loading projects"
    >
      <Skeleton className="h-4 w-full max-w-xl" />
      {[0, 1, 2].map((index) => (
        <Skeleton key={index} className="h-9 w-full" />
      ))}
    </div>
  );
}

/**
 * The projects (/projects): each one's name, then what an owner checks
 * first: whether its events arrive (the last one), and, for those who
 * manage projects, whether any site may send them, how long they are kept,
 * and a way into its settings. Members see the projects they were given.
 */
export function ProjectsPage() {
  const projects = useQuery(projectsQuery());
  const { can, me } = useAccess();
  // Creating projects, their allowed sites, and their settings are for those who manage projects.
  const canManage = can("projects");
  const timeZone = me?.instance.timeZone;
  const list = projects.data;

  return (
    <div className="flex flex-col">
      {list !== undefined && list.length > 0 && canManage && (
        <div className="flex justify-end border-b px-gutter py-3">
          <NewProjectDialog />
        </div>
      )}

      {projects.isPending && <ProjectsSkeleton />}

      {projects.isError && (
        <div className="max-w-3xl px-gutter py-6">
          <Alert variant="destructive">
            <OctagonAlertIcon />
            <AlertTitle>Projects could not load</AlertTitle>
            <AlertDescription>{projects.error.message}</AlertDescription>
            <AlertAction>
              <Button variant="outline" size="sm" onClick={() => void projects.refetch()}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        </div>
      )}

      {list?.length === 0 && (
        <div className="px-gutter py-6">
          <Empty className="border border-dashed p-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderIcon />
              </EmptyMedia>
              <EmptyTitle>No projects yet</EmptyTitle>
              <EmptyDescription>
                {canManage
                  ? "Create a project for your website or app to get its tracking snippet."
                  : "You have no assigned projects yet. Ask an admin of this instance."}
              </EmptyDescription>
            </EmptyHeader>
            {canManage && (
              <EmptyContent>
                <NewProjectDialog />
              </EmptyContent>
            )}
          </Empty>
        </div>
      )}

      {list !== undefined && list.length > 0 && (
        <ScrollHint>
          <Table>
            <caption className="sr-only">Projects</caption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col" className={cn(LIST_HEAD, GUTTER_START, PINNED)}>
                  Name
                </TableHead>
                <TableHead scope="col" className={LIST_HEAD}>
                  Last event
                </TableHead>
                {canManage && (
                  <TableHead scope="col" className={LIST_HEAD}>
                    Allowed sites
                  </TableHead>
                )}
                {canManage && (
                  <TableHead scope="col" className={LIST_HEAD}>
                    Keeps events
                  </TableHead>
                )}
                <TableHead scope="col" className={cn(LIST_HEAD, !canManage && GUTTER_END)}>
                  Created
                </TableHead>
                {canManage && (
                  <TableHead scope="col" className={cn(LIST_HEAD, GUTTER_END, PINNED_END)}>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((project) => {
                const full = isFullProject(project) ? project : null;
                const noSites = full !== null && full.allowedHostnames.length === 0;
                return (
                  <TableRow key={project.id} {...clickableRow()}>
                    {/* The row's header, for reading the table by rows. */}
                    <TableHead scope="row" className={cn(GUTTER_START, PINNED, "h-auto py-2.5")}>
                      <Link
                        to="/projects/$projectId"
                        params={{ projectId: project.id }}
                        {...ROW_LINK}
                        className="text-link hover:underline"
                      >
                        {project.name}
                      </Link>
                    </TableHead>
                    <TableCell>
                      <LastEvent project={project} timeZone={timeZone} />
                    </TableCell>
                    {canManage && (
                      <TableCell className="max-w-72 text-ink-muted">
                        {full === null ? null : noSites ? (
                          <StatusBadge tone="warning">None: events are refused</StatusBadge>
                        ) : (
                          <TruncatedText
                            text={full.allowedHostnames.join(", ")}
                            lines={full.allowedHostnames}
                          />
                        )}
                      </TableCell>
                    )}
                    {canManage && (
                      <TableCell className="text-ink-muted">
                        {full === null ? null : keepText(full.retentionDays)}
                      </TableCell>
                    )}
                    <TableCell
                      className={cn("text-ink-muted tabular-nums", !canManage && GUTTER_END)}
                    >
                      {formatDay(project.createdAt, timeZone)}
                    </TableCell>
                    {canManage && (
                      <TableCell className={cn(GUTTER_END, PINNED_END, "text-right")}>
                        <ButtonLink
                          variant="ghost"
                          size="sm"
                          to="/projects/$projectId/settings"
                          params={{ projectId: project.id }}
                          search={noSites ? { tab: "general" } : {}}
                          aria-label={
                            noSites
                              ? `Add a site to ${project.name}`
                              : `Settings of ${project.name}`
                          }
                        >
                          {noSites ? "Add a site" : "Settings"}
                        </ButtonLink>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </ScrollHint>
      )}
    </div>
  );
}
