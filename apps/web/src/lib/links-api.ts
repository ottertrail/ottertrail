import { apiRequest, expectShape } from "./api";
import { isRecord, isText } from "./telemetry-shapes";

/**
 * The public side of invitations and reset links (docs/access.md): no
 * session needed, the token in the body. Every link that no longer works
 * gets one answer, which says nothing else.
 */

export interface InvitationPreview {
  email: string;
  invitedBy: string;
  instanceName: string;
}

const isPreview = (value: unknown): value is { invitation: InvitationPreview } =>
  isRecord(value) &&
  isRecord(value.invitation) &&
  isText(value.invitation.email) &&
  isText(value.invitation.invitedBy) &&
  isText(value.invitation.instanceName);

const isEmail = (value: unknown): value is { email: string } =>
  isRecord(value) && isText(value.email);

export async function previewInvitation(token: string, signal?: AbortSignal) {
  return expectShape(
    await apiRequest("/api/invite/preview", { method: "POST", body: { token }, signal }),
    isPreview,
  ).invitation;
}

/** Creates the account; the page then signs in with the email it answers. */
export async function acceptInvitation(input: {
  token: string;
  name: string;
  password: string;
  confirmPassword: string;
}) {
  return expectShape(
    await apiRequest("/api/invite/accept", { method: "POST", body: input }),
    isEmail,
  );
}

export async function previewReset(token: string, signal?: AbortSignal) {
  return expectShape(
    await apiRequest("/api/reset-password/preview", { method: "POST", body: { token }, signal }),
    isEmail,
  );
}

/** Sets the password; the user's sessions are deleted. */
export async function resetPassword(input: {
  token: string;
  password: string;
  confirmPassword: string;
}) {
  return expectShape(
    await apiRequest("/api/reset-password", { method: "POST", body: input }),
    isEmail,
  );
}
