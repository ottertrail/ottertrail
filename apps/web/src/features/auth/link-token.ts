import * as React from "react";

/** Remove the one-time token from the address bar and browser history after reading it. */
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
