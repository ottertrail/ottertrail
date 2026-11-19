/**
 * Copies every object of the object store (source maps and session
 * replays) into a folder, with a manifest of their keys, sizes, content
 * types, and checksums (src/storage/object-backup.ts):
 *
 *   node dist/backup-objects.mjs <folder>      (built; deploy/backup.sh runs it)
 *   vpx scripts/backup-objects.ts <folder>
 *
 * The folder must be empty or not exist yet. It reads the store from the
 * same settings as the API (OBJECT_STORE_*). Without a store, it writes a
 * manifest that says so, which restores nothing. Exits 1 on any failure.
 */
import { loadConfig } from "../src/config.ts";
import { backupObjects } from "../src/storage/object-backup.ts";

const dir = process.argv.slice(2).find((arg) => arg !== "--");
if (dir === undefined || dir === "") {
  console.error("Specify the backup folder: backup-objects <folder>");
  process.exit(1);
}

try {
  const config = loadConfig();
  const { bucket, count, bytes, gone } = await backupObjects(config.objectStore, dir);
  if (bucket === null) {
    console.log(
      "No object store is set up (OBJECT_STORE_URL): the backup records that it has none.",
    );
  } else {
    console.log(`Backed up ${count} objects (${bytes} bytes) from the bucket ${bucket}.`);
  }
  if (gone.length > 0) {
    // Expired replays, or a deleted project's files: as if already gone.
    console.log(`${gone.length} objects were deleted while the backup ran, and are not in it.`);
  }
} catch (error) {
  console.error(
    `The object backup failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
