import { queryOptions } from "@tanstack/react-query";

/** GET /api/setup: whether the instance still needs its owner, and whether email is set up (SMTP_URL). */
export async function fetchSetupStatus(
  signal?: AbortSignal,
): Promise<{ ownerExists: boolean; emailConfigured: boolean }> {
  const response = await fetch("/api/setup", { headers: { accept: "application/json" }, signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("ownerExists" in body)) {
    throw new Error("Unexpected response");
  }
  return {
    ownerExists: body.ownerExists === true,
    emailConfigured: "emailConfigured" in body && body.emailConfigured === true,
  };
}

/** GET /api/setup in the query cache: the account page reads whether email is set up. */
export const setupStatusQuery = () =>
  queryOptions({
    queryKey: ["setup-status"],
    queryFn: ({ signal }) => fetchSetupStatus(signal),
    staleTime: 60_000,
  });

export interface OwnerDetails {
  token: string;
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
  instanceName: string;
  /** An IANA timezone: reports count days in it. */
  timeZone: string;
}

export type CreateOwnerResult = { ok: true } | { ok: false; message: string };

/** POST /api/setup: creates the owner from a setup link's token. */
export async function createOwner(details: OwnerDetails): Promise<CreateOwnerResult> {
  let response: Response;
  try {
    response = await fetch("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(details),
    });
  } catch {
    return {
      ok: false,
      message: "Could not reach the API. Check that it is running, then try again.",
    };
  }
  if (response.status === 201) {
    return { ok: true };
  }
  const body: unknown = await response.json().catch(() => null);
  const message =
    typeof body === "object" &&
    body !== null &&
    "message" in body &&
    typeof body.message === "string"
      ? body.message
      : `Setup failed (HTTP ${response.status}).`;
  return { ok: false, message };
}
