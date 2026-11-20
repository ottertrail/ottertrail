/**
 * Puts the objects of a folder made by backup-objects back into the object
 * store, under the same keys and content types (src/storage/object-backup.ts):
 *
 *   node dist/restore-objects.mjs [--check] <folder>      (built; deploy/restore.sh runs it)
 *   vpx scripts/restore-objects.ts [--check] <folder>
 *
 * It refuses a folder without a manifest, checks every file against it, and
 * waits up to a minute for the bucket, before it uploads any. With --check,
 * it only checks: deploy/restore.sh runs that before it touches the
 * databases. Objects already in the store under the same keys are
 * replaced; others stay. Exits 1 on any failure.
 */
import { loadConfig } from "../src/config.ts";
import { checkObjectBackup, restoreObjects } from "../src/storage/object-backup.ts";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const checkOnly = args.includes("--check");
const dir = args.find((arg) => arg !== "--check");
if (dir === undefined || dir === "") {
  console.error("Usage: restore-objects [--check] <folder>");
  process.exit(1);
}

try {
  const store = loadConfig().objectStore;
  if (checkOnly) {
    const { manifest, checked } = await checkObjectBackup(store, dir);
    const bytes = checked.reduce((total, entry) => total + entry.size, 0);
    console.log(
      manifest.bucket === null
        ? "Object backup checked: made without an object store, so it holds nothing."
        : `Object backup checked: ${checked.length} objects (${bytes} bytes)${checked.length > 0 ? ", and the bucket answers" : ""}.`,
    );
  } else {
    const { count, bytes, backupBucket } = await restoreObjects(store, dir);
    if (backupBucket === null) {
      console.log("Backup has no object store. Nothing to restore.");
    } else if (store === null) {
      console.log("Backup bucket empty; no object store configured. Nothing to restore.");
    } else {
      console.log(`Restored ${count} objects (${bytes} bytes) to ${store.bucket}.`);
    }
  }
} catch (error) {
  const what = checkOnly ? "Invalid object backup" : "Object restore failed";
  console.error(`${what}: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
