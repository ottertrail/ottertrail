import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

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
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export function createDatabase(options: DatabaseOptions): Kysely<Database> {
  const { connectionString, maxConnections = 10, schema } = options;
  if (schema !== undefined && !SCHEMA_NAME.test(schema)) {
    throw new Error(`Invalid schema name "${schema}"`);
  }
  const pool = new Pool({
    connectionString,
    max: maxConnections,
    ...(schema === undefined ? {} : { options: `-c search_path=${schema}` }),
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
