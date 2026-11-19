import { randomBytes } from "node:crypto";

/**
 * Names of the PostgreSQL schemas and ClickHouse databases test files make
 * (test-database.ts, test-clickhouse.ts): "test_", when it was made in
 * seconds since 1970, and 16 random hex digits, such as
 * "test_1795075200_3f2a9c1d0b7e4a56". 32 characters, within a PostgreSQL
 * schema name's 63 (SCHEMA_NAME in src/db/database.ts) and a ClickHouse
 * identifier's rules. The time lets the next run find what a run that was
 * cut off left behind (stale-test-databases.ts).
 */
const NAME = /^test_(\d{10})_[0-9a-f]{16}$/;

/** A new test schema's or database's name, made at `now`. */
export function testName(now: number = Date.now()): string {
  return `test_${Math.floor(now / 1000)}_${randomBytes(8).toString("hex")}`;
}

/**
 * When a name testName() made was made; null for every other name, such as
 * the "test_<32 hex digits>" of older code, whose age cannot be told.
 */
export function madeAt(name: string): Date | null {
  const match = NAME.exec(name);
  return match?.[1] === undefined ? null : new Date(Number(match[1]) * 1000);
}
