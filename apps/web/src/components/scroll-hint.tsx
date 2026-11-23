import * as React from "react";

/**
 * Fade the edge to signal more columns. With PINNED_END, keep the fade inside the action column
 * so it covers only scrolling cells (pinned-column.ts).
 */
export function ScrollHint({
  children,
  disabled = false,
}: {
  children: React.ReactNode;
  /** No fade, such as for a table whose rows stack on a phone instead of scrolling. */
  disabled?: boolean;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [more, setMore] = React.useState(false);
  // The width of a column pinned at the end, which the fade stays clear of.
  const [endInset, setEndInset] = React.useState(0);

  React.useEffect(() => {
    const scroller = ref.current?.querySelector<HTMLElement>("[data-slot=table-container]");
    if (scroller === null || scroller === undefined) return undefined;
    const update = () => {
      setMore(scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1);
      const last = scroller.querySelector("tr > :last-child");
      const pinned =
        last instanceof HTMLElement &&
        getComputedStyle(last).position === "sticky" &&
        getComputedStyle(last).right === "0px";
      setEndInset(pinned ? last.offsetWidth : 0);
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, []);

  return (
    <div ref={ref} className="relative isolate min-w-0" data-more={more || undefined}>
      {children}
      {more && !disabled && (
        <div
          aria-hidden="true"
          data-slot="scroll-hint"
          className="pointer-events-none absolute inset-y-0 right-0 z-20 w-10 bg-gradient-to-l from-[var(--block-surface,var(--background))] to-transparent"
          style={endInset === 0 ? undefined : { right: endInset }}
        />
      )}
    </div>
  );
}
