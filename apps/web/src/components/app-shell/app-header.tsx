import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { MenuIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { modifierKey } from "@/lib/keys";
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

/**
 * Opens the sidebar's sheet under 60rem; above, collapses and expands the
 * sidebar, as Ctrl or ⌘ B does.
 */
function MenuButton() {
  const { isMobile, toggleSidebar, openMobile } = useSidebar();
  if (isMobile) {
    return (
      <Button
        variant="ghost"
        size="icon"
        aria-label="Open menu"
        aria-expanded={openMobile}
        // 44px to a finger, 32px to the eye.
        className="relative after:absolute after:-inset-1.5"
        onClick={toggleSidebar}
      >
        <MenuIcon />
      </Button>
    );
  }
  return <SidebarTrigger aria-keyshortcuts="Control+B Meta+B" />;
}

/** The page title; inside a project, after the project's name. */
export function AppHeader({ title, projectId }: { title: string; projectId?: string | undefined }) {
  const { isMobile } = useSidebar();
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-2 min-[60rem]:px-3">
      <MenuButton />
      <Separator orientation="vertical" className="my-auto h-4" />
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2">
        {projectId !== undefined && <ProjectCrumb projectId={projectId} />}
        <h1 className="truncate text-sm font-medium">{title}</h1>
      </nav>
      {!isMobile && (
        <p className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-ink-subtle">
          <KbdGroup>
            <Kbd>{modifierKey()}</Kbd>
            <Kbd>B</Kbd>
          </KbdGroup>
          <span>sidebar</span>
        </p>
      )}
    </header>
  );
}
