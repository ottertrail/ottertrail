import { cn } from "cn";
import * as React from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * One line of text that an ellipsis may cut off (a name, an email, an
 * access summary). Only while it is cut off (its scroll width is past its
 * width), its whole text shows in a tooltip on hover and on keyboard focus:
 * a plain span then takes a tab stop, and a control given as `render` (a
 * button) is focusable already. Not cut off, it is the plain element.
 *
 * Local to the Members page for now: a shared component is to replace it.
 */
export function TruncatedText({
  text,
  className,
  render,
}: {
  /** The whole text, for the tooltip. */
  text: string;
  className?: string;
  /** The element to render, such as a button; a span when left out. */
  render?: React.ReactElement<Record<string, unknown>>;
}) {
  const ref = React.useRef<HTMLButtonElement>(null);
  const [cut, setCut] = React.useState(false);
  const measure = React.useCallback(() => {
    const element = ref.current;
    if (element !== null) setCut(element.scrollWidth > element.clientWidth);
  }, []);
  // After every render, since new text can cut off without changing the element's size.
  React.useLayoutEffect(measure);
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure]);
  // Cut off, the text takes a tab stop of its own, so the tooltip also shows on keyboard focus.
  // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
  const span = <span tabIndex={cut ? 0 : undefined} />;
  return (
    <Tooltip disabled={!cut}>
      <TooltipTrigger
        ref={ref}
        render={render ?? span}
        className={cn("block min-w-0 truncate", className)}
      >
        {text}
      </TooltipTrigger>
      {cut && <TooltipContent className="[overflow-wrap:anywhere]">{text}</TooltipContent>}
    </Tooltip>
  );
}
