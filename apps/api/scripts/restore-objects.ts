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
  console.error("Name the folder to restore from: restore-objects [--check] <folder>");
  process.exit(1);
}

try {
  const store = loadConfig().objectStore;
  if (checkOnly) {
    const { manifest, checked } = await checkObjectBackup(store, dir);
    const bytes = checked.reduce((total, entry) => total + entry.size, 0);
    console.log(
      manifest.bucket === null
        ? "The object backup checks out: it was made without an object store, and holds nothing."
        : `The object backup checks out: ${checked.length} objects (${bytes} bytes)${checked.length > 0 ? ", and the bucket answers" : ""}.`,
    );
  } else {
    const { count, bytes, backupBucket } = await restoreObjects(store, dir);
    if (backupBucket === null) {
      console.log("The backup was made without an object store: no objects to restore.");
    } else if (store === null) {
      console.log(
        "The backup's bucket was empty, and no object store is set up: nothing to restore.",
      );
    } else {
      console.log(`Restored ${count} objects (${bytes} bytes) into the bucket ${store.bucket}.`);
    }
  }
} catch (error) {
  const what = checkOnly ? "The object backup does not check out" : "The object restore failed";
  console.error(`${what}: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
