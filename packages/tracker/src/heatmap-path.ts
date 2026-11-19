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

/** describe(), with the step of each element from `step`. */
function keyWith(
  element: Element,
  step: (element: Element) => string,
): { element: string; label?: string } {
  const steps: string[] = [];
  let label: string | undefined;
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    steps.unshift(step(node));
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
 * Where a click went: the element's structural path from the nearest
 * element the site named (data-ottertrail-name), or from body, and that
 * name. At most 24 steps, the nearest kept, "*>" first when cut.
 */
export function describe(element: Element): { element: string; label?: string } {
  return keyWith(element, stepOf);
}

/** The most elements resolveKeys() looks at in one pass, for every key together. */
export const RESOLVE_BUDGET = 50_000;

/** A key as the API names an element. */
export interface ElementKey {
  label: string | null;
  element: string;
}

/**
 * The elements of this page whose keys are `keys`, in order, or null for
 * each one not found. Keys come from visitors' pages, so a pass is
 * bounded: it looks at RESOLVE_BUDGET elements at most, and keys past that
 * count as not found. Each element's step is worked out once per pass,
 * with its siblings'. A key is matched from the named elements or body
 * downward; a cut key ("*>…") from the elements of its last step upward.
 * An element is accepted only when its own key, written as describe()
 * writes it, is the one asked for.
 */
export function resolveKeys(
  doc: Document,
  keys: readonly ElementKey[],
  budget = RESOLVE_BUDGET,
): (Element | null)[] {
  let left = budget;
  const steps = new Map<Element, string>();
  const step = (element: Element): string => {
    const known = steps.get(element);
    if (known !== undefined) return known;
    // Every sibling's step in one walk over them.
    const siblings = element.parentElement?.children ?? [element];
    const seen = new Map<string, number>();
    for (const sibling of siblings) {
      left -= 1;
      const place = (seen.get(sibling.tagName) ?? 0) + 1;
      seen.set(sibling.tagName, place);
      const tag = sibling.tagName.toLowerCase();
      steps.set(
        sibling,
        `${TAGS.has(tag) ? tag : "x"}${place > 1 ? `:${Math.min(place, 9999)}` : ""}`,
      );
    }
    return steps.get(element) ?? "";
  };
  const lists = new Map<string, Element[]>();
  const all = (selector: string): Element[] => {
    let list = lists.get(selector);
    if (list === undefined) {
      list = [...doc.querySelectorAll(selector)];
      left -= list.length;
      lists.set(selector, list);
    }
    return list;
  };
  const accepts = (element: Element, key: ElementKey) => {
    const written = keyWith(element, step);
    left -= MAX_STEPS;
    return written.element === key.element && (written.label ?? null) === key.label;
  };

  const one = (key: ElementKey): Element | null => {
    const cut = key.element.startsWith(CUT);
    const parts = (cut ? key.element.slice(CUT.length) : key.element).split(">");
    if (cut) {
      // From the last step upward: the elements of its tag, then their ancestors.
      const last = parts[parts.length - 1] ?? "";
      const tag = last.split(":")[0] ?? "";
      for (const candidate of all(tag === "x" || !TAGS.has(tag) ? "*" : tag)) {
        if (left <= 0) return null;
        if (step(candidate) !== last) continue;
        let node = candidate.parentElement;
        let index = parts.length - 2;
        while (index >= 0 && node !== null && step(node) === parts[index]) {
          node = node.parentElement;
          index -= 1;
        }
        if (index < 0 && accepts(candidate, key)) return candidate;
      }
      return null;
    }
    const starts =
      key.label === null
        ? doc.body === null
          ? []
          : [doc.body]
        : all(`[${NAME_ATTRIBUTE}]`).filter((element) => nameOf(element) === key.label);
    const walk = (node: Element, index: number): Element | null => {
      if (index === parts.length) return accepts(node, key) ? node : null;
      for (const child of node.children) {
        if (left <= 0) return null;
        if (step(child) === parts[index]) {
          const found = walk(child, index + 1);
          if (found !== null) return found;
        }
      }
      return null;
    };
    for (const start of starts) {
      if (left <= 0) return null;
      if (step(start) === parts[0]) {
        const found = walk(start, 1);
        if (found !== null) return found;
      }
    }
    return null;
  };

  return keys.map((key) => (left <= 0 ? null : one(key)));
}

/** The element of this page whose key is `label` (or none) and `path`, or null (resolveKeys). */
export function resolve(doc: Document, label: string | null, path: string): Element | null {
  return resolveKeys(doc, [{ label, element: path }])[0] ?? null;
}
