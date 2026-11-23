import { MISSING } from "@/lib/missing";

const SHOWN_STEPS = 3;

/** Prefer data-ottertrail-name; otherwise show the path tail. "*>" marks a path the tracker truncated at 24 steps. */
export function elementName(label: string | null, element: string): string {
  if (label !== null) return label;
  const steps = element.split(">");
  const cut = steps[0] === "*";
  const own = cut ? steps.slice(1) : steps;
  const shown = own.slice(-SHOWN_STEPS);
  return `${cut || own.length > SHOWN_STEPS ? "… > " : ""}${shown.join(" > ")}`;
}

export function elementTitle(label: string | null, element: string): string {
  return label === null ? element : `${label} (${element})`;
}

/** A share from 0 to 1 in whole percent; "<1%" for one too small to round up to 1%. */
export function formatShare(value: number | null): string {
  if (value === null) return MISSING;
  if (value > 0 && value < 0.005) return "<1%";
  return `${Math.round(value * 100)}%`;
}

export function formatPosition(x: number, y: number): string {
  return `${Math.round(x * 100)}% across, ${Math.round(y * 100)}% down`;
}

export function formatSavedAt(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(new Date(iso));
}
