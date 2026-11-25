import type { KeyHintItem } from "@/components/workbench";
import { MAX_FUNNEL_NAME, type SavedFunnel } from "@/lib/funnels-api";

/**
 * "<name> copy", or "<name> copy 2", 3 … when taken: a name no saved funnel
 * has, cut to the longest name allowed.
 */
export function copyName(name: string, funnels: readonly Pick<SavedFunnel, "name">[]): string {
  const taken = new Set(funnels.map((funnel) => funnel.name.trim().toLowerCase()));
  for (let number = 1; ; number += 1) {
    const suffix = number === 1 ? " copy" : ` copy ${number}`;
    // Count characters as the API does, not UTF-16 units.
    const base = Array.from(name.trim())
      .slice(0, MAX_FUNNEL_NAME - suffix.length)
      .join("");
    const candidate = `${base}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** The keys the saved funnels list answers to, for the filter bar's hints. */
export const SAVED_FUNNEL_KEYS: KeyHintItem[] = [
  { keys: ["j", "k"], text: "move" },
  { keys: ["Enter", "o"], text: "open" },
  { keys: ["Esc"], text: "clear" },
];
