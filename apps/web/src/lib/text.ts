/**
 * Count Unicode code points to match the API and PostgreSQL.
 * Surrogate pairs count once; emoji with multiple code points count each point.
 */
export const characters = (text: string) =>
  text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "_").length;

// Control characters are what the API refuses in a saved name.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/u;

/**
 * Match API rules: 1 to max characters after trimming, with no control characters.
 * Return null for valid names.
 */
export function nameProblem(name: string, what: string, max: number): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return `Name the ${what}.`;
  if (characters(trimmed) > max) return `A ${what}'s name has at most ${max} characters.`;
  if (CONTROL.test(trimmed)) return `A ${what}'s name cannot hold control characters.`;
  return null;
}
