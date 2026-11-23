import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { QueryParams, queryRows } from "../clickhouse/query.ts";
import type { Config } from "../config.ts";
import { type BackupSources, localClickHouseFiles, spawnPgDump } from "./run.ts";

/** The disk ClickHouse writes to, from system.disks (statvfs on its data folder). */
export async function clickHouseDisk(
  clickhouse: ClickHouseClient,
): Promise<{ totalBytes: number; freeBytes: number }> {
  const [disk] = await queryRows<{ total_space: string; free_space: string }>(
    { client: clickhouse },
    "SELECT total_space, free_space FROM system.disks WHERE name = 'default'",
    new QueryParams(),
    { max_execution_time: 10 },
  );
  if (disk === undefined) throw new Error("ClickHouse reports no default disk");
  return { totalBytes: Number(disk.total_space), freeBytes: Number(disk.free_space) };
}

/** The active parts' bytes of the client's database: about what its backup takes. */
export async function clickHouseDataBytes(clickhouse: ClickHouseClient): Promise<number> {
  const [row] = await queryRows<{ bytes: string }>(
    { client: clickhouse },
    "SELECT sum(bytes_on_disk) AS bytes FROM system.parts WHERE database = currentDatabase() AND active",
    new QueryParams(),
    { max_execution_time: 10 },
  );
  return Number(row?.bytes ?? 0);
}

/**
 * Use PostgreSQL 18's pg_dump from the image. CLICKHOUSE_BACKUP_PATH
 * must be shared with ClickHouse.
 */
export function backupSourcesOf(
  config: Pick<Config, "databaseUrl" | "clickhouse" | "clickhouseBackupPath" | "objectStore">,
  clickhouse: ClickHouseClient,
): BackupSources {
  return {
    dumpPostgres: () => spawnPgDump(config.databaseUrl),
    clickhouse,
    clickhouseDatabase: config.clickhouse.database,
    clickhouseFiles: localClickHouseFiles(config.clickhouseBackupPath),
    objectStore: config.objectStore,
    readDisk: () => clickHouseDisk(clickhouse),
    clickhouseBytes: () => clickHouseDataBytes(clickhouse),
  };
}
