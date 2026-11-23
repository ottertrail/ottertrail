import { randomBytes } from "node:crypto";

/**
 * "test_<epoch seconds>_<16 random hex digits>" fits PostgreSQL's 63-character
 * schema limit (SCHEMA_NAME in src/db/database.ts) and ClickHouse identifiers.
 * The timestamp lets stale-test-databases.ts clean up interrupted runs.
 */
const NAME = /^test_(\d{10})_[0-9a-f]{16}$/;

export function testName(now: number = Date.now()): string {
  return `test_${Math.floor(now / 1000)}_${randomBytes(8).toString("hex")}`;
}

/**
 * Return null for names without a known timestamp, including "test_<32 hex digits>".
 */
export function madeAt(name: string): Date | null {
  const match = NAME.exec(name);
  return match?.[1] === undefined ? null : new Date(Number(match[1]) * 1000);
}
