import { describe, expect, test } from "vite-plus/test";

import type { StorageReading } from "../src/storage/usage.ts";
import {
  evaluateWarnings,
  recovery,
  sizeText,
  type WarningId,
  type WarningLevel,
} from "../src/storage/warnings.ts";

const GiB = 1024 ** 3;

/** Start with a healthy 100 GiB disk; each test changes one figure. */
function reading(change: {
  free?: number;
  total?: number;
  largestPartition?: number;
  clickhouse?: number;
  replays?: { used: number; limit: number };
  sourceMaps?: { used: number; limit: number };
  garageBytes?: number | null;
  objectStore?: StorageReading["objectStore"];
  readOnly?: boolean;
  diskFails?: boolean;
}): StorageReading {
  const replays = change.replays ?? { used: 1 * GiB, limit: 2 * GiB };
  const sourceMaps = change.sourceMaps ?? { used: 0.1 * GiB, limit: 1 * GiB };
  const objectStore = change.objectStore ?? "garage";
  return {
    measuredAt: new Date("2026-11-19T10:00:00Z"),
    objectStore,
    budgets:
      objectStore === "none"
        ? null
        : {
            ok: true,
            replays: { usedBytes: replays.used, limitBytes: replays.limit },
            sourceMaps: { usedBytes: sourceMaps.used, limitBytes: sourceMaps.limit },
          },
    clickhouse: {
      ok: true,
      tables: [],
      totalBytes: change.clickhouse ?? 10 * GiB,
      largestPartition: {
        table: "events",
        partition: "202611",
        bytes: change.largestPartition ?? 2 * GiB,
      },
    },
    postgres: { ok: true, databaseBytes: 50 * 1024 ** 2, tables: [] },
    disk: change.diskFails
      ? { ok: false, error: "ClickHouse did not answer: connect ECONNREFUSED" }
      : {
          ok: true,
          totalBytes: change.total ?? 100 * GiB,
          freeBytes: change.free ?? 60 * GiB,
          readOnly: change.readOnly ?? false,
          broken: false,
        },
    garage:
      objectStore !== "garage"
        ? null
        : change.garageBytes === undefined || change.garageBytes === null
          ? { state: "no_token" }
          : {
              state: "ok",
              bucket: { id: "b", objects: 3, bytes: change.garageBytes, maxSize: null },
              dataPartition: null,
            },
  };
}

const ids = (value: StorageReading, active?: Map<WarningId, WarningLevel>) =>
  evaluateWarnings(value, active).warnings.map((warning) => `${warning.id}:${warning.level}`);

/** The disk's warnings only, at `percent` used. */
const at = (percent: number, active?: Map<WarningId, WarningLevel>) =>
  ids(
    reading({ free: ((100 - percent) / 100) * 100 * GiB, largestPartition: 1, clickhouse: 1 }),
    active,
  );

/** The merge warning only. */
const merge = (value: StorageReading) => ids(value).filter((id) => id.startsWith("merge_headroom"));

