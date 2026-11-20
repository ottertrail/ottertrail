import { useMatches, useSearch } from "@tanstack/react-router";
import { cn } from "cn";
import { ArrowUpRightIcon, MenuIcon } from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";

import { TruncatedText } from "@/components/truncated-text";
import { Button } from "@/components/ui/button";
import { useSidebar } from "@/components/ui/sidebar";
import { type DocsLinkTarget, docsFor } from "@/lib/docs";

/**
 * What a page tells the layout's header: a title of its own (a detail
 * page's item) and the element its actions are drawn into.
 */
interface PageHeaderSlots {
  actions: HTMLElement | null;
  setTitle: (title: string | undefined) => void;
}

const SlotsContext = React.createContext<PageHeaderSlots | null>(null);

/**
 * The page's primary actions (New project, Invite, Add rule), drawn at the
 * end of the page header. They stay in the page's React tree, so a dialog
 * they open keeps the page's state and context.
 */
export function PageActions({ children }: { children: React.ReactNode }) {
  const slots = React.use(SlotsContext);
  if (slots?.actions == null) return null;
  return createPortal(children, slots.actions);
}

/**
 * Names the page in its header in place of the route's title: a detail
 * page's item, such as an error's type or a user's name. While it loads,
 * the route's title ("Error") shows.
 */
export function PageTitle({ title }: { title: string | undefined }) {
  const setTitle = React.use(SlotsContext)?.setTitle;
  React.useLayoutEffect(() => {
    setTitle?.(title);
    return () => setTitle?.(undefined);
  }, [setTitle, title]);
  return null;
}

/** Under 60rem, opens the sidebar's sheet: with no top bar, the way to the menu. */
function MenuButton() {
  const { toggleSidebar, openMobile } = useSidebar();
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Open menu"
      aria-expanded={openMobile}
      // 44px to a finger, 32px to the eye; pulled into the gutter so the icon lines up.
      className="relative -ms-2 shrink-0 text-ink-muted after:absolute after:-inset-1.5"
      onClick={toggleSidebar}
    >
      <MenuIcon />
    </Button>
  );
}

/**
 * The screen's page on the docs site, in a new tab: "Docs" and an arrow in
 * small muted text, on the title's baseline. `noreferrer` keeps the
 * instance's address from the docs site. The name starts with the topic.
 */
function DocsLink({ docs }: { docs: DocsLinkTarget }) {
  return (
    <a
      href={docs.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${docs.topic} docs (opens in a new tab)`}
      data-slot="page-docs-link"
      // 44px high to a finger, without moving the text.
      className="relative inline-flex shrink-0 items-center gap-0.5 rounded-sm text-sm text-ink-subtle after:absolute after:-inset-x-1 after:-inset-y-3 hover:text-ink"
    >
      Docs
      <ArrowUpRightIcon aria-hidden="true" className="size-3" />
    </a>
  );
}

/**
 * The top of every signed-in page, in place of a header bar
 * (docs/design-system.md, "Page header"): the page's `h1`, its docs page
 * right after it (lib/docs.ts), and its actions at the end, which the page
 * draws with `PageActions`. Under 60rem the menu button comes first. A
 * route without a title (a missing page) keeps the `h1` for screen readers
 * only, as its state shows a heading of its own.
 */
function PageHeader({
  title,
  setActions,
}: {
  /** A page's own title (`PageTitle`), in place of the route's. */
  title: string | undefined;
  setActions: (element: HTMLElement | null) => void;
}) {
  const { isMobile } = useSidebar();
  const matches = useMatches();
  const { tab } = useSearch({ strict: false });
  const routeTitle = matches.findLast((match) => match.staticData.title !== undefined)?.staticData
    .title;
  const docs = docsFor(matches.at(-1)?.fullPath, tab);
  const shown = title ?? routeTitle;
  return (
    <div
      data-slot="page-header"
      className={cn(
        "flex min-h-14 shrink-0 items-center gap-3 px-gutter py-3 min-[60rem]:min-h-0 min-[60rem]:pt-7 min-[60rem]:pb-4",
        // With no title, nothing shows above 60rem: the page's state has its heading.
        shown === undefined && "min-[60rem]:sr-only",
      )}
    >
      {isMobile && <MenuButton />}
      {shown === undefined ? (
        <h1 className="sr-only">Ottertrail</h1>
      ) : (
        <div className="flex min-h-8 min-w-0 flex-1 items-center">
          <div className="flex min-w-0 items-baseline gap-3">
            <TruncatedText
              text={shown}
              side="bottom"
              className="min-w-0 text-xl font-semibold tracking-tight text-ink min-[60rem]:text-card-title min-[60rem]:font-semibold"
              render={<h1>{shown}</h1>}
            />
            {docs !== undefined && <DocsLink docs={docs} />}
          </div>
        </div>
      )}
      <div ref={setActions} className="ml-auto flex shrink-0 items-center gap-2 empty:hidden" />
    </div>
  );
}

/**
 * The content panel's scrolling column: the page header, then the page,
 * which fills what is left (a workbench's full height, a state centred in
 * it) and scrolls with the header when longer. The page fills in the
 * header through `PageTitle` and `PageActions`.
 */
export function PageWithHeader({ children }: { children: React.ReactNode }) {
  const [actions, setActions] = React.useState<HTMLElement | null>(null);
  const [title, setTitle] = React.useState<string | undefined>(undefined);
  const slots = React.useMemo(() => ({ actions, setTitle }), [actions]);
  return (
    <div data-slot="app-content" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <PageHeader title={title} setActions={setActions} />
      <div data-slot="page" className="min-h-0 flex-1">
        <SlotsContext value={slots}>{children}</SlotsContext>
      </div>
    </div>
  );
}
