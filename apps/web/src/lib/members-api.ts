import { queryOptions } from "@tanstack/react-query";

import { type Areas, AREAS, type AreaLevel, type Role } from "./access";
import { apiRequest, expectShape } from "./api";
import { isListOf, isRecord, isText, isTextOrNull } from "./telemetry-shapes";

/**
 * Members, invitations, reset links, and handing over ownership
 * (docs/access.md; apps/api/src/access/member-routes.ts). For the owner and
 * admins; the API applies the role rules.
 */

export interface MemberAccess {
  /** "all" includes projects created later. */
  projects: "all" | string[];
  areas: Areas;
}

export interface Member {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** A member's grants; null for the owner and admins. */
  access: MemberAccess | null;
  lastSignInAt: string | null;
  createdAt: string;
}

export interface Invitation {
  id: string;
  email: string;
  role: "admin" | "member";
  access: MemberAccess | null;
  invitedBy: { id: string; name: string };
  expiresAt: string;
  createdAt: string;
}

export interface MembersAnswer {
  you: { id: string; role: Role };
  invitationDays: number;
  members: Member[];
  invitations: Invitation[];
}

/** What a role change or an invitation gives. */
export type AccessChoice = { role: "admin" } | { role: "member"; access: MemberAccess };

const isLevel = (value: unknown): value is AreaLevel =>
  value === "none" || value === "view" || value === "manage";
const isRole = (value: unknown): value is Role =>
  value === "owner" || value === "admin" || value === "member";

const isAccess = (value: unknown): value is MemberAccess =>
  isRecord(value) &&
  (value.projects === "all" || isListOf(value.projects, isText)) &&
  isRecord(value.areas) &&
  AREAS.every((area) => isRecord(value.areas) && isLevel(value.areas[area]));

const isMember = (value: unknown): value is Member =>
  isRecord(value) &&
  isText(value.id) &&
  isText(value.name) &&
  isText(value.email) &&
  isRole(value.role) &&
  (value.access === null || isAccess(value.access)) &&
  isTextOrNull(value.lastSignInAt) &&
  isText(value.createdAt);

const isInvitation = (value: unknown): value is Invitation =>
  isRecord(value) &&
  isText(value.id) &&
  isText(value.email) &&
  (value.role === "admin" || value.role === "member") &&
  (value.access === null || isAccess(value.access)) &&
  isRecord(value.invitedBy) &&
  isText(value.invitedBy.id) &&
  isText(value.invitedBy.name) &&
  isText(value.expiresAt) &&
  isText(value.createdAt);

const isMembersAnswer = (value: unknown): value is MembersAnswer =>
  isRecord(value) &&
  isRecord(value.you) &&
  isText(value.you.id) &&
  isRole(value.you.role) &&
  typeof value.invitationDays === "number" &&
  isListOf(value.members, isMember) &&
  isListOf(value.invitations, isInvitation);

const isLinked = (value: unknown): value is { invitation: Invitation; url: string } =>
  isRecord(value) && isInvitation(value.invitation) && isText(value.url);

const isResetLink = (value: unknown): value is { url: string; expiresAt: string } =>
  isRecord(value) && isText(value.url) && isText(value.expiresAt);

export const membersKey = ["members"] as const;

export const membersQuery = () =>
  queryOptions({
    queryKey: membersKey,
    queryFn: async ({ signal }) =>
      expectShape(await apiRequest("/api/members", { signal }), isMembersAnswer),
  });

const bodyOf = (choice: AccessChoice) =>
  choice.role === "admin" ? { role: "admin" } : { role: "member", access: choice.access };

/** Invites `email`: the link to copy, which is not shown again. */
export async function inviteMember(email: string, choice: AccessChoice) {
  const body = await apiRequest("/api/invitations", {
    method: "POST",
    body: { email, ...bodyOf(choice) },
  });
  return expectShape(body, isLinked);
}

/** A new link for an invitation; the old one stops working. */
export async function renewInvitation(id: string) {
  const body = await apiRequest(`/api/invitations/${encodeURIComponent(id)}/link`, {
    method: "POST",
  });
  return expectShape(body, isLinked);
}

export async function revokeInvitation(id: string) {
  await apiRequest(`/api/invitations/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function changeMember(userId: string, choice: AccessChoice) {
  await apiRequest(`/api/members/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    body: bodyOf(choice),
  });
}

/** Deletes the account and its sessions. */
export async function removeMember(userId: string) {
  await apiRequest(`/api/members/${encodeURIComponent(userId)}`, { method: "DELETE" });
}

/** A one-time link that sets the user's password, valid 24 hours. */
export async function makeResetLink(userId: string) {
  const body = await apiRequest(`/api/members/${encodeURIComponent(userId)}/reset-link`, {
    method: "POST",
  });
  return expectShape(body, isResetLink);
}

/** Hands the instance to another user; the owner types their password again. */
export async function handOverOwnership(userId: string, password: string) {
  await apiRequest(`/api/members/${encodeURIComponent(userId)}/ownership`, {
    method: "POST",
    body: { password },
  });
}