describe("each storage warning's threshold", () => {
  test("a healthy instance has none", () => {
    expect(ids(reading({}))).toEqual([]);
  });

  test("merge headroom: free space under twice the largest partition; critical under once", () => {
    expect(merge(reading({ largestPartition: 10 * GiB, free: 20 * GiB }))).toEqual([]);
    expect(merge(reading({ largestPartition: 10 * GiB, free: 20 * GiB - 1 }))).toEqual([
      "merge_headroom:warning",
    ]);
    expect(merge(reading({ largestPartition: 25 * GiB, free: 24 * GiB }))).toEqual([
      "merge_headroom:critical",
    ]);
    const [warning] = evaluateWarnings(
      reading({ largestPartition: 10 * GiB, free: 19 * GiB }),
    ).warnings;
    expect(warning?.text).toContain("events 202611");
    expect(warning?.text).toContain("10 GB");
    expect(warning?.figures).toMatchObject({ freeBytes: 19 * GiB, neededBytes: 20 * GiB });
  });

  test("backup: free space under twice ClickHouse's data plus twice the objects", () => {
    // 2 × 10 GiB + 2 × 1.1 GiB of recorded objects = 22.2 GiB.
    const need = 2 * 10 * GiB + 2 * 1.1 * GiB;
    expect(ids(reading({ free: need, largestPartition: 1 }))).toEqual([]);
    expect(ids(reading({ free: need - 1, largestPartition: 1 }))).toEqual(["backup_space:warning"]);
    // Garage's own count of the objects wins over Ottertrail's.
    expect(ids(reading({ free: need, garageBytes: 5 * GiB, largestPartition: 1 }))).toEqual([
      "backup_space:warning",
    ]);
    const [warning] = evaluateWarnings(reading({ free: need - 1, largestPartition: 1 })).warnings;
    expect(warning?.title).toBe("The next backup would fail");
    expect(warning?.text).toContain("The instance itself keeps running.");
  });

  test("the disk: a warning at 80% used, critical at 90%; read-only is critical", () => {
    // Merge and backup room are ample in these readings.
    const small = { largestPartition: 1, clickhouse: 1 };
    const disk = (percent: number) =>
      ids(reading({ ...small, free: ((100 - percent) / 100) * 100 * GiB })).filter((id) =>
        id.startsWith("disk_used"),
      );
    expect(disk(79.9)).toEqual([]);
    expect(disk(80)).toEqual(["disk_used:warning"]);
    expect(disk(89.9)).toEqual(["disk_used:warning"]);
    expect(disk(90)).toEqual(["disk_used:critical"]);
    expect(ids(reading({ readOnly: true, free: 0 }))).toContain("disk_used:critical");
    const [warning] = evaluateWarnings(reading({ ...small, free: 15 * GiB })).warnings;
    expect(warning?.title).toBe("The disk is 85% full");
  });

  test("the budgets: a warning at 90% of each", () => {
    expect(ids(reading({ replays: { used: 89.9, limit: 100 } }))).toEqual([]);
    expect(ids(reading({ replays: { used: 90, limit: 100 } }))).toEqual(["replay_budget:warning"]);
    expect(ids(reading({ sourceMaps: { used: 95, limit: 100 } }))).toEqual([
      "source_map_budget:warning",
    ]);
    // No object store: no budgets.
    expect(ids(reading({ objectStore: "none" }))).toEqual([]);
  });

  test("budgets larger than the free disk, only when Garage keeps the objects on it", () => {
    // Room left: 1 GiB of replays and 0.9 GiB of source maps.
    const room = 1 * GiB + 0.9 * GiB;
    const small = { largestPartition: 1, clickhouse: 0 };
    const budgets = (free: number, objectStore: StorageReading["objectStore"] = "garage") =>
      ids(reading({ ...small, free, total: 100 * GiB, objectStore })).filter(
        (id) => id.startsWith("budgets") || id.startsWith("backup"),
      );
    expect(budgets(room + 3 * GiB)).toEqual([]);
    expect(budgets(room - 1 + 0)).toContain("budgets_exceed_disk:warning");
    // R2 or S3: the objects are not on this disk.
    expect(budgets(room - 1, "other")).not.toContain("budgets_exceed_disk:warning");
  });

  test("a figure that could not be measured decides nothing", () => {
    const result = evaluateWarnings(reading({ diskFails: true }));
    expect(result.warnings).toEqual([]);
    expect(result.undetermined).toEqual([
      "merge_headroom",
      "backup_space",
      "disk_used",
      "budgets_exceed_disk",
    ]);
  });
});

/** Backups on, with `noDestination` as the worker reported it. */
const health = (noDestination: { problem: string | null } | null) =>
  evaluateWarnings({
    ...reading({}),
    backups: { ok: true, enabled: true, failed: null, overdue: null, noDestination },
  });

describe("backups on without a destination", () => {
  test("warns, with the worker's problem when it has one, and links nothing else", () => {
    expect(health(null).warnings).toEqual([]);
    const missing = health({ problem: null }).warnings;
    expect(missing).toEqual([
      expect.objectContaining({
        id: "backup_destination",
        level: "warning",
        title: "Backups have no destination",
      }),
    ]);
    expect(missing[0]?.text).toBe(
      "Backups are on, but the worker has no BACKUP_S3_* variables. The next backup will fail. Set them in the server's .env and run `docker compose up -d`.",
    );
    const invalid = health({ problem: "Set BACKUP_S3_REGION too." }).warnings[0];
    expect(invalid?.text).toMatch(
      /^Backups are on, but the worker's BACKUP_S3_\* variables have a problem: Set BACKUP_S3_REGION too\. /,
    );
    expect(invalid?.figures).toEqual({ problem: "Set BACKUP_S3_REGION too." });
    expect(recovery("backup_destination", reading({})).message).toBe(
      "Backups have a destination again: the worker reported one.",
    );
  });
});

