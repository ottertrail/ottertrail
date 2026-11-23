/** Assign the 8 chart colors in order without cycling. */
export const SLOTS = Array.from({ length: 8 }, (_, index) => `var(--chart-${index + 1})`);
export const OTHER_COLOR = "var(--ink-tertiary)";

/** Keep slots by value for the page lifetime (docs/design-system.md). Prefer unused slots so returning values keep their colors. Earlier visible keys win collisions. */
export function assignSlots(
  memory: Map<string, number>,
  keys: readonly string[],
  slots: number,
): Map<string, number> {
  const shown = new Map<string, number>();
  const taken = new Set<number>();
  for (const key of keys) {
    const slot = memory.get(key);
    if (slot !== undefined && !taken.has(slot)) {
      shown.set(key, slot);
      taken.add(slot);
    }
  }
  const remembered = new Set(memory.values());
  for (const key of keys) {
    if (shown.has(key)) continue;
    const free = Array.from({ length: slots }, (_, slot) => slot).filter(
      (slot) => !taken.has(slot),
    );
    const slot = free.find((candidate) => !remembered.has(candidate)) ?? free[0];
    if (slot === undefined) continue;
    shown.set(key, slot);
    taken.add(slot);
    memory.set(key, slot);
    remembered.add(slot);
  }
  return shown;
}
