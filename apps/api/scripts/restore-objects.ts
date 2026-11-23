/**
 * Check the manifest and every file before uploading; wait up to a minute for the bucket
 * (src/storage/object-backup.ts). --check lets deploy/restore.sh validate before changing
 * databases. Matching keys are replaced; other objects stay. Exits 1 on failure.
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
