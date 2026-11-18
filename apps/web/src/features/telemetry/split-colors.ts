/**
 * Chart color slots for a split chart's lines, kept while the page is
 * open: a value keeps the slot it first got when the set of values shown
 * changes (another period, another measure), so a color always means the
 * same value (design system, "Color follows the entity, not its rank").
 *
 * `memory` maps each line's key to its slot and lives as long as the page;
 * `keys` are the lines shown now. A key seen before keeps its slot unless a
 * line shown before it in `keys` already holds it; a new key takes the
 * lowest slot no line shown holds, one never given out first, so it does
 * not take a color a value seen earlier may come back to.
 */
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
