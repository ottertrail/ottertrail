import { Kysely, PostgresDialect } from "kysely";
import { Pool, types } from "pg";

import type { Database } from "./schema.ts";

export interface DatabaseOptions {
  connectionString: string;
  /** Upper bound on open connections from this process. */
  maxConnections?: number;
  /**
   * Schema to use instead of "public". Tests use a fresh schema each so they
   * never touch development data or each other.
   */
  schema?: string;
  /**
   * Hears an idle connection ending (PostgreSQL restarted, or the backend
   * terminated); the API and the worker pass their own log. By default, a
   * JSON line on stderr, for scripts.
   */
  onIdleError?: (error: Error) => void;
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

// PostgreSQL "date" columns (no time of day) stay "YYYY-MM-DD" strings. By
// default pg turns them into JavaScript Dates at local midnight, which shifts
// the day whenever the server's timezone differs from the data's.
types.setTypeParser(types.builtins.DATE, (value) => value);

function logIdleError(error: Error): void {
  console.error(
    JSON.stringify({
      level: "warn",
      time: Date.now(),
      msg: "an idle PostgreSQL connection ended; the next query opens a new one",
      err: error.message,
    }),
  );
}

export function createDatabase(options: DatabaseOptions): Kysely<Database> {
  const { connectionString, maxConnections = 10, schema, onIdleError = logIdleError } = options;
  if (schema !== undefined && !SCHEMA_NAME.test(schema)) {
    throw new Error(`Invalid schema name "${schema}"`);
  }
  const pool = new Pool({
    connectionString,
    max: maxConnections,
    ...(schema === undefined ? {} : { options: `-c search_path=${schema}` }),
  });
  // An idle connection whose backend ends (PostgreSQL restarted, or the
  // backend terminated) makes the pool emit "error"; unheard, that would
  // end the process. The pool has already dropped the connection, and the
  // next query opens a new one.
  pool.on("error", onIdleError);
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
