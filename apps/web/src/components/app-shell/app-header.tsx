import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BookOpenIcon, MenuIcon } from "lucide-react";

import { ButtonAnchor } from "@/components/button-anchor";
import { TruncatedText } from "@/components/truncated-text";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import type { DocsLinkTarget } from "@/lib/docs";
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
      <TruncatedText
        text={name}
        side="bottom"
        className="max-w-48 text-sm text-ink-subtle hover:text-ink"
        render={<Link to="/projects/$projectId" params={{ projectId }} />}
      />
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

/**
 * The screen's page on the docs site, in a new tab. `noreferrer` keeps the
 * instance's address from the docs site. Under 40rem only the icon shows;
 * the name stays, starting with the topic and holding the word shown.
 */
function DocsLink({ docs }: { docs: DocsLinkTarget }) {
  return (
    <ButtonAnchor
      variant="ghost"
      size="sm"
      href={docs.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${docs.topic} docs (opens in a new tab)`}
      // Under 40rem, the icon in 28px, with 44px to a finger as the menu button.
      className="text-ink-subtle max-[40rem]:relative max-[40rem]:size-7 max-[40rem]:px-0 max-[40rem]:after:absolute max-[40rem]:after:-inset-2"
    >
      <BookOpenIcon aria-hidden="true" />
      <span className="max-[40rem]:sr-only">Docs</span>
    </ButtonAnchor>
  );
}

/**
 * The page title; inside a project, after the project's name. At the end,
 * the screen's Docs link when it has a page (lib/docs.ts), and the sidebar's
 * shortcut.
 */
export function AppHeader({
  title,
  projectId,
  docs,
}: {
  title: string;
  projectId?: string | undefined;
  docs?: DocsLinkTarget | undefined;
}) {
  const { isMobile } = useSidebar();
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-2 min-[60rem]:px-3">
      <MenuButton />
      <Separator orientation="vertical" className="my-auto h-4" />
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2">
        {projectId !== undefined && <ProjectCrumb projectId={projectId} />}
        <TruncatedText
          text={title}
          side="bottom"
          className="text-sm font-medium"
          render={<h1>{title}</h1>}
        />
      </nav>
      <div className="ml-auto flex shrink-0 items-center gap-3">
        {docs !== undefined && <DocsLink docs={docs} />}
        {!isMobile && (
          <p className="flex items-center gap-1.5 text-xs text-ink-subtle">
            <KbdGroup>
              <Kbd>{modifierKey()}</Kbd>
              <Kbd>B</Kbd>
            </KbdGroup>
            <span>sidebar</span>
          </p>
        )}
      </div>
    </header>
  );
}