describe("a warning that is on ends only past a margin", () => {
  test("the disk: on at 80%, still on at 78.5%, off under 78%", () => {
    const on = new Map<WarningId, WarningLevel>([["disk_used", "warning"]]);
    expect(at(79)).toEqual([]);
    expect(at(79, on)).toEqual(["disk_used:warning"]);
    expect(at(78.1, on)).toEqual(["disk_used:warning"]);
    expect(at(77.9, on)).toEqual([]);
    // Critical holds to 88%, then falls back to a warning.
    const critical = new Map<WarningId, WarningLevel>([["disk_used", "critical"]]);
    expect(at(89, critical)).toEqual(["disk_used:critical"]);
    expect(at(87, critical)).toEqual(["disk_used:warning"]);
    // A warning rises to critical at 90%, not before.
    expect(at(89, on)).toEqual(["disk_used:warning"]);
  });

  test("space: on until the free space is 10% past what is needed", () => {
    const on = new Map<WarningId, WarningLevel>([["merge_headroom", "warning"]]);
    const free = (bytes: number, active?: Map<WarningId, WarningLevel>) =>
      ids(reading({ largestPartition: 10 * GiB, clickhouse: 1, free: bytes }), active);
    expect(free(21 * GiB)).toEqual([]);
    expect(free(21 * GiB, on)).toEqual(["merge_headroom:warning"]);
    expect(free(22 * GiB, on)).toEqual([]);
  });

  test("merge headroom: critical holds until 10% past the partition's size, so 99, 101, 99 GiB rises once", () => {
    let active = new Map<WarningId, WarningLevel>();
    const levels: string[] = [];
    for (const free of [99, 101, 99, 109, 111]) {
      const warning = evaluateWarnings(
        reading({
          largestPartition: 100 * GiB,
          clickhouse: 1,
          free: free * GiB,
          total: 1000 * GiB,
        }),
        active,
      ).warnings.find((item) => item.id === "merge_headroom");
      levels.push(warning?.level ?? "off");
      active = new Map(warning === undefined ? [] : [["merge_headroom", warning.level]]);
    }
    // Critical once; back to a warning only at 110 GiB free.
    expect(levels).toEqual(["critical", "critical", "critical", "critical", "warning"]);
    // Without the warning on, 101 GiB is a warning, not critical.
    expect(
      evaluateWarnings(
        reading({ largestPartition: 100 * GiB, clickhouse: 1, free: 101 * GiB, total: 1000 * GiB }),
      ).warnings.find((item) => item.id === "merge_headroom")?.level,
    ).toBe("warning");
  });

  test("the budgets: on until under 88%", () => {
    const on = new Map<WarningId, WarningLevel>([["replay_budget", "warning"]]);
    expect(ids(reading({ replays: { used: 89, limit: 100 } }), on)).toEqual([
      "replay_budget:warning",
    ]);
    expect(ids(reading({ replays: { used: 87, limit: 100 } }), on)).toEqual([]);
  });
});

test("sizes in messages read as the Storage tab writes the figures beside them", () => {
  // formatBytes in the dashboard: powers of 1,024, one decimal under 10.
  expect(sizeText(7 * GiB)).toBe("7 GB");
  expect(sizeText(1.9 * GiB)).toBe("1.9 GB");
  expect(sizeText(100 * GiB)).toBe("100 GB");
  expect(sizeText(300 * 1024 ** 2)).toBe("300 MB");
  expect(sizeText(12 * 1024)).toBe("12 KB");
  expect(sizeText(512)).toBe("512 bytes");
  expect(sizeText(1)).toBe("1 byte");
});

test("each recovery says what the figure is now", () => {
  const now = reading({ free: 30 * GiB });
  expect(recovery("disk_used", now).message).toBe(
    "The disk is 70% full, under 80% again: 30 GB of 100 GB is free.",
  );
  expect(recovery("replay_budget", now).message).toBe(
    "Session replays use 50% of their budget, under 90% again.",
  );
  expect(recovery("merge_headroom", now).figures).toEqual({
    freeBytes: 30 * GiB,
    partitionBytes: 2 * GiB,
  });
});
