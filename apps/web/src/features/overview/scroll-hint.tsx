import * as React from "react";

/**
 * A table that scrolls sideways inside its widget, as on a phone, with a
 * fade at the edge where more columns wait, so a cut-off column reads as
 * "scroll for more". The fade goes when the table fits or is scrolled to
 * that end. The table's first column stays pinned (widgets.tsx).
 */
export function ScrollHint({ children }: { children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [more, setMore] = React.useState(false);

  React.useEffect(() => {
    const scroller = ref.current?.querySelector<HTMLElement>("[data-slot=table-container]");
    if (scroller === null || scroller === undefined) return undefined;
    const update = () =>
      setMore(scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1);
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
    <div ref={ref} className="relative min-w-0" data-more={more || undefined}>
      {children}
      {more && (
        <div
          aria-hidden="true"
          data-slot="scroll-hint"
          className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-[var(--block-surface,var(--background))] to-transparent"
        />
      )}
    </div>
  );
}
