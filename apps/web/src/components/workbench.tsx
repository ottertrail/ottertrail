import { cn } from "cn";
import * as React from "react";

import { Kbd } from "@/components/ui/kbd";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { type WorkbenchPane, WorkbenchPaneContext } from "@/components/workbench-pane";
import { NARROW_WORKBENCH, useMediaQuery } from "@/hooks/use-media-query";
import { useSearchParam } from "@/hooks/use-search-param";
import { typingOrOverlay } from "@/lib/keys";

/** A key that acts on the selected item, such as `e` to resolve or reopen an error. */
export interface WorkbenchAction {
  key: string;
  /** What it does, after the key in the hints: "resolve or reopen". */
  label: string;
  onAction: (id: string) => void;
}

/** What the list pane's rows need to show and change the selection. */
export interface WorkbenchListProps {
  selected: string | undefined;
  select: (id: string) => void;
}

/** Whether the screen is under 64rem now: read at the moment of a click or a key. */
function narrowNow(): boolean {
  return window.matchMedia(NARROW_WORKBENCH).matches;
}

/**
 * Store selection in param; show summary when absent. Clicks add history entries;
 * j/k and Esc replace them. Ignore shortcuts in fields, menus, and dialogs.
 * Below 64rem, open selections with onOpenPage. Clear URL selections before opening them once.
 * Keep list and pane mounted across resizes so selection and dialogs survive.
 * Show summary in the pane from 64rem, or as narrowFooter below it.
 * Mark rows with data-workbench-id={id} for keyboard scrolling.
 */
