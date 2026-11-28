import { ListFilterIcon, XIcon } from "lucide-react";
import * as React from "react";

import { TruncatedText } from "@/components/truncated-text";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { type Filter, withoutFilter } from "@/lib/analytics-api";
import { loadChunk, PageLoadError } from "@/lib/lazy-page";
import { reloadPage } from "@/lib/reload";

import { PageLink } from "./filter-link";
import { chipText, type PageSearch } from "./list-rows";

/*
 * The filter bar's filters (docs/dashboard.md, "Filters"): a chip per
 * filter, whose words open its editor, and "Filter" to add one. The chips
 * and buttons are here. The editor, its popover, the combobox, and the
 * selects load in their own chunk (filter-form.tsx) when one first opens,
 * so a first visit, on a shared link too, does not download them.
 */

const loadForm = () => loadChunk(() => import("./filter-form"));

interface PopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchor: React.RefObject<HTMLButtonElement | null>;
  search: PageSearch;
  filter: Filter | undefined;
}

/** A failed download shows a way to reload, and the page stays. */
const FilterPopover = React.lazy(async () => {
  try {
    return { default: (await loadForm()).FilterPopover };
  } catch (error) {
    if (error instanceof PageLoadError) return { default: EditorUnavailable };
    throw error;
  }
});

function EditorUnavailable({ open, onOpenChange }: PopoverProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>The filter editor could not load</DialogTitle>
          <DialogDescription>
            Its download failed. Reload to try again, or select a name in a table to filter by it.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={reloadPage}>Reload</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Start the download on hover or focus, so a click rarely waits. */
const preload = () => {
  void loadForm().catch(() => undefined);
};

/**
 * The open state of a button that opens the editor. The popover has no
 * trigger of its own, since that would load its code with the page: a
 * press outside it closes it on pointer down, so the click that follows on
 * the button must not open it again.
 */
function useEditor() {
  const [open, setOpen] = React.useState(false);
  const [wanted, setWanted] = React.useState(false);
  const anchor = React.useRef<HTMLButtonElement>(null);
  const openOnDown = React.useRef<boolean | null>(null);
  const button = {
    ref: anchor,
    "aria-haspopup": "dialog" as const,
    "aria-expanded": open,
    onPointerEnter: preload,
    onFocus: preload,
    onPointerDown: () => {
      openOnDown.current = open;
    },
    onClick: () => {
      const wasOpen = openOnDown.current ?? open;
      openOnDown.current = null;
      setWanted(true);
      setOpen(!wasOpen);
    },
  };
  const popover = (search: PageSearch, filter: Filter | undefined) =>
    wanted && (
      <React.Suspense fallback={null}>
        <FilterPopover
          open={open}
          onOpenChange={setOpen}
          anchor={anchor}
          search={search}
          filter={filter}
        />
      </React.Suspense>
    );
  return { button, popover };
}

/** Opens the editor for a new filter. */
export function AddFilter({ search }: { search: PageSearch }) {
  const editor = useEditor();
  return (
    <>
      <Button variant="outline" {...editor.button}>
        <ListFilterIcon data-icon="inline-start" />
        Filter
      </Button>
      {editor.popover(search, undefined)}
    </>
  );
}

/** A filter's chip: its words open the editor, and its button removes it. */
export function FilterChip({ search, filter }: { search: PageSearch; filter: Filter }) {
  const editor = useEditor();
  const text = chipText(filter);
  return (
    <li className="inline-flex max-w-full items-center gap-0.5 rounded-md bg-muted py-0.5 pr-0.5 pl-2 text-sm text-ink">
      <button
        type="button"
        aria-label={`Edit the filter ${text}`}
        className="min-w-0 rounded text-left hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        {...editor.button}
      >
        <TruncatedText text={text} />
      </button>
      {editor.popover(search, filter)}
      <PageLink
        search={{ ...search, filters: withoutFilter(search.filters, filter) }}
        aria-label={`Remove the filter ${text}`}
        className="rounded p-1 text-ink-subtle hover:bg-background/60 hover:text-ink"
      >
        <XIcon aria-hidden="true" className="size-3.5" />
      </PageLink>
    </li>
  );
}
