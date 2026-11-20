import { cn } from "cn";
import * as React from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/*
 * Text cut off with an ellipsis shows its whole text in a tooltip, on hover
 * and on keyboard focus, and only while it is cut off. A stopgap, local to
 * the account work: a shared component is to replace the truncation across
 * the app, and these two then go.
 */

/** Whether the element, or a `TruncatedText` inside it, is cut off now. */
function isCutOff(element: Element | null): boolean {
  if (element === null) return false;
  const parts = [element, ...element.querySelectorAll("[data-slot=truncated-text]")];
  return parts.some((part) => part.scrollWidth > part.clientWidth);
}

/**
 * One line of text, cut off with an ellipsis where it does not fit. While
 * cut off, it shows its whole text in a tooltip, and takes a tab stop so a
 * keyboard reaches it; inside a control that takes focus itself (a button),
 * pass `focusable={false}` and wrap the control in `OverflowTooltip`.
 */
export function TruncatedText({
  children,
  className,
  focusable = true,
}: {
  children: string;
  className?: string;
  focusable?: boolean;
}) {
  const ref = React.useRef<HTMLButtonElement>(null);
  const [cut, setCut] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  React.useLayoutEffect(() => {
    const element = ref.current;
    // Measured again for a new text, which may fit where the old one did not.
    if (!focusable || element === null || children === "") return undefined;
    setCut(isCutOff(element));
    // Followed as its width changes, in the next frame: a change made inside
    // the observer's callback (the tab stop) would start another round of it.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setCut(isCutOff(element)));
    });
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [focusable, children]);
  const classes = cn("block min-w-0 truncate", className);
  if (!focusable) {
    return (
      <span data-slot="truncated-text" className={classes}>
        {children}
      </span>
    );
  }
  return (
    <Tooltip open={open && cut} onOpenChange={(next) => setOpen(next && isCutOff(ref.current))}>
      <TooltipTrigger
        ref={ref}
        render={<span />}
        data-slot="truncated-text"
        tabIndex={cut ? 0 : undefined}
        className={cn(
          classes,
          "outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring",
        )}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent className="break-all">{children}</TooltipContent>
    </Tooltip>
  );
}

/**
 * A tooltip on a control (`render`, such as a menu's button) that opens on
 * hover and focus only while a `TruncatedText` inside it is cut off, or
 * always while `always` (the collapsed sidebar, which shows no text).
 */
export function OverflowTooltip({
  render,
  children,
  content,
  always = false,
  side = "top",
}: {
  render: React.ReactElement;
  children: React.ReactNode;
  content: React.ReactNode;
  always?: boolean;
  side?: "top" | "right" | "bottom" | "left";
}) {
  const ref = React.useRef<HTMLButtonElement>(null);
  const [open, setOpen] = React.useState(false);
  return (
    <Tooltip
      open={open}
      onOpenChange={(next) => setOpen(next && (always || isCutOff(ref.current)))}
    >
      <TooltipTrigger ref={ref} render={render}>
        {children}
      </TooltipTrigger>
      <TooltipContent side={side} className="flex-col items-start gap-0.5 break-all">
        {content}
      </TooltipContent>
    </Tooltip>
  );
}
