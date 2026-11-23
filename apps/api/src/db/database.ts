import { Kysely, PostgresDialect } from "kysely";
import { Pool, types } from "pg";

import type { Database } from "./schema.ts";

export interface DatabaseOptions {
  connectionString: string;
  maxConnections?: number;
  /** Defaults to "public". Tests use separate schemas to isolate their data. */
  schema?: string;
  /** Handles idle connection errors. Defaults to a JSON line on stderr. */
  onIdleError?: (error: Error) => void;
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

// Keep DATE values as YYYY-MM-DD strings. pg's local-midnight Dates
// can shift the day across timezones.
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
  // An unhandled pool error would end the process. The pool drops the idle
  // connection and reconnects on the next query.
  pool.on("error", onIdleError);
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
