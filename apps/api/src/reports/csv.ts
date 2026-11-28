/*
 * CSV files of the Web analytics reports (docs/web-analytics.md, "CSV
 * export"): RFC 4180, UTF-8, a header row, CRLF line ends.
 */

/** A cell: text, a number, true or false, or nothing (an empty cell). */
export type CsvCell = string | number | boolean | null;

/**
 * Leading characters that make a spreadsheet read a cell as a formula,
 * after OWASP's "CSV Injection" page: = + - @, tab, carriage return, line
 * feed, and the full-width = + - @.
 */
const FORMULA_START = /^[=+\-@\t\r\n\uFF1D\uFF0B\uFF0D\uFF20]/u;

/**
 * One text cell: a leading quote when it would start a formula, then
 * quoted, with its double quotes doubled. Every text cell is quoted, so a
 * comma, a semicolon, or a line break inside it stays in it.
 */
export function csvText(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

function csvCell(value: CsvCell): string {
  if (value === null) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return csvText(value);
}

/** The header row and the rows, each line ended by CRLF. */
export function csvLines(header: readonly string[], rows: Iterable<readonly CsvCell[]>): string {
  const lines = [header.map(csvText).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

/** Lower case, letters and digits kept, every other run of characters one hyphen. */
function slug(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");
}

/**
 * A file's name, from its parts, such as `demo-shop-pages-2026-11-01-to-2026-11-28.csv`.
 * A project named without letters or digits is "project".
 */
export function csvFileName(
  project: string,
  what: string,
  { firstDay, lastDay }: { firstDay: string; lastDay: string },
  suffix?: string,
): string {
  const days = firstDay === lastDay ? firstDay : `${firstDay}-to-${lastDay}`;
  const parts = [slug(project) || "project", slug(what), days, suffix].filter(
    (part): part is string => part !== undefined && part !== "",
  );
  return `${parts.join("-")}.csv`;
}

/**
 * The Content-Disposition of a download (RFC 6266): the name as UTF-8 in
 * `filename*`, and an ASCII copy for clients that read only `filename`.
 */
export function attachment(fileName: string): string {
  const ascii =
    fileName
      .replaceAll(/[^\x20-\x7E]|["\\]/gu, "")
      .replaceAll(/^-+/gu, "")
      .replace(/^\.csv$/u, "") || "export.csv";
  const encoded = encodeURIComponent(fileName).replaceAll(
    /['()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
