/**
 * Lists and downloads the worker's scheduled backups from S3-compatible
 * storage, for deploy/restore.sh (docs/deployment.md, "Restoring from S3"):
 *
 *   node dist/restore-backup.mjs list
 *   node dist/restore-backup.mjs describe <name|latest> <key file>
 *   node dist/restore-backup.mjs download <name> <key file> <folder>
 *   vpx scripts/restore-backup.ts …
 *
 * `describe` checks the backup's manifest against the key (its MAC, which
 * only the key's holder can make: anyone who can write to the bucket could
 * otherwise upload a backup that decrypts) and prints its name, start, and
 * the Ottertrail version that made it, tab-separated, for restore.sh to
 * ask about. `download` checks the MAC again, before it reads any part,
 * then reads the backup's manifest, streams each part through
 * decryption with the key file (age's identity format, as the Backups tab
 * downloads it), checks every size and SHA-256 before and after
 * decryption, and writes the plain files into the folder as backup.sh
 * names them: ottertrail-<name>.dump, .zip, and -objects.tar, through a
 * folder of its own inside that is deleted on any failure, so a failed
 * download leaves no decrypted data. It prints the
 * backup's path without its ending, which restore.sh restores.
 *
 * Where the backups are comes from the environment, never the command
 * line: BACKUP_S3_ENDPOINT, BACKUP_S3_REGION, BACKUP_S3_BUCKET,
 * BACKUP_S3_PREFIX (the folder), BACKUP_S3_ACCESS_KEY_ID, and
 * BACKUP_S3_SECRET_ACCESS_KEY. Exits 1 on any failure, saying why.
 */
import { readFile } from "node:fs/promises";

import { BackupError, testRestore, verifiedManifest } from "../src/backups/run.ts";
import { backupClient, listBackups, s3ErrorText } from "../src/backups/s3.ts";
import { endpointOrigin, type Destination } from "../src/backups/settings.ts";
import { addressPolicy, systemLookup } from "../src/outbound/addresses.ts";

const NAMES = {
  endpoint: "BACKUP_S3_ENDPOINT",
  region: "BACKUP_S3_REGION",
  bucket: "BACKUP_S3_BUCKET",
  prefix: "BACKUP_S3_PREFIX",
  accessKeyId: "BACKUP_S3_ACCESS_KEY_ID",
  secretAccessKey: "BACKUP_S3_SECRET_ACCESS_KEY",
} as const;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const read = (name: string) => process.env[name]?.trim() ?? "";

function destinationFromEnvironment(): Destination {
  const missing = Object.values(NAMES).filter((name) => read(name) === "");
  if (missing.length > 0) fail(`Set ${missing.join(", ")} (restore.sh asks for them).`);
  const url = endpointOrigin(read(NAMES.endpoint));
  if (url === null)
    fail(`${NAMES.endpoint} must be an http:// or https:// address without a path.`);
  return {
    url,
    region: read(NAMES.region),
    bucket: read(NAMES.bucket),
    prefix: read(NAMES.prefix).replace(/^\/+|\/+$/g, ""),
    accessKeyId: read(NAMES.accessKeyId),
    secretAccessKey: process.env[NAMES.secretAccessKey] ?? "",
    // The operator's own settings, on the server: no address rules.
    fromDashboard: false,
    objectStoreBucket: null,
  };
}

/** The key in an age identity file: its one line that is not a comment. */
async function keyFrom(file: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    fail(
      `The key file ${file} can't be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const key = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("AGE-SECRET-KEY-"));
  if (key === undefined) {
    fail(`${file} holds no backup key: it should have a line starting with AGE-SECRET-KEY-.`);
  }
  return key;
}

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const [command, ...rest] = args;
const destination = destinationFromEnvironment();
const client = backupClient(destination, {
  policy: addressPolicy({ allowPrivate: true }),
  lookup: systemLookup,
});

try {
  if (command === "list") {
    const backups = await listBackups(client, destination.bucket, destination.prefix);
    if (backups.length === 0) {
      fail(`${destination.bucket}/${destination.prefix} holds no backups.`);
    }
    for (const backup of backups) {
      console.log(
        `${backup.name}  ${gib(backup.bytes).padStart(11)}  ${backup.complete ? "whole" : "incomplete (no manifest: not restorable)"}`,
      );
    }
  } else if (command === "describe") {
    const [name, keyFile] = rest;
    if (name === undefined || keyFile === undefined) {
      fail("Usage: restore-backup describe <name|latest> <key file>");
    }
    const identity = await keyFrom(keyFile);
    const { manifest } = await verifiedManifest({
      client,
      destination,
      identity,
      ...(name === "latest" ? {} : { name }),
    });
    console.log(`${manifest.name}\t${manifest.startedAt}\t${manifest.instance.version}`);
  } else if (command === "download") {
    const [name, keyFile, folder] = rest;
    if (name === undefined || keyFile === undefined || folder === undefined) {
      fail("Usage: restore-backup download <name> <key file> <folder>");
    }
    const identity = await keyFrom(keyFile);
    const checked = await testRestore({
      client,
      destination,
      identity,
      writeTo: folder,
      ...(name === "latest" ? {} : { name }),
    });
    console.error(
      `Downloaded ${checked.name} (${gib(checked.bytes)}), decrypted it, and checked every part against its manifest.`,
    );
    console.log(`${folder.replace(/\/+$/, "")}/ottertrail-${checked.name}`);
  } else {
    fail(
      "Usage: restore-backup list | describe <name|latest> <key file> | download <name> <key file> <folder>",
    );
  }
} catch (error) {
  fail(error instanceof BackupError ? error.message : s3ErrorText(error, "read"));
} finally {
  client.destroy();
}
