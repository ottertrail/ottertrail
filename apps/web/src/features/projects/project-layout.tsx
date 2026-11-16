import { useQuery } from "@tanstack/react-query";
import { Outlet } from "@tanstack/react-router";
import * as React from "react";

import { ApiError } from "@/lib/api";
import { rememberProject } from "@/lib/last-project";
import { projectQuery } from "@/lib/projects-api";

import { NoSuchProject } from "./no-such-project";

/**
 * Every page inside a project (/projects/<id>/…). The page starts loading
 * at once; this only steps in when the project does not exist. A project
 * that loads becomes the one the home page opens next time.
 */
export function ProjectLayout({ projectId }: { projectId: string }) {
  const project = useQuery(projectQuery(projectId));

  React.useEffect(() => {
    if (project.isSuccess) {
      rememberProject(projectId);
    }
  }, [project.isSuccess, projectId]);

  if (project.error instanceof ApiError && project.error.status === 404) {
    return <NoSuchProject />;
  }
  return <Outlet />;
}