export function Workbench({
  label,
  ids,
  param,
  renderList,
  renderDetail,
  summary,
  action,
  onOpenPage,
  selectionSearch,
  filterKey,
  narrowFooter,
  className,
}: {
  /** Names the two panes for screen readers: "Errors". */
  label: string;
  /** The listed items' IDs, in the list's order: what `j` and `k` move through. */
  ids: string[];
  /** The search parameter that holds the selection, such as "error". */
  param: string;
  renderList: (props: WorkbenchListProps) => React.ReactNode;
  renderDetail: (id: string) => React.ReactNode;
  /** Shown in the detail pane while nothing is selected: the list summed up. */
  summary: React.ReactNode;
  action?: WorkbenchAction;
  /** Opens the item's own page (a new history entry). */
  onOpenPage: (id: string) => void;
  /**
   * Other address values that belong to the selection, set with it: a
   * trace's start, and no span of the trace before it.
   */
  selectionSearch?: (id: string | undefined) => Record<string, unknown>;
  /**
   * The list's filters, as text: when they change, `j` starts from the top
   * again rather than from where a selection that left the list had been.
   */
  filterKey?: string;
  /**
   * Under 64rem, shown under the list: what the summary holds that has no
   * page of its own (the alerts firing now, every check's uptime).
   */
  narrowFooter?: React.ReactNode;
  className?: string;
}) {
  const [selected, setSelectedParam] = useSearchParam(param);
  const setSelected = React.useCallback(
    (id: string | undefined, { replace = false }: { replace?: boolean } = {}) =>
      setSelectedParam(id, { replace, also: selectionSearch?.(id) ?? {} }),
    [setSelectedParam, selectionSearch],
  );
  const narrow = useMediaQuery(NARROW_WORKBENCH);
  const listRef = React.useRef<HTMLElement>(null);
  const detailRef = React.useRef<HTMLElement>(null);
  // Refs keep inline callbacks and selection current without rerunning effects.
  const openPageRef = React.useRef(onOpenPage);
  const selectedRef = React.useRef(selected);
  React.useLayoutEffect(() => {
    openPageRef.current = onOpenPage;
    selectedRef.current = selected;
  });

  // Mount the pane once the screen reaches 64rem. Keep it mounted when hidden
  // so resizing preserves dialogs. Phones that never widen need no hidden pane.
  const [wideReached, setWideReached] = React.useState(!narrow);
  if (!narrow && !wideReached) setWideReached(true);

  // Add history on selection so Back restores the list. Below 64rem, clear hidden
  // selection before opening the item page so Back cannot reopen it.
  const select = React.useCallback(
    (id: string) => {
      if (!narrowNow()) {
        setSelected(id);
        return;
      }
      if (selected !== undefined) setSelected(undefined, { replace: true });
      onOpenPage(id);
    },
    [selected, onOpenPage, setSelected],
  );

  // Open new narrow-screen URL selections once, clearing them first so Back returns to the list.
  // Preserve selections made while wide, including replacements after deletion, when narrowing.
  const lastSelected = React.useRef<string | undefined>(undefined);
  React.useEffect(() => {
    const before = lastSelected.current;
    lastSelected.current = selected;
    if (selected === undefined || before !== undefined || !narrowNow()) return;
    setSelected(undefined, { replace: true });
    openPageRef.current(selected);
  }, [selected, setSelected]);

  const rowOf = React.useCallback((id: string | undefined) => {
    const list = listRef.current;
    if (list === null) return null;
    const row =
      id === undefined
        ? null
        : list.querySelector<HTMLElement>(`[data-workbench-id="${CSS.escape(id)}"]`);
    return {
      row,
      target: row?.querySelector<HTMLElement>("a[href], button, [tabindex]") ?? row ?? list,
    };
  }, []);
  const focusRow = React.useCallback(
    (id: string | undefined) => {
      const found = rowOf(id);
      if (found === null) return;
      found.target.focus({ preventScroll: true });
      (found.row ?? found.target).scrollIntoView?.({ block: "nearest" });
    },
    [rowOf],
  );
  const moved = React.useRef(false);
  const previous = React.useRef(selected);
  React.useEffect(() => {
    const before = previous.current;
    previous.current = selected;
    if (moved.current) {
      moved.current = false;
      focusRow(selected ?? before);
      return;
    }
    // Restore focus to the chosen row when clearing selection removes the focused detail.
    const active = document.activeElement;
    if (
      selected === undefined &&
      before !== undefined &&
      (active === null || active === document.body || detailRef.current?.contains(active) === true)
    ) {
      focusRow(before);
    } else if (selected !== undefined) {
      // Move focus to the row when selection removes the focused pane content.
      if (
        before !== selected &&
        (active === null ||
          active === document.body ||
          detailRef.current?.contains(active) === true)
      ) {
        focusRow(selected);
      } else {
        listRef.current
          ?.querySelector(`[data-workbench-id="${CSS.escape(selected)}"]`)
          ?.scrollIntoView?.({ block: "nearest" });
      }
    }
  }, [selected, focusRow]);

  // Return pane focus to the selected row on narrowing; leave open dialogs focused.
  // Track focus before CSS hides the pane and drops focus to the page.
  // Focus that leaves a visible pane no longer counts.
  const focusInDetail = React.useRef(false);
  React.useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      focusInDetail.current =
        event.target instanceof Node && detailRef.current?.contains(event.target) === true;
    };
    const onFocusOut = (event: FocusEvent) => {
      if (narrowNow()) return;
      const next = event.relatedTarget;
      if (!(next instanceof Node) || detailRef.current?.contains(next) !== true) {
        focusInDetail.current = false;
      }
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);
  React.useEffect(() => {
    if (!narrow) return undefined;
    const pane = detailRef.current;
    if (pane === null) return undefined;
    const lost = () => {
      const active = document.activeElement;
      return active === null || active === document.body || pane.contains(active);
    };
    // Close anchored popups when their hidden anchor would move them to the screen corner.
    // Keep centered dialogs open.
    const anchor = pane.querySelector(
      '[aria-expanded="true"][aria-haspopup]:not([aria-haspopup="dialog"])',
    );
    if (anchor === null) {
      if (pane.contains(document.activeElement) || (lost() && focusInDetail.current)) {
        focusInDetail.current = false;
        focusRow(selectedRef.current);
      }
      return undefined;
    }
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    // Restore row focus after the popup closes and focuses its hidden anchor.
    let timer = 0;
    let tries = 60;
    const settle = () => {
      if (anchor.getAttribute("aria-expanded") !== "true" && lost()) {
        focusInDetail.current = false;
        focusRow(selectedRef.current);
      } else if (tries-- > 0) {
        timer = window.setTimeout(settle, 16);
      }
    };
    settle();
    return () => window.clearTimeout(timer);
  }, [narrow, focusRow]);

  const finalFocus = React.useCallback(
    () => (narrowNow() ? (rowOf(selectedRef.current)?.target ?? true) : true),
    [rowOf],
  );
  const pane = React.useMemo<WorkbenchPane>(
    () => ({ shown: !narrow, finalFocus }),
    [narrow, finalFocus],
  );

  // Remember the position of removed items so j/k continue there. Reset on filter changes.
  const lastIndex = React.useRef(-1);
  const shownFilters = React.useRef(filterKey);
  // Ignore the old selection position while new filters load over a stale list.
  const beforeFilters = React.useRef<string | null>(null);
  React.useEffect(() => {
    const shown = `${selected ?? ""}\n${ids.join("\n")}`;
    if (shownFilters.current !== filterKey) {
      shownFilters.current = filterKey;
      beforeFilters.current = shown;
      lastIndex.current = -1;
      return;
    }
    if (beforeFilters.current === shown) return;
    beforeFilters.current = null;
    const index = selected === undefined ? -1 : ids.indexOf(selected);
    if (index !== -1) lastIndex.current = index;
  }, [ids, selected, filterKey]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Disable list shortcuts below 64rem, when items open on their own pages.
      if (narrowNow() || typingOrOverlay(event)) return;
      const index = selected === undefined ? -1 : ids.indexOf(selected);
      // After removal, lastIndex points to the next item; its predecessor is the previous item.
      const gone = selected !== undefined && index === -1 && lastIndex.current !== -1;
      const pressed = event.key;
      if (pressed === "j" || pressed === "k") {
        if (ids.length === 0) return;
        event.preventDefault();
        const next = gone
          ? pressed === "j"
            ? Math.min(lastIndex.current, ids.length - 1)
            : Math.max(Math.min(lastIndex.current, ids.length) - 1, 0)
          : pressed === "j"
            ? Math.min(index + 1, ids.length - 1)
            : index === -1
              ? 0
              : Math.max(index - 1, 0);
        const id = ids[next];
        if (id !== undefined && id !== selected) {
          moved.current = true;
          // Replace history so Back skips keyboard selection steps.
          setSelected(id, { replace: true });
        }
      } else if (pressed === "Escape" && selected !== undefined) {
        event.preventDefault();
        moved.current = true;
        setSelected(undefined, { replace: true });
      } else if (action !== undefined && pressed === action.key && selected !== undefined) {
        event.preventDefault();
        action.onAction(selected);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ids, selected, setSelected, action]);

  const listPane = (
    <section
      ref={listRef}
      tabIndex={-1}
      aria-label={`${label}, list`}
      data-slot="workbench-list"
      className="h-full min-h-0 overflow-y-auto"
    >
      {renderList({ selected: narrow ? undefined : selected, select })}
    </section>
  );

  // Keep one tree across 64rem so resizing preserves pane state, dialogs, and panel sizes.
  // CSS hides the pane and handle below 64rem.
  return (
    <div data-slot="workbench" className={cn("flex min-h-0 flex-col", className)}>
      <ResizablePanelGroup
        orientation="horizontal"
        // Disable pointer events on the hidden handle below 64rem.
        disabled={narrow}
        className="min-h-0 min-[64rem]:flex-1 max-[64rem]:[&>[data-workbench-pane=detail]]:hidden! max-[64rem]:[&>[data-workbench-pane=list]]:grow!"
      >
        <ResizablePanel data-workbench-pane="list" defaultSize="40%" minSize="25%" maxSize="65%">
          {listPane}
        </ResizablePanel>
        <ResizableHandle
          withHandle
          aria-label={`Resize the ${label.toLowerCase()} list`}
          className="max-[64rem]:hidden!"
        />
        <ResizablePanel data-workbench-pane="detail" defaultSize="60%" minSize="35%">
          <section
            ref={detailRef}
            aria-label={`${label}, ${selected === undefined ? "summary" : "selected"}`}
            data-slot="workbench-detail"
            className="h-full min-h-0 overflow-y-auto"
          >
            <WorkbenchPaneContext value={pane}>
              {wideReached &&
                (selected !== undefined
                  ? renderDetail(selected)
                  : // The footer already sums the list up under 64rem: one summary at a time.
                    (narrowFooter === undefined || !narrow) && summary)}
            </WorkbenchPaneContext>
          </section>
        </ResizablePanel>
      </ResizablePanelGroup>
      {/* Only under 64rem, as the pane's summary only from it: one summary at a time. */}
      {narrowFooter !== undefined && narrow && (
        <section
          aria-label={`${label}, overview`}
          data-slot="workbench-footer"
          className="border-t min-[64rem]:hidden"
        >
          {narrowFooter}
        </section>
      )}
    </div>
  );
}

