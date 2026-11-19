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
    console.error(`This instance already has an owner. Sign in at ${config.publicUrl}/sign-in`);
    process.exitCode = 1;
  } else {
    // The token goes in the fragment (after #), which browsers never send to
    // a server, so it cannot end up in request logs or proxies.
    console.log(
      [
        `Open this link within ${SETUP_LINK_TTL_MS / 60_000} minutes to create the owner account:`,
        "",
        `  ${config.publicUrl}/setup#token=${link.token}`,
        "",
        "The link works once. Running this command again replaces it.",
        ...(config.publicUrl === DEVELOPMENT_PUBLIC_URL
          ? [
              "",
              "In development, the dashboard dev server selects the next free port if 5173 is in use.",
              "If it printed a different address, use that address with the same /setup#token=… part.",
            ]
          : []),
      ].join("\n"),
    );
  }
} finally {
  await db.destroy();
}
