import { queryOptions } from "@tanstack/react-query";
import { createAuthClient } from "better-auth/react";

import { ApiError, UNREACHABLE } from "./api";

/**
 * Talks to the API's sign-in endpoints on this origin (/api/auth/*). The
 * session lives in an httpOnly cookie that page scripts cannot read; the
 * client asks the API who is signed in.
 */
export const authClient = createAuthClient();

/**
 * Whether someone is signed in. Only the API's answer that there is no
 * session (none, or a 401) means no: any other failure, such as Better
 * Auth's rate limit (429) or the API being down, throws, so a page says the
 * check failed instead of signing the person out.
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
 * The session check, kept 30 seconds while signed in, so moving between
 * pages does not ask each time; a "signed out" answer is asked again at
 * once, so signing in is seen. Signing out, and any 401 (router.tsx),
 * clear the query cache, this answer included.
 */
export const sessionQuery = () =>
  queryOptions({
    queryKey: ["session"],
    queryFn: checkSession,
    staleTime: (query) => (query.state.data === true ? 30_000 : 0),
  });

/** Turns a failed sign-in into a message for the person signing in. */
export function signInErrorMessage(error: { status: number; message?: string | undefined }) {
  if (error.status === 401) {
    return "Wrong email or password.";
  }
  if (error.status === 429) {
    return "Too many attempts. Try again in a minute.";
  }
  return error.message ?? "Could not sign in. Try again.";
}
