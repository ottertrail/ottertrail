import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { projectsQuery } from "@/lib/projects-api";

/** The project's name, linking to its first page. */
function ProjectCrumb({ projectId }: { projectId: string }) {
  const projects = useQuery(projectsQuery());
  const name = projects.data?.find((project) => project.id === projectId)?.name;
  if (name === undefined) {
    return null;
  }
  return (
    <>
      <Link
        to="/projects/$projectId"
        params={{ projectId }}
        className="max-w-48 truncate text-sm text-ink-subtle hover:text-ink"
      >
        {name}
      </Link>
      <span aria-hidden="true" className="text-sm text-ink-subtle">
        /
      </span>
    </>
  );
}

/** The page title; inside a project, after the project's name. */
export function AppHeader({ title, projectId }: { title: string; projectId?: string | undefined }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
      <SidebarTrigger />
      <Separator orientation="vertical" className="my-auto h-4" />
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2">
        {projectId !== undefined && <ProjectCrumb projectId={projectId} />}
        <h1 className="truncate text-sm font-medium">{title}</h1>
      </nav>
    </header>
  );
}
