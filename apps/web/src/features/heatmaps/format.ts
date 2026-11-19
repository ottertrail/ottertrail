import { MISSING } from "@/lib/missing";

/** How many of an element's last steps a table shows when the site gave it no name. */
const SHOWN_STEPS = 3;

/**
 * How a table names a clicked element: the site's own name
 * (`data-ottertrail-name`) when it has one, otherwise the last steps of its
 * structural path, "… > " first when steps were left out ("*>" means the
 * tracker already cut the path at 24 steps).
 */
export function elementName(label: string | null, element: string): string {
  if (label !== null) return label;
  const steps = element.split(">");
  const cut = steps[0] === "*";
  const own = cut ? steps.slice(1) : steps;
  const shown = own.slice(-SHOWN_STEPS);
  return `${cut || own.length > SHOWN_STEPS ? "… > " : ""}${shown.join(" > ")}`;
}

/** The full text for a name's hover title: the name and the whole path. */
export function elementTitle(label: string | null, element: string): string {
  return label === null ? element : `${label} (${element})`;
}

/** A share from 0 to 1 in whole percent; "<1%" for one too small to round up to 1%. */
export function formatShare(value: number | null): string {
  if (value === null) return MISSING;
  if (value > 0 && value < 0.005) return "<1%";
  return `${Math.round(value * 100)}%`;
}

/** Where in an element clicks fell on average: "48% across, 30% down". */
export function formatPosition(x: number, y: number): string {
  return `${Math.round(x * 100)}% across, ${Math.round(y * 100)}% down`;
}
