import type { Budget, StorageReading } from "./usage.ts";

/**
 * Storage warnings (docs/deployment.md, "Storage"), worked out on the
 * server from a reading (usage.ts). Each says what happens and what to do.
 *
 * A warning starts at its threshold and ends only once the figure is back
 * past a margin (`HOLD`), so a figure that hovers at the line does not
 * start and end it on every check. Whether it was already on comes from
 * the stored state (warning-state.ts). A warning whose figures could not
 * be measured is neither started nor ended: `undetermined` lists it.
 */

export const WARNING_IDS = [
  "merge_headroom",
  "backup_space",
  "disk_used",
  "replay_budget",
  "source_map_budget",
  "budgets_exceed_disk",
  "backup_failed",
  "backup_overdue",
  "backup_destination",
] as const;

export type WarningId = (typeof WARNING_IDS)[number];
export type WarningLevel = "warning" | "critical";

export const isWarningId = (value: unknown): value is WarningId =>
  WARNING_IDS.some((id) => id === value);

export interface StorageWarning {
  id: WarningId;
  level: WarningLevel;
  /** A short line, such as "The disk is 85% full". */
  title: string;
  /** What happens, and what to do, in a few sentences. */
  text: string;
  /** The figures behind it, as a notification's subject carries them. */
  figures: Record<string, number | string>;
}

/** Each warning's name, for one that is on but could not be measured now. */
export const WARNING_TITLES: Record<WarningId, string> = {
  merge_headroom: "ClickHouse is short of space to merge",
  backup_space: "The next backup would fail",
  disk_used: "The disk is nearly full",
  replay_budget: "Session replays are near their budget",
  source_map_budget: "Source maps are near their budget",
  budgets_exceed_disk: "The budgets are larger than the free disk",
  backup_failed: "The last backup failed",
  backup_overdue: "A backup is overdue",
  backup_destination: "Backups have no destination",
};

/** The thresholds: docs/deployment.md, "Storage warnings", explains each. */
export const THRESHOLDS = {
  /** ClickHouse starts a merge only with twice the parts' size free. */
  mergeFactor: 2,
  /** backup.sh needs about twice ClickHouse's data, and twice the objects. */
  backupFactor: 2,
  diskWarningPercent: 80,
  diskCriticalPercent: 90,
  budgetPercent: 90,
} as const;

/**
 * How far past its threshold a figure must come back before a warning that
 * is on ends: 10% more free space than the threshold needs, or 2 points
 * under a percentage.
 */
export const HOLD = { spaceFactor: 1.1, percentPoints: 2 } as const;

const SIZE_UNITS = ["KB", "MB", "GB"] as const;

/**
 * "1.5 GB", "300 MB", "12 KB": sizes in messages, written as the Storage
 * tab writes the figures beside them (formatBytes in the dashboard): powers
 * of 1,024, one decimal under 10.
 */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  let value = bytes;
  let unit: (typeof SIZE_UNITS)[number] = "KB";
  for (const next of SIZE_UNITS) {
    value /= 1024;
    unit = next;
    if (value < 1024) break;
  }
  const digits = value < 10 && !Number.isInteger(value) ? 1 : 0;
  return `${value.toLocaleString("en", { maximumFractionDigits: digits })} ${unit}`;
}

const percentOf = (part: number, whole: number) => (whole <= 0 ? 0 : (part / whole) * 100);

/** The objects' bytes: Garage's own count when it has one, else what Ottertrail recorded. */
export function objectBytes(reading: StorageReading): number | null {
  const garage = reading.garage;
  if (garage?.state === "ok" && garage.bucket !== null) return garage.bucket.bytes;
  if (reading.budgets === null) return 0;
  if (!reading.budgets.ok) return null;
  return reading.budgets.replays.usedBytes + reading.budgets.sourceMaps.usedBytes;
}

/** The free space backup.sh needs: about twice ClickHouse's data and twice the objects. */
export function backupNeedBytes(clickhouseBytes: number, objects: number): number {
  return THRESHOLDS.backupFactor * clickhouseBytes + THRESHOLDS.backupFactor * objects;
}

export interface Evaluation {
  warnings: StorageWarning[];
  /** Warnings whose figures could not be measured: their state stays as it was. */
  undetermined: WarningId[];
}

/**
 * The warnings a reading shows. `active` holds the warnings already on,
 * with their level: they end only past the margin.
 */
