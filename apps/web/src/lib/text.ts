/**
 * Characters as the API and PostgreSQL count them: code points, so a
 * surrogate pair (most emoji) is one. Not graphemes: an emoji built of
 * several code points counts as several there too.
 */
export const characters = (text: string) =>
  text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "_").length;

// Control characters are what the API refuses in a saved name.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/u;

/**
 * Why the name of a saved thing (a goal, a funnel) would be refused, as the
 * API checks it: 1 to `max` characters after trimming, no control
 * characters. null when it would not be.
 */
export function nameProblem(name: string, what: string, max: number): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return `Name the ${what}.`;
  if (characters(trimmed) > max) return `A ${what}'s name has at most ${max} characters.`;
  if (CONTROL.test(trimmed)) return `A ${what}'s name cannot hold control characters.`;
  return null;
}
