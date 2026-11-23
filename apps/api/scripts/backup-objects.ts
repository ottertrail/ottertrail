/**
 * Back up to an empty or new folder with a manifest (src/storage/object-backup.ts).
 * Without a configured object store, record that none exists. Exits 1 on failure.
 */
import { loadConfig } from "../src/config.ts";
import { backupObjects } from "../src/storage/object-backup.ts";

const dir = process.argv.slice(2).find((arg) => arg !== "--");
if (dir === undefined || dir === "") {
  console.error("Usage: backup-objects <folder>");
  process.exit(1);
}

try {
  const config = loadConfig();
  const { bucket, count, bytes, gone } = await backupObjects(config.objectStore, dir);
  if (bucket === null) {
    console.log("No object store (OBJECT_STORE_URL). Backup records none.");
  } else {
    console.log(`Backed up ${count} objects (${bytes} bytes) from ${bucket}.`);
  }
  if (gone.length > 0) {
    // Expired replays, or a deleted project's files: as if already gone.
    console.log(`${gone.length} objects deleted during backup; skipped.`);
  }
} catch (error) {
  console.error(`Object backup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