export function evaluateWarnings(
  reading: StorageReading,
  active: ReadonlyMap<WarningId, WarningLevel> = new Map(),
): Evaluation {
  const warnings: StorageWarning[] = [];
  const undetermined: WarningId[] = [];
  const held = (id: WarningId) => active.has(id);
  // Free space must reach `need`, times the margin while the warning is on.
  const short = (id: WarningId, free: number, need: number) =>
    free < need * (held(id) ? HOLD.spaceFactor : 1);
  const { disk, clickhouse } = reading;

  // 1. Merge headroom.
  if (!disk.ok || !clickhouse.ok) {
    undetermined.push("merge_headroom");
  } else if (clickhouse.largestPartition !== null && clickhouse.largestPartition.bytes > 0) {
    const largest = clickhouse.largestPartition;
    const need = THRESHOLDS.mergeFactor * largest.bytes;
    if (short("merge_headroom", disk.freeBytes, need)) {
      warnings.push({
        id: "merge_headroom",
        // Critical under once its size free; once critical, until 10% past that.
        level:
          disk.freeBytes <
          largest.bytes * (active.get("merge_headroom") === "critical" ? HOLD.spaceFactor : 1)
            ? "critical"
            : "warning",
        title: "ClickHouse is short of space to merge",
        text:
          `ClickHouse merges a partition only with twice its size free. The largest, ${largest.table} ${largest.partition}, ` +
          `takes ${sizeText(largest.bytes)}, and the disk has ${sizeText(disk.freeBytes)} free, less than the ${sizeText(need)} it needs. ` +
          "Large merges stop: retried events stay counted twice in some reports for longer, reports that remove copies get slower, and deleted rows stay on disk. " +
          "Free space on the disk, shorten the retention of events or telemetry, or move the instance to a larger disk.",
        figures: {
          freeBytes: disk.freeBytes,
          neededBytes: need,
          table: largest.table,
          partition: largest.partition,
          partitionBytes: largest.bytes,
        },
      });
    }
  }

  // 2. The next backup.
  const objects = objectBytes(reading);
  if (!disk.ok || !clickhouse.ok || objects === null) {
    undetermined.push("backup_space");
  } else {
    const need = backupNeedBytes(clickhouse.totalBytes, objects);
    if (need > 0 && short("backup_space", disk.freeBytes, need)) {
      warnings.push({
        id: "backup_space",
        level: "warning",
        title: "The next backup would fail",
        text:
          `backup.sh needs about ${sizeText(need)} free: twice ClickHouse's ${sizeText(clickhouse.totalBytes)} and twice the ${sizeText(objects)} of replays and source maps. ` +
          `The disk has ${sizeText(disk.freeBytes)} free, so the next backup would stop part way and keep no file. The instance itself keeps running. ` +
          "Copy old backups in backups/ off the server and delete them, or free space on the disk.",
        figures: {
          freeBytes: disk.freeBytes,
          neededBytes: need,
          clickhouseBytes: clickhouse.totalBytes,
          objectBytes: objects,
        },
      });
    }
  }

  // 3. The disk, in percent.
  if (!disk.ok) {
    undetermined.push("disk_used");
  } else if (disk.readOnly || disk.broken) {
    warnings.push({
      id: "disk_used",
      level: "critical",
      title: disk.broken ? "ClickHouse's disk is broken" : "ClickHouse's disk is read-only",
      text:
        "ClickHouse cannot write to its disk, so collection answers 503 and stores no events, errors, or telemetry until it can. " +
        "Check the server's disk (free space, the filesystem's state), then restart ClickHouse with `docker compose restart clickhouse`.",
      figures: { totalBytes: disk.totalBytes, freeBytes: disk.freeBytes },
    });
  } else if (disk.totalBytes > 0) {
    const used = percentOf(disk.totalBytes - disk.freeBytes, disk.totalBytes);
    const was = active.get("disk_used");
    const margin = (level: WarningLevel) =>
      was !== undefined && (was === "critical" || level === "warning") ? HOLD.percentPoints : 0;
    const level: WarningLevel | null =
      used >= THRESHOLDS.diskCriticalPercent - margin("critical")
        ? "critical"
        : used >= THRESHOLDS.diskWarningPercent - margin("warning")
          ? "warning"
          : null;
    if (level !== null) {
      const percent = Math.floor(used);
      warnings.push({
        id: "disk_used",
        level,
        title: `The disk is ${percent}% full`,
        text:
          `${sizeText(disk.freeBytes)} of ${sizeText(disk.totalBytes)} is free. ` +
          (level === "critical"
            ? "When the disk is full, ClickHouse refuses events (collection answers 503) and PostgreSQL can stop, which takes the whole instance down. "
            : "PostgreSQL, ClickHouse, Garage, and backups share this disk. ") +
          "Free space now: copy old backups off the server and delete them, shorten retention, lower the replay and source map budgets, or move to a larger disk.",
        figures: { usedPercent: percent, totalBytes: disk.totalBytes, freeBytes: disk.freeBytes },
      });
    }
  }

  // 4. The budgets.
  const budget = (id: "replay_budget" | "source_map_budget", of: Budget, what: string) => {
    if (of.limitBytes <= 0) return;
    const used = percentOf(of.usedBytes, of.limitBytes);
    if (used < THRESHOLDS.budgetPercent - (held(id) ? HOLD.percentPoints : 0)) return;
    const percent = Math.floor(used);
    warnings.push({
      id,
      level: "warning",
      title: `${what === "replays" ? "Session replays" : "Source maps"} use ${percent}% of their budget`,
      text:
        what === "replays"
          ? `Replays take ${sizeText(of.usedBytes)} of the ${sizeText(of.limitBytes)} REPLAY_STORAGE_BYTES allows. At the limit, new replays are not recorded; the others stay until they expire after 30 days. Raise REPLAY_STORAGE_BYTES if the disk has room, or delete a project's replays in its settings.`
          : `Source maps take ${sizeText(of.usedBytes)} of the ${sizeText(of.limitBytes)} SOURCE_MAP_STORAGE_BYTES allows. At the limit, uploads are refused, and new releases' errors show minified stacks. Delete old releases' maps in each project's settings, or raise SOURCE_MAP_STORAGE_BYTES if the disk has room.`,
      figures: { usedBytes: of.usedBytes, limitBytes: of.limitBytes, usedPercent: percent },
    });
  };
  if (reading.budgets === null) {
    // No object store: no budgets to fill.
  } else if (!reading.budgets.ok) {
    undetermined.push("replay_budget", "source_map_budget");
  } else {
    budget("replay_budget", reading.budgets.replays, "replays");
    budget("source_map_budget", reading.budgets.sourceMaps, "source maps");
  }

  // 5. Budgets the disk cannot hold: only when the objects are on this disk (the stack's Garage).
  if (reading.objectStore === "garage") {
    if (reading.budgets === null || !reading.budgets.ok || !disk.ok) {
      undetermined.push("budgets_exceed_disk");
    } else {
      const { replays, sourceMaps } = reading.budgets;
      const room =
        Math.max(0, replays.limitBytes - replays.usedBytes) +
        Math.max(0, sourceMaps.limitBytes - sourceMaps.usedBytes);
      // On while the room is more than the free space; off once the free space is 10% above it.
      if (room > 0 && short("budgets_exceed_disk", disk.freeBytes, room)) {
        warnings.push({
          id: "budgets_exceed_disk",
          level: "warning",
          title: "The budgets are larger than the free disk",
          text:
            `Replays and source maps may still grow by ${sizeText(room)} within their budgets, but the disk has ${sizeText(disk.freeBytes)} free. ` +
            "Garage keeps them on the same disk as the databases, so the budgets cannot keep the disk from filling. " +
            "Lower REPLAY_STORAGE_BYTES or SOURCE_MAP_STORAGE_BYTES in .env and run `docker compose up -d`, or free space on the disk.",
          figures: { roomBytes: room, freeBytes: disk.freeBytes },
        });
      }
    }
  }

  // 6. Scheduled backups (backups/state.ts): the last one failed, or none worked since one was due.
  const backups = reading.backups;
  if (backups === undefined || backups === null) {
    // Not measured with the stores (a reading made without them).
  } else if (!backups.ok) {
    undetermined.push("backup_failed", "backup_overdue", "backup_destination");
  } else {
    if (backups.failed !== null) {
      warnings.push({
        id: "backup_failed",
        level: "warning",
        title: "The last backup failed",
        text:
          `The backup that ended ${utcText(backups.failed.at)} failed: ${sentence(backups.failed.error)} ` +
          "The worker tries a failed backup once more an hour later; until one works, the newest backup in the bucket is the last good one. " +
          "The owner sees every run, and can back up now, on the Backups tab of Settings.",
        figures: { failedAt: backups.failed.at.toISOString() },
      });
    }
    if (backups.overdue !== null) {
      warnings.push({
        id: "backup_overdue",
        level: "warning",
        title: "A backup is overdue",
        text:
          `No backup has worked since the daily backup due ${utcText(backups.overdue.since)}. ` +
          "The worker may be stopped, or its backups keep failing. Check that the worker runs (`docker compose ps`), and the Backups tab of Settings for the last run and its error.",
        figures: { dueAt: backups.overdue.since.toISOString() },
      });
    }
    if (backups.noDestination !== null) {
      const { problem } = backups.noDestination;
      warnings.push({
        id: "backup_destination",
        level: "warning",
        title: "Backups have no destination",
        text:
          (problem === null
            ? "Backups are on, but the worker has no BACKUP_S3_* variables. "
            : `Backups are on, but the worker's BACKUP_S3_* variables have a problem: ${sentence(problem)} `) +
          "The next backup will fail. Set them in the server's .env and run `docker compose up -d`.",
        figures: problem === null ? {} : { problem },
      });
    }
  }

  return { warnings, undetermined };
}

