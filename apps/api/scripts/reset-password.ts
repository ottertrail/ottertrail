/**
 * Prints a one-time link that sets a dashboard user's password, for the
 * owner or any account, from the server (docs/access.md):
 *
 *   vp run reset-password -- <email>
 *   node dist/reset-password.mjs <email>      (built)
 *
 * The link works once, for an hour, and replaces any earlier reset link of
 * the user. Using it signs the user out everywhere; the old password works
 * until then.
 */
import { COMMAND_RESET_TTL_MS, createPasswordReset } from "../src/access/password-resets.ts";
import { DEVELOPMENT_PUBLIC_URL, loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/database.ts";

const email = process.argv
  .slice(2)
  .find((arg) => arg !== "--")
  ?.trim()
  .toLowerCase();
if (email === undefined || email === "") {
  console.error("Specify the account: vp run reset-password -- <email>");
  process.exit(1);
}

const config = loadConfig();
const db = createDatabase({ connectionString: config.databaseUrl, maxConnections: 1 });

try {
  const user = await db
    .selectFrom("dashboard_users")
    .select("id")
    .where("email", "=", email)
    .executeTakeFirst();
  if (user === undefined) {
    console.error(`No dashboard account has the email ${email}.`);
    process.exitCode = 1;
  } else {
    const { token } = await createPasswordReset(db, user.id, {
      madeBy: "command",
      ttlMs: COMMAND_RESET_TTL_MS,
      now: new Date(),
    });
    // The token goes in the fragment (after #), which browsers never send to
    // a server, so it cannot end up in request logs or proxies.
    console.log(
      [
        `Open this link within ${COMMAND_RESET_TTL_MS / 60_000} minutes to set the password of ${email}:`,
        "",
        `  ${config.publicUrl}/reset-password#token=${token}`,
        "",
        "The link works once. Running this command again replaces it.",
        ...(config.publicUrl === DEVELOPMENT_PUBLIC_URL
          ? [
              "",
              "In development, the dashboard dev server selects the next free port if 5173 is in use.",
              "If it printed a different address, use that address with the same /reset-password#token=… part.",
            ]
          : []),
      ].join("\n"),
    );
  }
} finally {
  await db.destroy();
}
