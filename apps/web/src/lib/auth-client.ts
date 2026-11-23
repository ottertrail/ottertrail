import { queryOptions } from "@tanstack/react-query";
import { createAuthClient } from "better-auth/react";

import { ApiError, UNREACHABLE } from "./api";

/** The session uses an httpOnly cookie. Ask /api/auth/* who is signed in. */
export const authClient = createAuthClient();

/**
 * Only a missing session or 401 means signed out. Throw on other failures
 * (including 429) so pages report a failed check.
 */
export async function checkSession(): Promise<boolean> {
  let answer: Awaited<ReturnType<typeof authClient.getSession>>;
  try {
    answer = await authClient.getSession();
  } catch {
    // fetch rejects only when no answer came: the network, or nothing listening.
    throw new ApiError(0, "Could not reach the API to check your session.", UNREACHABLE);
  }
  const { data, error } = answer;
  if (error) {
    if (error.status === 401) {
      return false;
    }
    throw new ApiError(
      error.status,
      error.status === 429
        ? "Too many requests to check your session. Wait a few seconds."
        : `Your session could not be checked (${error.status}).`,
    );
  }
  return data !== null;
}

/**
 * Cache signed-in sessions for 30 seconds to avoid checks between pages.
 * Recheck signed-out sessions immediately to detect sign-in. Sign-out and 401s
 * (router.tsx) clear the query cache.
 */
export const sessionQuery = () =>
  queryOptions({
    queryKey: ["session"],
    queryFn: checkSession,
    staleTime: (query) => (query.state.data === true ? 30_000 : 0),
  });

export function signInErrorMessage(error: { status: number; message?: string | undefined }) {
  if (error.status === 401) {
    return "Wrong email or password.";
  }
  if (error.status === 429) {
    return "Too many attempts. Try again in a minute.";
  }
  return error.message ?? "Could not sign in. Try again.";
}
