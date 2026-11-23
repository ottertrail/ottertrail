import { execFileSync, spawn } from "node:child_process";

import {
  BackupError,
  type ClickHouseBackupFiles,
  pgDumpOf,
  type PostgresDump,
  WORKER_ZIP,
} from "../../src/backups/run.ts";

/**
 * Use compose.yaml's containers: the host may lack a PostgreSQL 18 client
 * and cannot read ClickHouse's backup volume. The deployed worker has both
 * pg_dump and the shared backup folder (backups/sources.ts).
 */
export interface DevContainers {
  cli: string;
  postgres: string;
  clickhouse: string;
}

let found: DevContainers | null | undefined;

/** Podman's or Docker's containers of the development stack; null when neither runs them. */
export function devContainers(): DevContainers | null {
  if (found !== undefined) return found;
  found = null;
  for (const cli of ["podman", "docker"]) {
    let names: string[];
    try {
      names = execFileSync(cli, ["ps", "--format", "{{.Names}}"], { encoding: "utf8" }).split("\n");
    } catch {
      continue;
    }
    const postgres = names.find((name) => /^ottertrail[-_]postgres[-_]1$/.test(name));
    const clickhouse = names.find((name) => /^ottertrail[-_]clickhouse[-_]1$/.test(name));
    if (postgres !== undefined && clickhouse !== undefined) {
      found = { cli, postgres, clickhouse };
      break;
    }
  }
  return found;
}

export function requireDevContainers(): DevContainers {
  const containers = devContainers();
  if (containers === null) {
    throw new Error(
      "The backup tests run pg_dump and read ClickHouse's backups inside the development stack's containers. Start them with `podman compose up -d` (or docker) from the repository root.",
    );
  }
  return containers;
}

export function containerPgDump(containers: DevContainers, schema: string): PostgresDump {
  const child = spawn(
    containers.cli,
    [
      "exec",
      "-i",
      containers.postgres,
      "pg_dump",
      "-U",
      "ottertrail",
      "-d",
      "ottertrail",
      "--format=custom",
      `--schema=${schema}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  return pgDumpOf(child, "pg_dump");
}

/** A backup file's path inside ClickHouse's container. */
function where(name: string): string {
  if (!/^[A-Za-z0-9-]+\.zip$/.test(name)) throw new Error(`not a backup file name: ${name}`);
  return `/var/lib/clickhouse/backups/${name}`;
}

/** ClickHouse's backups folder, read through the container. */
export function containerClickHouseFiles(containers: DevContainers): ClickHouseBackupFiles {
  return {
    async read(name) {
      let size: number;
      try {
        size = Number(
          execFileSync(
            containers.cli,
            ["exec", containers.clickhouse, "stat", "-c", "%s", where(name)],
            {
              encoding: "utf8",
            },
          ).trim(),
        );
      } catch {
        throw new BackupError(`ClickHouse's backup ${name} is not in its container.`);
      }
      const child = spawn(containers.cli, ["exec", containers.clickhouse, "cat", where(name)], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      return { stream: child.stdout, size };
    },
    async remove(name) {
      execFileSync(containers.cli, ["exec", containers.clickhouse, "rm", "-f", where(name)]);
    },
    async removeLeftovers() {
      const names = execFileSync(
        containers.cli,
        ["exec", containers.clickhouse, "ls", "/var/lib/clickhouse/backups"],
        { encoding: "utf8" },
      )
        .split("\n")
        .filter((name) => WORKER_ZIP.test(name));
      for (const name of names) {
        execFileSync(containers.cli, ["exec", containers.clickhouse, "rm", "-f", where(name)]);
      }
      return names;
    },
  };
}

export function clickHouseFileExists(containers: DevContainers, name: string): boolean {
  try {
    execFileSync(containers.cli, [
      "exec",
      containers.clickhouse,
      "test",
      "-e",
      `/var/lib/clickhouse/backups/${name}`,
    ]);
    return true;
  } catch {
    return false;
  }
}
