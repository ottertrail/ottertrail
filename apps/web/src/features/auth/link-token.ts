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

export const PASSWORD_TOO_SHORT = `Use at least ${MIN_PASSWORD_LENGTH} characters for the password.`;
export const PASSWORDS_DIFFER =
  "The passwords do not match. Enter the same password in both fields.";

/**
 * Whether a new password is long enough, counted as the API's schema counts it: UTF-16 units, with
 * a surrogate pair (an emoji, say) as one. The input's own minLength is not enough: browsers check
 * it only for typed text, not for a value a password manager fills in.
 */
export function longEnough(password: string): boolean {
  const pairs = password.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)?.length ?? 0;
  return password.length - pairs >= MIN_PASSWORD_LENGTH;
}

/** What is wrong with a new password and its confirmation, or null. */
export function newPasswordProblem(password: string, confirmation: string): string | null {
  if (!longEnough(password)) return PASSWORD_TOO_SHORT;
  if (password !== confirmation) return PASSWORDS_DIFFER;
  return null;
}
