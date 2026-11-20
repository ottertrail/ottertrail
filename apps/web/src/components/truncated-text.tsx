import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { cn } from "cn";
import * as React from "react";

import { Tooltip, TooltipContent } from "@/components/ui/tooltip";

/**
 * Text an ellipsis may cut off: one line (`truncate`), or a few with a
 * `line-clamp-*` class. Only while it is cut off, its whole text shows in
 * a tooltip on hover and on keyboard focus (docs/design-system.md,
 * "Truncated text"). Tooltips do not open on a tap, so on a phone the
 * whole text must be on the item's own page too.
 *
 * Where it is:
 * - **The control itself** (`render` a link or a button): the control is
 *   the trigger, with no tab stop of its own added.
 * - **Inside a link or a button** (a row's link holding a name and a
 *   detail), or around one (a trace ID's link): the tooltip opens when
 *   that control is hovered or focused, anchored to the text, again with
 *   no tab stop added.
 * - **Anywhere else:** cut off, the text takes a tab stop, so the
 *   keyboard reaches its tooltip.
 *
 * Cheap in long tables: one ResizeObserver for every instance, and the
 * text is measured when it mounts, when it is entered or focused, when its
 * size changes, and when its text changes, never on each render.
 */
export function TruncatedText(props: TruncatedTextProps) {
  // Inside an OverflowTooltip, the control's own tooltip shows the text.
  if (React.useContext(InsideOverflowTooltip)) {
    const { text, children, className, render } = props;
    const element = render ?? <span />;
    const own = { "data-truncated-text": "", className: cn("block min-w-0 truncate", className) };
    // An element's own children (a heading's text) stay, as with the tooltip.
    return element.props.children === undefined
      ? React.cloneElement(element, own, children ?? text)
      : React.cloneElement(element, own);
  }
  return <TooltipText {...props} />;
}

interface TruncatedTextProps {
  /** The whole text: shown, and in the tooltip. */
  text: string;
  /** The tooltip's text one item per line instead (hostnames, services). */
  lines?: readonly string[];
  /** What shows instead of `text`, such as a type in bold before its message. */
  children?: React.ReactNode;
  /** A `line-clamp-*` class clamps to that many lines instead of one. */
  className?: string;
  /**
   * The element to render (a link, a button, a heading); a span when left
   * out. Children it has of its own show instead of `children` and `text`
   * (a heading holds its text, for the lint rule on empty headings).
   */
  render?: React.ReactElement<Record<string, unknown>>;
  /**
   * The shown text leaves part of `text` out on purpose (an element's last
   * steps): the tooltip shows even when nothing is cut off.
   */
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
  /** Whether the element is a link or a button itself. */
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

  // Once: where the text is, whether it is cut off before the first paint (its tab
  // stop then shows at once), and one observer entry for its size.
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

  // Inside a link or a button: its hover and keyboard focus open the tooltip.
  const timer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
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
    const leave = () => later(() => setOpen(false), CLOSE_DELAY);
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
  }, [host, measure]);

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
      onOpenChange={(next, details) => {
        if (details.reason === "escape-key") {
          // Escape closes the tooltip and still reaches the page (a workbench's Escape
          // clears its selection): a tooltip is a hint, never a layer of its own.
          details.cancel();
          details.allowPropagation();
        }
        if (!next) setOpen(false);
        else if (!nested && measure()) setOpen(true);
      }}
    >
      <TooltipPrimitive.Trigger
        ref={ref}
        render={element}
        delay={OPEN_DELAY}
        disabled={nested}
        // Not a data-slot: that would take the global focus ring off a link or button.
        data-truncated-text=""
        className={cn(clamp ? "min-w-0" : "block min-w-0 truncate", className)}
      >
        {children ?? text}
      </TooltipPrimitive.Trigger>
      {cut && (
        <TooltipContent
          side={side}
          anchor={ref}
          className="max-h-[min(20rem,50vh)] max-w-sm overflow-y-auto [overflow-wrap:anywhere] whitespace-pre-line"
          // Inside a control, the pointer may move onto the tooltip without closing it.
          onPointerEnter={nested ? () => clearTimeout(timer.current) : undefined}
          onPointerLeave={nested ? () => setOpen(false) : undefined}
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
        </TooltipContent>
      )}
    </Tooltip>
  );
}

/** A link or a button: the element whose hover and focus open the tooltip. */
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

/** Whether the element, or a TruncatedText inside it, is cut off now. */
function anyCutOff(element: Element | null): boolean {
  if (element === null) return false;
  const parts = [element, ...element.querySelectorAll("[data-truncated-text]")];
  return parts.some((part) => part.scrollWidth > part.clientWidth);
}

/**
 * One tooltip for a control holding several TruncatedTexts (the sidebar's
 * user button: a name over an email): it opens on the control's hover and
 * focus while any of them is cut off, or always while `always` (the
 * collapsed sidebar, which shows no text), with `content` in it. The texts
 * inside show no tooltip of their own.
 */
export function OverflowTooltip({
  render,
  children,
  content,
  always = false,
  side = "top",
}: {
  /** The control, with no children of its own. */
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
