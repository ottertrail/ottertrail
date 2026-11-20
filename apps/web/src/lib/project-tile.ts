/**
 * The colored tile with a project's initial (the workspace sidebar's
 * projects): its color comes from the project's ID, so a project keeps it
 * whatever its name or its place in a list (docs/design-system.md,
 * "Project tiles").
 *
 * Each tile is a chart slot or the brand, with the text token that keeps
 * 4.5:1 on it in each theme (tests/tokens.test.ts checks every pair). The
 * dark theme's chart steps all take the canvas's near-black; the light
 * theme's take ink or white. chart-1's light blue is left out: neither ink
 * (4.1:1) nor white (4.4:1) reaches 4.5:1 on it.
 */
export const PROJECT_TILES = [
  {
    fill: "chart-2",
    light: "ink",
    dark: "canvas",
    className: "bg-chart-2 text-ink dark:text-canvas",
  },
  {
    fill: "chart-3",
    light: "ink",
    dark: "canvas",
    className: "bg-chart-3 text-ink dark:text-canvas",
  },
  {
    fill: "chart-4",
    light: "ink",
    dark: "canvas",
    className: "bg-chart-4 text-ink dark:text-canvas",
  },
  {
    fill: "chart-5",
    light: "ink",
    dark: "canvas",
    className: "bg-chart-5 text-ink dark:text-canvas",
  },
  {
    fill: "chart-6",
    light: "primary-foreground",
    dark: "canvas",
    className: "bg-chart-6 text-primary-foreground dark:text-canvas",
  },
  {
    fill: "chart-7",
    light: "primary-foreground",
    dark: "canvas",
    className: "bg-chart-7 text-primary-foreground dark:text-canvas",
  },
  {
    fill: "chart-8",
    light: "ink",
    dark: "canvas",
    className: "bg-chart-8 text-ink dark:text-canvas",
  },
  {
    fill: "brand",
    light: "primary-foreground",
    dark: "primary-foreground",
    className: "bg-brand text-primary-foreground",
  },
] as const;

/** The tile of the project with this ID: the same one every time (FNV-1a over the ID). */
export function projectTile(projectId: string): (typeof PROJECT_TILES)[number] {
  let hash = 0x81_1c_9d_c5;
  for (let index = 0; index < projectId.length; index += 1) {
    hash ^= projectId.charCodeAt(index);
    hash = Math.imul(hash, 0x01_00_01_93);
  }
  // A tile always exists: the index is within the list.
  return PROJECT_TILES[(hash >>> 0) % PROJECT_TILES.length] ?? PROJECT_TILES[0];
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** A name's first character, as the tile shows it ("?" for a name without one). */
export function initialOf(name: string): string {
  const first = graphemes.segment(name.trim())[Symbol.iterator]().next();
  return first.done === true ? "?" : first.value.segment.toLocaleUpperCase();
}