/** The summary's last line: how to choose an item. */
export function WorkbenchStartHint({ noun }: { noun: string }) {
  return (
    <p className="border-t pt-5 text-sm text-ink-muted">
      Select {noun}, or press <Kbd>j</Kbd> to start at the top.
    </p>
  );
}

/** The keys a workbench answers to, for the filter bar: "j k move, e resolve or reopen, Esc clear". */
function KeyHint({ keys, text }: { keys: string[]; text: string }) {
  return (
    <li className="flex items-center gap-1.5">
      <span className="flex items-center gap-1">
        {keys.map((name) => (
          <Kbd key={name}>{name}</Kbd>
        ))}
      </span>
      {text}
    </li>
  );
}

/** A flex container's gap between items on one line, in pixels. */
const columnGap = (element: HTMLElement) =>
  Number.parseFloat(getComputedStyle(element).columnGap) || 0;

/**
 * Whether everything in the filter bar fits on one line with the hints at
 * `hintsWidth`: the bar's items side by side, and in its last group (the
 * range and the page's actions) everything but the hints themselves.
 */
function fitsOnOneLine(bar: HTMLElement, hints: HTMLElement, hintsWidth: number): boolean {
  const style = getComputedStyle(bar);
  const room =
    bar.clientWidth -
    (Number.parseFloat(style.paddingLeft) || 0) -
    (Number.parseFloat(style.paddingRight) || 0);
  const items = [...bar.children].filter(
    (item): item is HTMLElement => item instanceof HTMLElement && item.offsetParent !== null,
  );
  let needed = Math.max(0, items.length - 1) * columnGap(bar);
  for (const item of items) {
    if (!item.contains(hints)) {
      needed += item.getBoundingClientRect().width;
      continue;
    }
    const parts = [...item.children].filter(
      (part): part is HTMLElement =>
        part instanceof HTMLElement && part !== hints && part.offsetParent !== null,
    );
    needed += parts.reduce((sum, part) => sum + part.getBoundingClientRect().width, 0);
    needed += hintsWidth + parts.length * columnGap(item);
  }
  // Allow 1px for subpixel widths.
  return needed <= room + 1;
}

