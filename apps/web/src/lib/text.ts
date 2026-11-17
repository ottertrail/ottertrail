/**
 * Characters as the API and PostgreSQL count them: code points, so a
 * surrogate pair (most emoji) is one. Not graphemes: an emoji built of
 * several code points counts as several there too.
 */
export const characters = (text: string) =>
  text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "_").length;
