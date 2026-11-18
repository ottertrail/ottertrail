/**
 * A database call's system, database, and query shape, worked out by
 * ClickHouse when a span is written: MATERIALIZED columns of `spans`
 * (migration 0003_database_call_columns), as metrics' `series` is, so the
 * Databases pages read small columns instead of normalizing every
 * statement of a period (docs/telemetry.md, "Databases").
 *
 * The SQL here is part of that migration: a migration never changes once
 * run, so a change to these rules is a new migration that redefines the
 * columns (MODIFY COLUMN … MATERIALIZED) and materializes them again.
 */

/** The attributes read, the first one a span has winning (docs/telemetry.md, "Databases"). */
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

/** A shape's displayed length, in characters; its ID hashes it whole. */
export const MAX_SHAPE_CHARS = 1000;
/**
 * How much of a query's text is normalized, in characters. Ingestion
 * already cuts an attribute's value to 4 KB, so this only bounds rows
 * written some other way.
 */
export const MAX_TEXT_CHARS = 4096;

/** Where a shape comes from: `db_shape_kind` 1, 2, and 3; 0 for a span that is no database call. */
export const SHAPE_KINDS = ["summary", "query", "operation"] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];

/** A placeholder in a list: `?`, `$?` (a numbered one, after step 4), `@name`, or `:name`. */
const PLACEHOLDER = String.raw`(?:\$?\?|@\w+|:\w+)`;
/**
 * What a row of values may hold: a placeholder, a function call without
 * nested parentheses (`now()`, `lower(?)`), or NULL, DEFAULT, TRUE, FALSE.
 */
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

/** A ClickHouse string literal. */
export const sqlString = (text: string) =>
  `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

/** A span attribute's value. Names are constants. */
const attributeValue = (name: string) => `attributes[${sqlString(name)}]`;

/** The first of `names` a span's attributes have, else ''. */
function firstAttribute(names: readonly string[]): string {
  const value = attributeValue;
  const last = names.at(-1);
  if (last === undefined) throw new Error("no attribute names");
  const tests = names.slice(0, -1).map((name) => `${value(name)} != '', ${value(name)}`);
  return tests.length === 0 ? value(last) : `multiIf(${tests.join(", ")}, ${value(last)})`;
}

/** The SQL that normalizes `text` (NORMALIZE_STEPS), trimmed, whole: up to MAX_TEXT_CHARS of input. */
export function normalizedText(text: string): string {
  let sql = `substringUTF8(${text}, 1, ${MAX_TEXT_CHARS})`;
  for (const step of NORMALIZE_STEPS) {
    sql = `replaceRegexpAll(${sql}, ${sqlString(step.pattern)}, ${sqlString(step.replacement)})`;
  }
  return `trimBoth(${sql})`;
}

/**
 * The columns' definitions, for ALTER TABLE spans ADD COLUMN. None holds
 * a branch around a regular expression: with short-circuit evaluation,
 * ClickHouse copies a lazily worked out branch's input, and 100,000 texts
 * of 4 KB passed 300 MB that way. So the text is normalized only when no
 * summary is sent (the input is '' otherwise, which costs nothing), and a
 * span that is no database call gets '' and 0 by arithmetic, not `if`.
 *
 * - `db_system`: '' for a span that is no database call (not CLIENT, or
 *   without a system attribute).
 * - `db_shape_kind`: 1 summary, 2 query text, 3 operation and collection
 *   (or the span's name); 0 for no database call.
 * - `db_shape`: the shape as shown, cut to MAX_SHAPE_CHARS.
 * - `db_shape_id`: a hash of the system, database, kind, and the whole
 *   shape, so two long queries that differ past the cut stay apart; 0 for
 *   no database call.
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

/** The columns' names, in the order they are added. */
export const DATABASE_CALL_COLUMNS = [
  "db_system",
  "db_namespace",
  "db_shape_kind",
  "db_shape",
  "db_shape_id",
] as const;
