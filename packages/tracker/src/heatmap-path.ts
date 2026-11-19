/**
 * Element keys, shared by capture (heatmap-capture.ts, h.js) and the
 * overlay (overlay-view.ts, o.js): describe() writes an element's key as
 * a click is recorded, and resolve() finds the element a key names on the
 * page the overlay draws over. resolve() only accepts an element whose
 * key, written by describe(), is the one asked for, so the two cannot
 * drift apart.
 *
 * A key is the element's structural path (standard tag names and their
 * places among siblings) from the nearest element the site named with
 * data-ottertrail-name, or from body, with that name. Nothing else about
 * the element is read: no text, values, IDs, classes, or other attributes.
 */
import { HEATMAP_TAGS } from "./heatmap-tags.ts";

/** A structural path's most steps and characters (the API's limits). */
export const MAX_STEPS = 24;
export const MAX_PATH_LENGTH = 512;
/** Device classes by viewport width: mobile under 768, tablet under 1024, desktop from it. */
export const TABLET_FROM_PX = 768;
export const DESKTOP_FROM_PX = 1024;

/** The site's own name for an element, as the API takes it. */
export const NAME_ATTRIBUTE = "data-ottertrail-name";
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,63}$/;
const TAGS: ReadonlySet<string> = new Set(HEATMAP_TAGS);
/** Marks a path cut to its nearest MAX_STEPS steps. */
const CUT = "*>";

export type Device = "mobile" | "tablet" | "desktop";

export function deviceOf(viewportWidth: number): Device {
  if (viewportWidth < TABLET_FROM_PX) return "mobile";
  return viewportWidth < DESKTOP_FROM_PX ? "tablet" : "desktop";
}

/** The element's own name from the site, if it is one the API takes. */
function nameOf(element: Element): string | undefined {
  const name = element.getAttribute(NAME_ATTRIBUTE)?.trim();
  return name !== undefined && NAME_PATTERN.test(name) ? name : undefined;
}

/** "div", or "div:3" for the third div among its siblings; "x" for a tag not in HEATMAP_TAGS. */
function stepOf(element: Element): string {
  const tag = element.tagName.toLowerCase();
  let place = 1;
  for (
    let sibling = element.previousElementSibling;
    sibling;
    sibling = sibling.previousElementSibling
  ) {
    if (sibling.tagName === element.tagName) place += 1;
  }
  return `${TAGS.has(tag) ? tag : "x"}${place > 1 ? `:${Math.min(place, 9999)}` : ""}`;
}

/**
 * Where a click went: the element's structural path from the nearest
 * element the site named (data-ottertrail-name), or from body, and that
 * name. At most 24 steps, the nearest kept, "*>" first when cut.
 */
export function describe(element: Element): { element: string; label?: string } {
  const steps: string[] = [];
  let label: string | undefined;
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    steps.unshift(stepOf(node));
    label = nameOf(node);
    if (label !== undefined || node.tagName === "BODY") break;
  }
  let cut = steps.length > MAX_STEPS;
  let kept = steps.slice(-MAX_STEPS);
  while (kept.join(">").length > MAX_PATH_LENGTH - 2) {
    kept = kept.slice(1);
    cut = true;
  }
  const path = `${cut ? CUT : ""}${kept.join(">")}`;
  return label === undefined ? { element: path } : { element: path, label };
}

/**
 * The element of this page whose key is `label` (or none) and `path`, or
 * null when there is none. Walks down from the named elements, from body,
 * or, for a cut path, from every element of its first step's tag, taking
 * at each level the children whose step is the next one; the first element
 * whose own key is exactly the one asked for is the answer.
 */
export function resolve(doc: Document, label: string | null, path: string): Element | null {
  const cut = path.startsWith(CUT);
  const steps = (cut ? path.slice(CUT.length) : path).split(">");
  const first = steps[0] ?? "";
  const tag = first.split(":")[0] ?? "";
  let starts: Iterable<Element>;
  if (label !== null) {
    starts = [...doc.querySelectorAll(`[${NAME_ATTRIBUTE}]`)].filter(
      (element) => nameOf(element) === label,
    );
  } else if (cut) {
    starts = doc.querySelectorAll(tag === "x" || !TAGS.has(tag) ? "*" : tag);
  } else {
    starts = doc.body === null ? [] : [doc.body];
  }
  const matches = (element: Element) => {
    const key = describe(element);
    return key.element === path && (key.label ?? null) === label;
  };
  const walk = (node: Element, index: number): Element | null => {
    if (index === steps.length) return matches(node) ? node : null;
    for (const child of node.children) {
      if (stepOf(child) === steps[index]) {
        const found = walk(child, index + 1);
        if (found !== null) return found;
      }
    }
    return null;
  };
  for (const start of starts) {
    if (stepOf(start) === first) {
      const found = walk(start, 1);
      if (found !== null) return found;
    }
  }
  return null;
}