/** "20 Nov 2026, 03:00 UTC": a moment in a message, which goes to every channel alike. */
function utcText(moment: Date): string {
  const text = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(moment);
  return `${text} UTC`;
}

const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/**
 * What a `storage.recovered` notification says about a warning that ended,
 * with the figures now. Only called for a warning the reading determined.
 */
export function recovery(
  id: WarningId,
  reading: StorageReading,
): { message: string; figures: Record<string, number | string> } {
  const free = reading.disk.ok ? reading.disk.freeBytes : 0;
  const freeText = sizeText(free);
  switch (id) {
    case "merge_headroom": {
      const largest = reading.clickhouse.ok ? (reading.clickhouse.largestPartition?.bytes ?? 0) : 0;
      return {
        message: `ClickHouse has room to merge again: the disk has ${freeText} free, and its largest partition takes ${sizeText(largest)}.`,
        figures: { freeBytes: free, partitionBytes: largest },
      };
    }
    case "backup_space": {
      const clickhouse = reading.clickhouse.ok ? reading.clickhouse.totalBytes : 0;
      const need = backupNeedBytes(clickhouse, objectBytes(reading) ?? 0);
      return {
        message: `The disk has room for a backup again: ${freeText} free, and a backup needs about ${sizeText(need)}.`,
        figures: { freeBytes: free, neededBytes: need },
      };
    }
    case "disk_used": {
      const total = reading.disk.ok ? reading.disk.totalBytes : 0;
      const percent = Math.floor(percentOf(total - free, total));
      return {
        message: `The disk is ${percent}% full, under ${THRESHOLDS.diskWarningPercent}% again: ${freeText} of ${sizeText(total)} is free.`,
        figures: { usedPercent: percent, totalBytes: total, freeBytes: free },
      };
    }
    case "replay_budget":
    case "source_map_budget": {
      const budgets = reading.budgets?.ok === true ? reading.budgets : null;
      const of =
        budgets === null
          ? { usedBytes: 0, limitBytes: 0 }
          : id === "replay_budget"
            ? budgets.replays
            : budgets.sourceMaps;
      const percent = Math.floor(percentOf(of.usedBytes, of.limitBytes));
      return {
        message: `${id === "replay_budget" ? "Session replays" : "Source maps"} use ${percent}% of their budget, under ${THRESHOLDS.budgetPercent}% again.`,
        figures: { usedBytes: of.usedBytes, limitBytes: of.limitBytes, usedPercent: percent },
      };
    }
    case "backup_failed":
      return { message: "Backups work again: the latest backup finished.", figures: {} };
    case "backup_overdue":
      return { message: "Backups are on time again: a backup finished.", figures: {} };
    case "backup_destination":
      return { message: "Backups have a destination again: the worker reported one.", figures: {} };
    case "budgets_exceed_disk":
      break;
  }
  // The budgets larger than the free disk.
  const budgets = reading.budgets?.ok === true ? reading.budgets : null;
  const room =
    budgets === null
      ? 0
      : Math.max(0, budgets.replays.limitBytes - budgets.replays.usedBytes) +
        Math.max(0, budgets.sourceMaps.limitBytes - budgets.sourceMaps.usedBytes);
  return {
    message: `The disk has room for the replay and source map budgets again: ${freeText} free, and the budgets may still grow by ${sizeText(room)}.`,
    figures: { roomBytes: room, freeBytes: free },
  };
}
