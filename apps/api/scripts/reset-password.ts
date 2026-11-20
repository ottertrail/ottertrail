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
  console.error("Usage: vp run reset-password -- <email>");
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
    console.error(`No account for ${email}.`);
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
        `Set the password for ${email} within ${COMMAND_RESET_TTL_MS / 60_000} minutes:`,
        "",
        `  ${config.publicUrl}/reset-password#token=${token}`,
        "",
        "The link works once. Running this command again replaces it.",
        ...(config.publicUrl === DEVELOPMENT_PUBLIC_URL
          ? [
              "",
              "If port 5173 was taken, use the address the dashboard dev server printed,",
              "with the same /reset-password#token=… part.",
            ]
          : []),
      ].join("\n"),
    );
  }
} finally {
  await db.destroy();
}
