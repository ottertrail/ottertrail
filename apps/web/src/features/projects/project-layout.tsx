import { useQuery } from "@tanstack/react-query";
import { Outlet, useMatches } from "@tanstack/react-router";
import * as React from "react";

import { NoAccess } from "@/components/no-access";
import { canOpen, meQuery } from "@/lib/access";
import { ApiError } from "@/lib/api";
import { rememberProject } from "@/lib/last-project";
import { projectQuery } from "@/lib/projects-api";

import { NoSuchProject } from "./no-such-project";

/** The API uses the same response for missing and inaccessible projects. Check area access too (docs/access.md). */
export function ProjectLayout({ projectId }: { projectId: string }) {
  const project = useQuery(projectQuery(projectId));
  const me = useQuery(meQuery());
  const page = useMatches().findLast((match) => match.staticData.access !== undefined)?.staticData
    .access;

  React.useEffect(() => {
    if (project.isSuccess) {
      rememberProject(projectId);
    }
  }, [project.isSuccess, projectId]);

  if (project.error instanceof ApiError && project.error.status === 404) {
    return <NoSuchProject />;
  }
  if (me.data !== undefined && page !== undefined && !canOpen(me.data, page)) {
    return <NoAccess />;
  }
  return <Outlet />;
}
