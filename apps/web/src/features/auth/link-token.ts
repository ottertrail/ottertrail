import * as React from "react";

/**
 * Reads a one-time link's token from its fragment (#token=…) once, then
 * removes it from the address bar, so it does not stay on screen or in the
 * browser's history. Setup, invitation, and reset links carry one.
 */
export function useLinkToken(): string | null {
  const [token] = React.useState(() => {
    const value = new URLSearchParams(window.location.hash.slice(1)).get("token");
    return value === null || value === "" ? null : value;
  });
  React.useEffect(() => {
    if (window.location.hash !== "") {
      window.history.replaceState(
        window.history.state,
        "",
        window.location.pathname + window.location.search,
      );
    }
  }, []);
  return token;
}

/** Matches the API's minimum (MIN_PASSWORD_LENGTH in apps/api/src/auth/auth.ts). */
export const MIN_PASSWORD_LENGTH = 12;
