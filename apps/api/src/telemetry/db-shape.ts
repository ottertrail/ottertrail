/**
 * MATERIALIZED spans columns let Databases pages read shapes without normalizing every statement
 * (migration 0003_database_call_columns; docs/telemetry.md, "Databases"). Changing these rules
 * requires a new migration to MODIFY COLUMN … MATERIALIZED and materialize existing rows again.
 */

/** First present attribute wins (docs/telemetry.md, "Databases"). */
export const ATTRIBUTES = {
  system: ["db.system.name", "db.system"],
  database: ["db.namespace", "db.name", "db.redis.database_index", "db.elasticsearch.cluster.name"],
  operation: ["db.operation.name", "db.operation"],
  collection: [
    "db.collection.name",
    "db.sql.table",
    "db.mongodb.collection",
    "db.cassandra.table",
    "db.cosmosdb.container",
  ],
  summary: ["db.query.summary"],
  text: ["db.query.text", "db.statement"],
} as const;

/** Display limit in characters; the ID hashes the full shape. */
export const MAX_SHAPE_CHARS = 1000;
/** Bounds rows written outside ingestion, which already caps attribute values at 4 KB. */
export const MAX_TEXT_CHARS = 4096;

/** Maps to db_shape_kind 1, 2, 3; 0 means no database call. */
export const SHAPE_KINDS = ["summary", "query", "operation"] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];

/** Includes numbered placeholders normalized to `$?`. */
const PLACEHOLDER = String.raw`(?:\$?\?|@\w+|:\w+)`;
/** Allows placeholders, unnested function calls, NULL, DEFAULT, TRUE, and FALSE. */
const ROW_VALUE = String.raw`(?:${PLACEHOLDER}|\w+ ?\([^()]*\)|(?i:null|default|true|false))`;
const ROW = String.raw`\( ?${ROW_VALUE}(?: ?, ?${ROW_VALUE})* ?\)`;
const IN_LIST = String.raw`\( ?${PLACEHOLDER}(?: ?, ?${PLACEHOLDER})* ?(?:\)|,? ?$)`;

/**
 * The regular expressions that normalize a query's text, in the order
 * they run, each replacing every match (docs/telemetry.md, "Databases").
 * ClickHouse runs them with RE2, which takes time linear in the text,
 * whatever the text holds: no backtracking, so a hostile text cannot make
 * one slow. Only step 1 has a capture group: with one, RE2 finds each
 * match's groups with a slower engine, so the others have none.
 *
 * 1. String literals become `?`, and each comment is kept with `?` after
 *    it, for step 2. One expression finds both, leftmost first, so a quote
 *    inside a comment (`-- don't`, a `traceparent='…'` tag) starts no
 *    string, and a `--` or `/*` inside a string starts no comment. A
 *    string may hold `''` or a backslash before any character (so a
 *    string that ends in a backslash runs on to the next quote); an
 *    unclosed one runs to the end.
 * 2. Comments (`-- …` to the line's end, `/* … *\/`, an unclosed one to
 *    the end), with step 1's `?`, become a space.
 * 3. Numbers (whole, decimal, with an exponent, or hexadecimal) become
 *    `?`, but not digits inside a name (`table2`, `col_1`, `@p1`). A
 *    numbered placeholder becomes `$?`.
 * 4. Each run of white space becomes one space.
 * 5. A list of placeholders after IN becomes `IN (?)`, however long, one
 *    cut off at the end of the text too.
 * 6. The same after `in`: each keeps the case it was written in.
 * 7. Rows of placeholders and function calls after a first, such as the
 *    rows after VALUES, are dropped: `VALUES (?, now()), (?, now())`
 *    becomes `VALUES (?, now())`.
 */
export const NORMALIZE_STEPS: readonly { pattern: string; replacement: string }[] = [
  {
    pattern: String.raw`(--[^\n]*|/\*(?s:.)*?(?:\*/|$))|'(?:[^'\\]|''|\\(?s:.))*(?:'|$)`,
    replacement: String.raw`\1?`,
  },
  { pattern: String.raw`--[^\n]*|/\*(?s:.)*?(?:\*/\?|$)`, replacement: " " },
  {
    pattern: String.raw`\b(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b`,
    replacement: "?",
  },
  { pattern: String.raw`\s{2,}|[\t\n\v\f\r]`, replacement: " " },
  { pattern: String.raw`\bIN ?${IN_LIST}`, replacement: "IN (?)" },
  { pattern: String.raw`\bin ?${IN_LIST}`, replacement: "in (?)" },
  { pattern: String.raw`\)(?: ?, ?${ROW})+`, replacement: ")" },
];

export const sqlString = (text: string) =>
  `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

/** Names are constants. */
const attributeValue = (name: string) => `attributes[${sqlString(name)}]`;

function firstAttribute(names: readonly string[]): string {
  const value = attributeValue;
  const last = names.at(-1);
  if (last === undefined) throw new Error("no attribute names");
  const tests = names.slice(0, -1).map((name) => `${value(name)} != '', ${value(name)}`);
  return tests.length === 0 ? value(last) : `multiIf(${tests.join(", ")}, ${value(last)})`;
}

/** Normalizes at most MAX_TEXT_CHARS of input and trims the result. */
export function normalizedText(text: string): string {
  let sql = `substringUTF8(${text}, 1, ${MAX_TEXT_CHARS})`;
  for (const step of NORMALIZE_STEPS) {
    sql = `replaceRegexpAll(${sql}, ${sqlString(step.pattern)}, ${sqlString(step.replacement)})`;
  }
  return `trimBoth(${sql})`;
}

/**
 * Avoid conditional branches around regexes: ClickHouse copies lazy branch inputs, and 100,000
 * texts of 4 KB exceeded 300 MB. Normalize empty text when a summary exists; use arithmetic to
 * give non-database spans '' and 0.
 *
 * db_shape_kind: 1 summary, 2 query, 3 operation and collection (or span name), 0 no call.
 * db_shape is capped at MAX_SHAPE_CHARS. db_shape_id hashes system, database, kind, and the full
 * shape so differences past the display limit remain distinct.
 */
export function databaseCallColumns(): string[] {
  const summary = firstAttribute(ATTRIBUTES.summary);
  const text = firstAttribute(ATTRIBUTES.text);
  const fallback = `trimBoth(concat(${firstAttribute(ATTRIBUTES.operation)}, ' ', ${firstAttribute(ATTRIBUTES.collection)}))`;
  const normalized = normalizedText(`if(${summary} = '', ${text}, '')`);
  const whole = `coalesce(nullIf(${summary}, ''), nullIf(${normalized}, ''), nullIf(${fallback}, ''), toString(name))`;
  return [
    `db_system LowCardinality(String) MATERIALIZED if(kind = 'client', ${firstAttribute(ATTRIBUTES.system)}, '')`,
    `db_namespace String MATERIALIZED if(db_system = '', '', ${firstAttribute(ATTRIBUTES.database)})`,
    `db_shape_kind UInt8 MATERIALIZED (db_system != '') * multiIf(${summary} != '', 1, ${text} != '', 2, 3)`,
    `db_shape String MATERIALIZED substringUTF8(${whole}, 1, if(db_system = '', 0, ${MAX_SHAPE_CHARS}))`,
    `db_shape_id UInt64 MATERIALIZED (db_system != '') * cityHash64(db_system, db_namespace, db_shape_kind, ${whole})`,
  ];
}

export const DATABASE_CALL_COLUMNS = [
  "db_system",
  "db_namespace",
  "db_shape_kind",
  "db_shape",
  "db_shape_id",
] as const;
