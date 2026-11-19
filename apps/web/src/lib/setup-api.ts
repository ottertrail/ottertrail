/** GET /api/setup: whether the instance still needs its owner, and whether alert email is set up. */
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

/** GET /api/setup: whether the instance still needs its owner account. */
export async function fetchOwnerExists(signal?: AbortSignal): Promise<boolean> {
  return (await fetchSetupStatus(signal)).ownerExists;
}

export interface OwnerDetails {
  token: string;
  name: string;
  email: string;
  password: string;
  /** The same again: the API checks it too. */
  confirmPassword: string;
  /** The instance's display name, shown at the top of the sidebar. */
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
      message: "Could not reach the API. Check that it is running. Then try again.",
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
