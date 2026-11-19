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
 * A list and the selected item's detail beside it, resizable (Errors,
 * Replays, Traces, Logs, Users, Uptime, Alerts).
 *
 * - The selection is a search parameter (`param`); with none, the detail
 *   pane shows `summary`. Nothing is selected on arrival.
 * - A click selects with a new history entry. `j` and `k` select the next
 *   and previous item and `Esc` clears the selection, replacing the entry,
 *   with focus on the chosen row; `action` acts on the selected item. Keys
 *   typed in a field, a menu or a dialog are left alone.
 * - Under 64rem there is no room for two panes: the list fills the screen,
 *   `narrowFooter` follows it, and choosing an item calls `onOpenPage`, which
 *   goes to its own page. A selection that appears while the screen is
 *   narrow (an address opened there) does the same, once, after removing
 *   the selection from the list's entry.
 * - The list, the pane, and what they open stay mounted across 64rem: CSS
 *   switches the layout. A window that narrows with an item selected keeps
 *   the selection in the address and its pane, hidden; widening shows the
 *   pane again as it was. The summary, which holds no dialog, shows once:
 *   in the pane from 64rem, as `narrowFooter` under it.
 *
 * Rows mark themselves with `data-workbench-id={id}`, so the selection
 * scrolls into view as the keys move it.
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
  // The latest callback, so a page may pass it inline without re-running the effects, and
  // the latest selection, for the effect that runs as the width changes.
  const openPageRef = React.useRef(onOpenPage);
  const selectedRef = React.useRef(selected);
  React.useLayoutEffect(() => {
    openPageRef.current = onOpenPage;
    selectedRef.current = selected;
  });

  // The pane renders from the first moment the screen is wide, and stays mounted after:
  // CSS hides it under 64rem, so crossing 64rem unmounts nothing open in it. A phone that
  // never widens renders no hidden pane.
  const [wideReached, setWideReached] = React.useState(!narrow);
  if (!narrow && !wideReached) setWideReached(true);

  // A click selects with a new history entry, so Back returns to the list as it was. Under
  // 64rem, at the moment of the click, it opens the item's own page instead, after taking a
  // hidden selection out of the list's entry: Back then lands on the list, not on a
  // selection that would open its own page as it appeared.
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

  // A selection that appears while the screen is narrow (an address opened there, a link)
  // shows the item's own page, once: the list's entry loses the selection first, so Back
  // returns to the list rather than opening the page again. A selection made on a wider
  // screen stays in the address, its pane hidden, when the window narrows; so does the one
  // that replaces it (a deleted check's neighbour).
  const lastSelected = React.useRef<string | undefined>(undefined);
  React.useEffect(() => {
    const before = lastSelected.current;
    lastSelected.current = selected;
    if (selected === undefined || before !== undefined || !narrowNow()) return;
    setSelected(undefined, { replace: true });
    openPageRef.current(selected);
  }, [selected, setSelected]);

  // Keys move the selection, focus follows it, and the list's rows scroll to it.
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
    // The selection cleared (Back, a link) while focus was in the detail, which is gone:
    // focus returns to the list, at the row that was chosen.
    const active = document.activeElement;
    if (
      selected === undefined &&
      before !== undefined &&
      (active === null || active === document.body || detailRef.current?.contains(active) === true)
    ) {
      focusRow(before);
    } else if (selected !== undefined) {
      // Chosen from inside the detail pane (a name in the summary), whose content is
      // gone: focus moves to the chosen row rather than dropping to the page.
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

  // The window narrowed while focus was in the pane, which CSS now hides: focus moves to
  // the list, at the selected row, rather than dropping to the page. Focus in a dialog
  // opened from the pane stays there. Whether focus was in the pane is tracked as it moves:
  // hiding the pane drops focus to the page before the narrowing renders. Focus that
  // leaves the pane while it shows (a click on blank space) no longer counts.
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
    // A list of choices, a menu or a popover opened from the pane would float at the
    // screen's corner, its anchor hidden: Escape closes it, as the reader would. A dialog
    // opened from the pane is centred, and stays open.
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
    // Focus leaves the popup as it closes, for its hidden anchor: then it goes to the row.
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

  // What the pane's content reads: whether it shows, and where a dialog opened from it
  // returns focus while it is hidden.
  const finalFocus = React.useCallback(
    () => (narrowNow() ? (rowOf(selectedRef.current)?.target ?? true) : true),
    [rowOf],
  );
  const pane = React.useMemo<WorkbenchPane>(
    () => ({ shown: !narrow, finalFocus }),
    [narrow, finalFocus],
  );

  // Where the selection last was in the list: when an action takes it out of the list
  // (resolving an error under Unresolved), j and k carry on from there, not the top.
  // New filters make a new list, which j starts at its top.
  const lastIndex = React.useRef(-1);
  const shownFilters = React.useRef(filterKey);
  // The list and selection when the filters changed: the old list stays on screen until
  // the new one comes, and the selection's place in it no longer counts.
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
      // Under 64rem, at the moment of the key, the list stands alone: the keys are not its.
      if (narrowNow() || typingOrOverlay(event)) return;
      const index = selected === undefined ? -1 : ids.indexOf(selected);
      // A selection the list no longer holds sat at `lastIndex`: the item now there is
      // the next one, and the one before it the previous.
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
          // Moving through the list replaces the entry: Back leaves the list, not each step.
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

  // One tree at every width, so crossing 64rem (a tablet turned) keeps what is open in the
  // pane, its dialogs and their text, and the panels' sizes. From 64rem the panels sit side
  // by side; under it CSS hides the handle and the pane, the list takes the whole row, and
  // the footer follows it.
  return (
    <div data-slot="workbench" className={cn("flex min-h-0 flex-col", className)}>
      <ResizablePanelGroup
        orientation="horizontal"
        // Under 64rem the hidden handle would still take pointer presses at the corner.
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

export function WorkbenchKeyHints({ action }: { action?: Pick<WorkbenchAction, "key" | "label"> }) {
  return (
    <ul
      aria-label="Keyboard shortcuts"
      data-slot="workbench-keys"
      className="hidden items-center gap-3 text-xs text-ink-subtle min-[64rem]:flex"
    >
      <KeyHint keys={["j", "k"]} text="move" />
      {action !== undefined && <KeyHint keys={[action.key]} text={action.label} />}
      <KeyHint keys={["Esc"]} text="clear" />
    </ul>
  );
}
