import { betterAuth } from "better-auth";
import type { Kysely } from "kysely";
import * as z from "zod";

import type { Database } from "../db/schema.ts";

export const AUTH_BASE_PATH = "/api/auth";

/**
 * Set from request.ip (TRUST_PROXY), replacing client input so callers cannot
 * rotate this header to bypass sign-in limits.
 */
export const CLIENT_IP_HEADER = "x-ottertrail-client-ip";

/** NIST SP 800-63B asks for at least 8; dashboard accounts guard customer data. */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

/**
 * Match Better Auth's pinned zod email rule. Accounts it rejects, such as
 * ops!alerts@example.com, could be created but never sign in otherwise.
 */
const signInEmail = z.email();
export function canSignInWith(email: string): boolean {
  return signInEmail.safeParse(email).success;
}

export interface AuthOptions {
  db: Kysely<Database>;
  publicUrl: string;
  trustedOrigins: string[];
  secret: string;
  /** Off only in tests that sign in many times in a row. */
  rateLimit?: boolean;
}

/**
 * Sign-in for dashboard users, with Better Auth's core features only:
 * email and password, and sessions stored in PostgreSQL. No plugins.
 *
 * - Nobody can sign up: the owner is created by the setup flow
 *   (auth/setup.ts), and teammates will join by invitation (docs/access.md).
 * - Sessions are random tokens in an httpOnly cookie, stored in
 *   dashboard_sessions, so signing out or revoking a session takes effect at
 *   once. They last 7 days and renew while in use.
 * - Session rows keep the browser's User-Agent but no IP address.
 * - Requests that change something must come from a trusted origin, which
 *   blocks cross-site request forgery.
 */
export function createAuth({
  db,
  publicUrl,
  trustedOrigins,
  secret,
  rateLimit = true,
}: AuthOptions) {
  return betterAuth({
    appName: "Ottertrail",
    baseURL: publicUrl,
    basePath: AUTH_BASE_PATH,
    secret,
    trustedOrigins,
    database: { db, type: "postgres" },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
      revokeSessionsOnPasswordReset: true,
    },
    user: {
      modelName: "dashboard_users",
      fields: {
        emailVerified: "email_verified",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
      additionalFields: {
        // Only server code sets roles (docs/access.md). Access checks reread role and
        // grants from the database (access/access.ts).
        role: { type: "string", required: true, defaultValue: "member", input: false },
      },
    },
    // Use account/routes.ts for checked and limited account updates. Disable Better
    // Auth's alternatives, user deletion, and credential unlinking.
    disabledPaths: [
      "/update-user",
      "/change-email",
      "/change-password",
      "/delete-user",
      "/delete-user/callback",
      "/unlink-account",
    ],
    session: {
      modelName: "dashboard_sessions",
      fields: {
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
        userId: "user_id",
      },
    },
    account: {
      modelName: "dashboard_accounts",
      fields: {
        accountId: "account_id",
        providerId: "provider_id",
        userId: "user_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    verification: {
      modelName: "dashboard_verifications",
      fields: {
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    databaseHooks: {
      session: {
        create: {
          // Drop Better Auth's default session IP to avoid storing addresses.
          before: async (session) => ({ data: { ...session, ipAddress: undefined } }),
          // For the Members page: when each user last signed in.
          after: async (session) => {
            await db
              .updateTable("dashboard_users")
              .set({ last_sign_in_at: new Date() })
              .where("id", "=", session.userId)
              .execute();
          },
        },
      },
    },
    rateLimit: { enabled: rateLimit, storage: "memory" },
    advanced: {
      // Keep origin checks active in tests; Better Auth otherwise skips them.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      cookiePrefix: "ottertrail",
      useSecureCookies: publicUrl.startsWith("https:"),
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER], ipv6Subnet: 64 },
      database: { generateId: "uuid" },
    },
    telemetry: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;
