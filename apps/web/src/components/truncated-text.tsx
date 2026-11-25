import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { cn } from "cn";
import * as React from "react";

import { Tooltip, TooltipContent } from "@/components/ui/tooltip";

/**
 * Show full text on hover or focus only when truncated (docs/design-system.md, "Truncated text").
 * Reuse a containing or rendered control as the trigger; otherwise add a tab stop.
 * Tooltips do not open on tap, so the item page must also show the full text.
 * Share one ResizeObserver. Measure on mount, entry, focus, size changes, or text changes.
 */
export function TruncatedText(props: TruncatedTextProps) {
  // Inside an OverflowTooltip, the control's own tooltip shows the text.
  if (React.useContext(InsideOverflowTooltip)) {
    const { text, children, className, render } = props;
    const element = render ?? <span />;
    const own = { "data-truncated-text": "", className: cn("block min-w-0 truncate", className) };
    return element.props.children === undefined
      ? React.cloneElement(element, own, children ?? text)
      : React.cloneElement(element, own);
  }
  return <TooltipText {...props} />;
}

interface TruncatedTextProps {
  text: string;
  lines?: readonly string[];
  /** What shows instead of `text`, such as a type in bold before its message. */
  children?: React.ReactNode;
  /** A `line-clamp-*` class clamps to that many lines instead of one. */
  className?: string;
  /**
   * Defaults to span. The rendered element's own children override children and text,
   * so headings can supply text for the empty-heading lint rule.
   */
  render?: React.ReactElement<Record<string, unknown>>;
  /** Show the tooltip even without overflow when the displayed text is deliberately shortened. */
  shortened?: boolean | undefined;
  side?: "top" | "bottom";
}

function TooltipText({
  text,
  lines,
  children,
  className,
  render,
  shortened = false,
  side = "top",
}: TruncatedTextProps) {
  const ref = React.useRef<HTMLButtonElement>(null);
  const clamp = className !== undefined && /(^|\s)line-clamp-/.test(className);
  const [cut, setCut] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  /** The link or button the text is in (or holds), whose hover and focus open the tooltip. */
  const [host, setHost] = React.useState<HTMLElement | null>(null);
  const [control, setControl] = React.useState(false);

  const measure = React.useCallback(() => {
    const element = ref.current;
    if (element === null) return false;
    const now =
      shortened ||
      element.scrollWidth > element.clientWidth ||
      (clamp && element.scrollHeight > element.clientHeight);
    setCut(now);
    if (!now) setOpen(false);
    return now;
  }, [clamp, shortened]);

  // Measure before paint so truncated text immediately has its tab stop.
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    measure();
    setControl(element.matches(CONTROL));
    setHost(
      element.parentElement?.closest<HTMLElement>(CONTROL) ??
        element.querySelector<HTMLElement>(CONTROL),
    );
    return observeSize(element, measure);
  }, [measure]);
  // New text can cut off, or fit, with no change to the element's size.
  const measuredText = React.useRef(text);
  React.useLayoutEffect(() => {
    if (measuredText.current === text) return;
    measuredText.current = text;
    measure();
  }, [text, measure]);

  const timer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  const popup = React.useRef<HTMLDivElement>(null);
  /**
   * Closes after CLOSE_DELAY unless the pointer is then on `over`: the
   * tooltip, after leaving the control, or the control, after leaving the
   * tooltip. Checked when the delay ends, not by cancelling on enter: the
   * tooltip's enter can come before the control's leave, as when the
   * tooltip slides in under a still pointer.
   */
  const closeUnlessOn = React.useCallback((over: () => Element | null) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (over()?.matches(":hover") !== true) setOpen(false);
    }, CLOSE_DELAY);
  }, []);
  React.useEffect(() => {
    if (host === null) return undefined;
    const later = (action: () => void, ms: number) => {
      clearTimeout(timer.current);
      timer.current = setTimeout(action, ms);
    };
    const enter = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      later(() => {
        if (measure()) setOpen(true);
      }, OPEN_DELAY);
    };
    const leave = () => closeUnlessOn(() => popup.current);
    const focus = () => {
      if (host.matches(":focus-visible") && measure()) setOpen(true);
    };
    const blur = () => {
      clearTimeout(timer.current);
      setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    host.addEventListener("pointerenter", enter);
    host.addEventListener("pointerleave", leave);
    host.addEventListener("focus", focus);
    host.addEventListener("blur", blur);
    host.addEventListener("keydown", key);
    return () => {
      clearTimeout(timer.current);
      host.removeEventListener("pointerenter", enter);
      host.removeEventListener("pointerleave", leave);
      host.removeEventListener("focus", focus);
      host.removeEventListener("blur", blur);
      host.removeEventListener("keydown", key);
    };
  }, [host, measure, closeUnlessOn]);

  const nested = host !== null;
  // Cut off, plain text takes a tab stop, so the tooltip also shows on keyboard focus.
  const tabStop = cut && !nested && !control ? 0 : undefined;
  // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
  const span = <span tabIndex={tabStop} />;
  const element =
    render === undefined
      ? span
      : tabStop === undefined
        ? render
        : React.cloneElement(render, { tabIndex: tabStop });
  return (
    <Tooltip
      open={open}
      onOpenChange={(next) => {
        // Escape also reaches the page (components/ui/tooltip.tsx).
        if (!next) setOpen(false);
        else if (!nested && measure()) setOpen(true);
      }}
    >
      <TooltipPrimitive.Trigger
        ref={ref}
        render={element}
        delay={OPEN_DELAY}
        disabled={nested}
        // Avoid data-slot, which would remove the global focus ring from links and buttons.
        data-truncated-text=""
        className={cn(clamp ? "min-w-0" : "block min-w-0 truncate", className)}
      >
        {children ?? text}
      </TooltipPrimitive.Trigger>
      {cut && (
        <TooltipContent
          ref={popup}
          side={side}
          anchor={ref}
          className="max-w-sm [overflow-wrap:anywhere] whitespace-pre-line"
          // Inside a control, the pointer may move onto the tooltip without closing it.
          onPointerEnter={nested ? () => clearTimeout(timer.current) : undefined}
          onPointerLeave={nested ? () => closeUnlessOn(() => host) : undefined}
        >
          {/*
           * Scroll inside this wrapper. Scrolling the tooltip itself lets its arrow overflow,
           * causing macOS to flash a scrollbar.
           */}
          <div
            data-slot="tooltip-scroll"
            className="max-h-[min(20rem,50vh)] min-w-0 overflow-y-auto"
          >
            {lines === undefined ? (
              text
            ) : (
              <span className="flex flex-col">
                {lines.map((line) => (
                  <span key={line}>{line}</span>
                ))}
              </span>
            )}
          </div>
        </TooltipContent>
      )}
    </Tooltip>
  );
}

