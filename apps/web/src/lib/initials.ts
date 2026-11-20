/** The first character a reader sees: a whole emoji or accented letter, not half of one. */
const firstCharacter = (text: string) =>
  new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)[Symbol.iterator]().next()
    .value?.segment ?? "";

/** "Ada Lovelace" is AL, "Ada" is A; with no name, the email's first letter. */
export function initialsOf(name: string, email = ""): string {
  const words = name
    .trim()
    .split(/\s+/u)
    .filter((word) => word !== "");
  const first = words[0];
  if (first === undefined) return firstCharacter(email).toLocaleUpperCase();
  const last = words.length > 1 ? words.at(-1) : undefined;
  return `${firstCharacter(first)}${last === undefined ? "" : firstCharacter(last)}`.toLocaleUpperCase();
}

/** A name's first character, as an instance's or project's square shows it ("?" for a name without one). */
export function initialOf(name: string): string {
  return firstCharacter(name.trim()).toLocaleUpperCase() || "?";
}
