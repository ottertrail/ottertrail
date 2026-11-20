/**
 * Prints a one-time link that creates the instance's owner, the first
 * dashboard account:
 *
 *   vp run setup
 *
 * The link works once, for an hour. Running the command again replaces it.
 * Once an owner exists, the command refuses: there is only one owner.
 */
import { createSetupToken, SETUP_LINK_TTL_MS } from "../src/auth/setup.ts";
import { DEVELOPMENT_PUBLIC_URL, loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/database.ts";

const config = loadConfig();
const db = createDatabase({ connectionString: config.databaseUrl, maxConnections: 1 });

try {
  const link = await createSetupToken(db);
  if (link === null) {
    console.error(`Owner already exists. Sign in at ${config.publicUrl}/sign-in`);
    process.exitCode = 1;
  } else {
    // The token goes in the fragment (after #), which browsers never send to
    // a server, so it cannot end up in request logs or proxies.
    console.log(
      [
        `Create the owner account within ${SETUP_LINK_TTL_MS / 60_000} minutes:`,
        "",
        `  ${config.publicUrl}/setup#token=${link.token}`,
        "",
        "The link works once. Running this command again replaces it.",
        ...(config.publicUrl === DEVELOPMENT_PUBLIC_URL
          ? [
              "",
              "If port 5173 was taken, use the address the dashboard dev server printed,",
              "with the same /setup#token=… part.",
            ]
          : []),
      ].join("\n"),
    );
  }
} finally {
  await db.destroy();
}
