/** GET /api/setup: whether the instance still needs its owner account. */
export async function fetchOwnerExists(signal?: AbortSignal): Promise<boolean> {
  const response = await fetch("/api/setup", { headers: { accept: "application/json" }, signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("ownerExists" in body)) {
    throw new Error("Unexpected response");
  }
  return body.ownerExists === true;
}

export interface OwnerDetails {
  token: string;
  name: string;
  email: string;
  password: string;
  /** The owner's organization, created with them. */
  organizationName: string;
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
