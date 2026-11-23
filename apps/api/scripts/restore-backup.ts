/**
 * For deploy/restore.sh (docs/deployment.md, "Restoring from S3"). Verify the manifest MAC before
 * reading parts: bucket writers could otherwise forge decryptable backups. Check sizes and SHA-256
 * before and after decryption; remove temporary plaintext on failure. Read BACKUP_S3_* settings
 * through config.ts, parseBackupS3, keeping secrets off command lines. Exits 1 on failure.
 */
import { readFile } from "node:fs/promises";

import { BackupError, testRestore, verifiedManifest } from "../src/backups/run.ts";
import { backupClient, listBackups, s3ErrorText } from "../src/backups/s3.ts";
import type { Destination } from "../src/backups/settings.ts";
import { BACKUP_S3_VARIABLES, loadBackupS3 } from "../src/config.ts";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function destinationFromEnvironment(): Destination {
  // No object store to keep clear of: restoring only reads.
  const destination = loadBackupS3(process.env, null);
  if (destination === null) {
    fail(`Set ${BACKUP_S3_VARIABLES.join(", ")} (restore.sh asks for them).`);
  }
  if ("problem" in destination) fail(destination.problem);
  return destination;
}

/** The key in an age identity file: its one line that is not a comment. */
async function keyFrom(file: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    fail(`Can't read key file ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const key = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("AGE-SECRET-KEY-"));
  if (key === undefined) {
    fail(`${file} needs a key line starting with AGE-SECRET-KEY-.`);
  }
  return key;
}

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const [command, ...rest] = args;
const destination = destinationFromEnvironment();
const client = backupClient(destination);

try {
  if (command === "list") {
    const backups = await listBackups(client, destination.bucket, destination.prefix);
    if (backups.length === 0) {
      fail(`No backups in ${destination.bucket}/${destination.prefix}.`);
    }
    for (const backup of backups) {
      console.log(
        `${backup.name}  ${gib(backup.bytes).padStart(11)}  ${backup.complete ? "complete" : "incomplete (no manifest; cannot restore)"}`,
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
      `Downloaded ${checked.name} (${gib(checked.bytes)}). Decryption and manifest checks passed.`,
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
