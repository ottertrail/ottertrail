import { createAuthClient } from "better-auth/react";

/**
 * Talks to the API's sign-in endpoints on this origin (/api/auth/*). The
 * session lives in an httpOnly cookie that page scripts cannot read; the
 * client asks the API who is signed in.
 */
export const authClient = createAuthClient();

/** Turns a failed sign-in into a message for the person signing in. */
export function signInErrorMessage(error: { status: number; message?: string | undefined }) {
  if (error.status === 401) {
    return "Wrong email or password.";
  }
  if (error.status === 429) {
    return "Too many attempts. Wait a minute, then try again.";
  }
  return error.message ?? "Could not sign in. Try again.";
}