/**
 * Hide hints before they force the filter bar to wrap (docs/design-system.md, "Workbench").
 * Keep hidden hints laid out outside the flow to measure them. Recheck on render and resize.
 */
function useFitsOnBar(ref: React.RefObject<HTMLUListElement | null>): boolean {
  const [fits, setFits] = React.useState(true);
  const check = React.useCallback(() => {
    const hints = ref.current;
    const bar = hints?.closest<HTMLElement>("[data-slot=filter-bar]");
    if (hints == null || bar == null || getComputedStyle(hints).display === "none") return;
    setFits(fitsOnOneLine(bar, hints, hints.getBoundingClientRect().width));
  }, [ref]);
  React.useLayoutEffect(check);
  React.useLayoutEffect(() => {
    const bar = ref.current?.closest<HTMLElement>("[data-slot=filter-bar]");
    if (bar == null) return undefined;
    const observer = new ResizeObserver(check);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [ref, check]);
  return fits;
}

export function WorkbenchKeyHints({ action }: { action?: Pick<WorkbenchAction, "key" | "label"> }) {
  const ref = React.useRef<HTMLUListElement>(null);
  const fits = useFitsOnBar(ref);
  return (
    <ul
      ref={ref}
      aria-label="Keyboard shortcuts"
      data-slot="workbench-keys"
      data-fits={fits}
      className={cn(
        "hidden items-center gap-3 text-xs whitespace-nowrap text-ink-subtle min-[64rem]:flex",
        // Keep within the bar to prevent horizontal overflow.
        !fits && "pointer-events-none invisible absolute top-0 right-0",
      )}
    >
      <KeyHint keys={["j", "k"]} text="move" />
      {action !== undefined && <KeyHint keys={[action.key]} text={action.label} />}
      <KeyHint keys={["Esc"]} text="clear" />
    </ul>
  );
}