const CONTROL = "a[href], button, summary, [role=button], [role=link]";
/** Before the tooltip opens on hover, so moving across a long list shows none. */
const OPEN_DELAY = 300;
/** Long enough to move the pointer onto the tooltip. */
const CLOSE_DELAY = 100;

/** One observer for every truncated text on the page, each with its own callback. */
let observer: ResizeObserver | undefined;
const callbacks = new WeakMap<Element, () => void>();
function observeSize(element: Element, callback: () => void) {
  observer ??= new ResizeObserver((entries) => {
    for (const entry of entries) callbacks.get(entry.target)?.();
  });
  callbacks.set(element, callback);
  observer.observe(element);
  return () => {
    observer?.unobserve(element);
    callbacks.delete(element);
  };
}

/** Set inside an OverflowTooltip: the TruncatedTexts in its control show no tooltip of their own. */
const InsideOverflowTooltip = React.createContext(false);

function anyCutOff(element: Element | null): boolean {
  if (element === null) return false;
  const parts = [element, ...element.querySelectorAll("[data-truncated-text]")];
  return parts.some((part) => part.scrollWidth > part.clientWidth);
}

/**
 * Share one tooltip across the control's TruncatedTexts. Open when any text is cut off,
 * or unconditionally when `always` is set. Suppress the inner tooltips.
 */
export function OverflowTooltip({
  render,
  children,
  content,
  always = false,
  side = "top",
}: {
  /** Supply a control with no children of its own. */
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
      onOpenChange={(next, details) => {
        if (details.reason === "escape-key") {
          details.cancel();
          details.allowPropagation();
        }
        setOpen(next && (always || anyCutOff(ref.current)));
      }}
    >
      <TooltipPrimitive.Trigger ref={ref} render={render} delay={OPEN_DELAY}>
        <InsideOverflowTooltip.Provider value>{children}</InsideOverflowTooltip.Provider>
      </TooltipPrimitive.Trigger>
      <TooltipContent
        side={side}
        className="max-w-sm flex-col items-start gap-0.5 [overflow-wrap:anywhere]"
      >
        {content}
      </TooltipContent>
    </Tooltip>
  );
}
