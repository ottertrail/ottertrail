import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FolderIcon, OctagonAlertIcon } from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
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
import { useAccess } from "@/lib/access";
import { isFullProject, type ProjectSummary, projectsQuery } from "@/lib/projects-api";

import { timeAgo } from "./format";
import { NewProjectDialog } from "./new-project-dialog";

function LastEvent({ project }: { project: ProjectSummary }) {
  if (project.lastEventAt === null) {
    return <StatusBadge tone="neutral">No events yet</StatusBadge>;
  }
  return <span className="text-ink-muted">{timeAgo(new Date(project.lastEventAt))}</span>;
}

export function ProjectsPage() {
  const projects = useQuery(projectsQuery());
  // Creating projects, and their allowed sites, are for those who manage projects.
  const canManage = useAccess().can("projects");

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-ink">Projects</h2>
          <p className="text-sm text-ink-muted">
            Each website or app you track is a project, with its own snippet and data.
          </p>
        </div>
        {projects.data !== undefined && projects.data.length > 0 && canManage && (
          <NewProjectDialog />
        )}
      </div>

      {projects.isPending && (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading projects">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}

      {projects.isError && (
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
      )}

      {projects.data?.length === 0 && (
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
      )}

      {projects.data !== undefined && projects.data.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              {canManage && <TableHead>Allowed sites</TableHead>}
              <TableHead>Last event</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {projects.data.map((project) => (
              <TableRow key={project.id}>
                <TableCell className="font-medium">
                  <Link
                    to="/projects/$projectId"
                    params={{ projectId: project.id }}
                    className="text-link hover:underline"
                  >
                    {project.name}
                  </Link>
                </TableCell>
                {canManage && (
                  <TableCell className="text-ink-muted">
                    {!isFullProject(project) ? null : project.allowedHostnames.length === 0 ? (
                      <StatusBadge tone="warning">None: events are refused</StatusBadge>
                    ) : (
                      project.allowedHostnames.join(", ")
                    )}
                  </TableCell>
                )}
                <TableCell>
                  <LastEvent project={project} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
