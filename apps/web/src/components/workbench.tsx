import { cn } from "cn";
import * as React from "react";

import { Kbd } from "@/components/ui/kbd";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
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
 * - Under 64rem there is no room for two panes: the list fills the screen
 *   and choosing an item calls `onOpenPage`, which goes to its own page. An
 *   address with a selection opened on a narrow screen does the same, once,
 *   after removing the selection from the list's entry.
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
  className?: string;
}) {
  const [selected, setSelected] = useSearchParam(param);
  const narrow = useMediaQuery(NARROW_WORKBENCH);
  const listRef = React.useRef<HTMLElement>(null);
  const detailRef = React.useRef<HTMLElement>(null);
  // The latest callback, so a page may pass it inline without re-running the effects.
  const openPageRef = React.useRef(onOpenPage);
  React.useLayoutEffect(() => {
    openPageRef.current = onOpenPage;
  });

  // A click selects with a new history entry, so Back returns to the list as it was.
  const select = React.useCallback(
    (id: string) => (narrow ? onOpenPage(id) : setSelected(id)),
    [narrow, onOpenPage, setSelected],
  );

  // An address with a selection, opened on a narrow screen, shows the item's own page,
  // once: the list's entry loses the selection first, so Back returns to the list
  // rather than opening the page again. A window that narrows later leaves the list alone.
  const narrowOnArrival = React.useRef(narrow);
  const opened = React.useRef<string | undefined>(undefined);
  React.useEffect(() => {
    if (!narrowOnArrival.current || selected === undefined || opened.current === selected) return;
    opened.current = selected;
    setSelected(undefined, { replace: true });
    openPageRef.current(selected);
  }, [selected, setSelected]);

  // Keys move the selection, focus follows it, and the list's rows scroll to it.
  const focusRow = React.useCallback((id: string | undefined) => {
    const list = listRef.current;
    if (list === null) return;
    const row =
      id === undefined
        ? null
        : list.querySelector<HTMLElement>(`[data-workbench-id="${CSS.escape(id)}"]`);
    const target = row?.querySelector<HTMLElement>("a[href], button, [tabindex]") ?? row ?? list;
    target.focus({ preventScroll: true });
    (row ?? target).scrollIntoView?.({ block: "nearest" });
  }, []);
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
      listRef.current
        ?.querySelector(`[data-workbench-id="${CSS.escape(selected)}"]`)
        ?.scrollIntoView?.({ block: "nearest" });
    }
  }, [selected, focusRow]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (narrow || typingOrOverlay(event)) return;
      const index = selected === undefined ? -1 : ids.indexOf(selected);
      const pressed = event.key;
      if (pressed === "j" || pressed === "k") {
        if (ids.length === 0) return;
        event.preventDefault();
        const next =
          pressed === "j"
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
  }, [narrow, ids, selected, setSelected, action]);

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

  if (narrow) {
    return (
      <div data-slot="workbench" className={cn("min-h-0", className)}>
        {listPane}
      </div>
    );
  }

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      data-slot="workbench"
      className={cn("min-h-0", className)}
    >
      <ResizablePanel defaultSize="40%" minSize="25%" maxSize="65%">
        {listPane}
      </ResizablePanel>
      <ResizableHandle withHandle aria-label={`Resize the ${label.toLowerCase()} list`} />
      <ResizablePanel defaultSize="60%" minSize="35%">
        <section
          ref={detailRef}
          aria-label={`${label}, ${selected === undefined ? "summary" : "selected"}`}
          data-slot="workbench-detail"
          className="h-full min-h-0 overflow-y-auto"
        >
          {selected === undefined ? summary : renderDetail(selected)}
        </section>
      </ResizablePanel>
    </ResizablePanelGroup>
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
