import type { Kysely, Selectable } from "kysely";

import type { Auth } from "../auth/auth.ts";
import { hashToken, newToken } from "../auth/tokens.ts";
import type { Database, DashboardInvitationsTable } from "../db/schema.ts";
import { readInstanceSettings } from "../settings/settings.ts";
import type { AccessChange } from "./grants.ts";
import { setUserAccessIn } from "./grants.ts";
import { type Actor, lockUser, mayGrant, type MemberAccess } from "./members.ts";

/** How long an invitation link works. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** A pending invitation on the Members page. The token is never shown again. */
export interface Invitation {
  id: string;
  email: string;
  role: "admin" | "member";
  /** A member's access; null for an admin. */
  access: MemberAccess | null;
  /** Who invited; their pending invitations go when they are removed. */
  invitedBy: { id: string; name: string };
  expiresAt: Date;
  createdAt: Date;
}

type InvitationRow = Selectable<DashboardInvitationsTable>;

function accessOf(row: InvitationRow): MemberAccess | null {
  return row.role === "admin"
    ? null
    : {
        projects: row.all_projects ? "all" : row.project_ids,
        areas: {
          web_analytics: row.web_analytics,
          product_analytics: row.product_analytics,
          errors: row.errors,
          replays: row.replays,
          users: row.users,
          monitoring: row.monitoring,
          uptime_alerts: row.uptime_alerts,
        },
      };
}

/** An invitation's columns from what it gives. */
function valuesOf(change: AccessChange) {
  if (change.role === "admin") {
    return { role: "admin" as const, all_projects: false, project_ids: [] };
  }
  return {
    role: "member" as const,
    all_projects: change.projects === "all",
    project_ids: change.projects === "all" ? [] : [...change.projects],
    ...change.areas,
  };
}

const NO_AREAS = {
  web_analytics: "none",
  product_analytics: "none",
  errors: "none",
  replays: "none",
  users: "none",
  monitoring: "none",
  uptime_alerts: "none",
} as const;

/** Emails are compared and stored in lower case; a check constraint holds them to it. */
export const invitationEmail = (email: string) => email.trim().toLowerCase();

function baseQuery(db: Kysely<Database>) {
  return db
    .selectFrom("dashboard_invitations as i")
    .innerJoin("dashboard_users as u", "u.id", "i.invited_by")
    .selectAll("i")
    .select("u.name as inviter_name");
}

function invitationOf(row: InvitationRow & { inviter_name: string }): Invitation {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    access: accessOf(row),
    invitedBy: { id: row.invited_by, name: row.inviter_name },
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

/** Every invitation not yet accepted or revoked, the newest first; expired ones too, to renew. */
export async function listInvitations(db: Kysely<Database>): Promise<Invitation[]> {
  const rows = await baseQuery(db).orderBy("i.created_at", "desc").orderBy("i.id").execute();
  return rows.map(invitationOf);
}

/** Keeps the projects that still exist: a list may name one deleted since. */
async function existingProjects(db: Kysely<Database>, ids: readonly string[]) {
  if (ids.length === 0) return [];
  const rows = await db.selectFrom("projects").select("id").where("id", "in", ids).execute();
  return rows.map((row) => row.id);
}

export type CreateResult =
  | { invitation: Invitation; token: string }
  | "account_exists"
  | "forbidden";

/**
 * Invites `email` with what `change` gives, within the role rules: only the
 * owner invites admins. An email with an account is refused; inviting a
 * pending email again replaces its invitation, and the old link stops
 * working, unless the actor could not have made that invitation (an admin
 * replacing the owner's admin invitation). Returns the plain token once:
 * only its hash is kept.
 */
export async function createInvitation(
  db: Kysely<Database>,
  actor: Actor,
  rawEmail: string,
  change: AccessChange,
  now: Date,
): Promise<CreateResult> {
  if (!mayGrant(actor, change.role)) return "forbidden";
  const email = invitationEmail(rawEmail);
  const existing = await db
    .selectFrom("dashboard_users")
    .select("id")
    .where("email", "=", email)
    .executeTakeFirst();
  if (existing !== undefined) return "account_exists";
  const pending = await db
    .selectFrom("dashboard_invitations")
    .select("role")
    .where("email", "=", email)
    .executeTakeFirst();
  if (pending !== undefined && !mayGrant(actor, pending.role)) return "forbidden";
  const given: AccessChange =
    change.role === "member" && change.projects !== "all"
      ? { ...change, projects: await existingProjects(db, change.projects) }
      : change;
  const { token, hash } = newToken();
  const values = {
    ...NO_AREAS,
    ...valuesOf(given),
    token_hash: hash,
    invited_by: actor.id,
    expires_at: new Date(now.getTime() + INVITATION_TTL_MS),
    created_at: now,
  };
  const row = await db
    .insertInto("dashboard_invitations")
    .values({ ...values, email })
    .onConflict((conflict) => conflict.column("email").doUpdateSet(values))
    .returning("id")
    .executeTakeFirstOrThrow();
  const invitation = await findInvitation(db, row.id);
  if (invitation === null) throw new Error("The invitation just stored is missing");
  return { invitation, token };
}

async function findInvitation(db: Kysely<Database>, id: string): Promise<Invitation | null> {
  const row = await baseQuery(db).where("i.id", "=", id).executeTakeFirst();
  return row === undefined ? null : invitationOf(row);
}

/** Whether `actor` may revoke or renew it: an admin only member invitations. */
async function invitationFor(db: Kysely<Database>, actor: Actor, id: string) {
  const invitation = await findInvitation(db, id);
  if (invitation === null) return "not_found" as const;
  if (!mayGrant(actor, invitation.role)) return "forbidden" as const;
  return invitation;
}

/** Revokes an invitation: its link stops working. */
export async function revokeInvitation(
  db: Kysely<Database>,
  actor: Actor,
  id: string,
): Promise<"done" | "not_found" | "forbidden"> {
  const found = await invitationFor(db, actor, id);
  if (typeof found === "string") return found;
  await db.deleteFrom("dashboard_invitations").where("id", "=", id).execute();
  return "done";
}

/**
 * A new link for an invitation, valid 7 days from now. The old link stops
 * working: the plain token cannot be shown again, so a lost link is replaced.
 */
export async function renewInvitation(
  db: Kysely<Database>,
  actor: Actor,
  id: string,
  now: Date,
): Promise<{ invitation: Invitation; token: string } | "not_found" | "forbidden"> {
  const found = await invitationFor(db, actor, id);
  if (typeof found === "string") return found;
  const { token, hash } = newToken();
  await db
    .updateTable("dashboard_invitations")
    .set({ token_hash: hash, expires_at: new Date(now.getTime() + INVITATION_TTL_MS) })
    .where("id", "=", id)
    .execute();
  const invitation = await findInvitation(db, id);
  return invitation === null ? "not_found" : { invitation, token };
}

/**
 * What the accept page shows: who invited whom, and to which instance. Not
 * the role or access: the page does not show them, and whoever holds the
 * link would otherwise learn the instance's project names.
 */
export interface InvitationPreview {
  email: string;
  invitedBy: string;
  instanceName: string;
}

async function validRow(db: Kysely<Database>, token: string, now: Date) {
  return baseQuery(db)
    .where("i.token_hash", "=", hashToken(token))
    .where("i.expires_at", ">", now)
    .executeTakeFirst();
}

/** The invitation a link holds, or null when it no longer works, for whatever reason. */
export async function previewInvitation(
  db: Kysely<Database>,
  token: string,
  now: Date,
): Promise<InvitationPreview | null> {
  const row = await validRow(db, token, now);
  if (row === undefined) return null;
  const invitation = invitationOf(row);
  return {
    email: invitation.email,
    invitedBy: invitation.invitedBy.name,
    instanceName: (await readInstanceSettings(db)).name,
  };
}

/**
 * Accepts an invitation: in one transaction, uses up the token (one row
 * only, so a double submit or a second tab finds nothing), checks the email
 * has no account, creates the user and their password, and stores their
 * grants, dropping projects deleted since. The inviter must still exist
 * and still be allowed to give the role, checked on their locked row: an
 * admin's right ends when they are demoted. Nothing is saved before this,
 * so a link whose page was closed still works. Returns the email to sign
 * in with, or null when the link no longer works.
 */
export async function acceptInvitation(
  db: Kysely<Database>,
  auth: Auth,
  { token, name, password }: { token: string; name: string; password: string },
  now: Date,
): Promise<{ email: string } | null> {
  // The cheap checks first: hashing a password costs about 40 ms on purpose.
  const pending = await validRow(db, token, now);
  if (pending === undefined) return null;
  const passwordHash = await (await auth.$context).password.hash(password);
  try {
    return await acceptIn(db, token, name, passwordHash, now);
  } catch (error) {
    // Someone took the address between the check and the insert (an
    // account created or renamed to it): the link no longer works, as for
    // an address with an account. The transaction rolled back.
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      return null;
    }
    throw error;
  }
}

/** acceptInvitation's transaction, once the password is hashed. */
function acceptIn(
  db: Kysely<Database>,
  token: string,
  name: string,
  passwordHash: string,
  now: Date,
): Promise<{ email: string } | null> {
  return db.transaction().execute(async (trx) => {
    const used = await trx
      .deleteFrom("dashboard_invitations")
      .where("token_hash", "=", hashToken(token))
      .where("expires_at", ">", now)
      .returningAll()
      .executeTakeFirst();
    if (used === undefined) return null;
    const inviter = await lockUser(trx, used.invited_by);
    if (inviter === null || !mayGrant(inviter, used.role)) return null;
    const taken = await trx
      .selectFrom("dashboard_users")
      .select("id")
      .where("email", "=", used.email)
      .executeTakeFirst();
    if (taken !== undefined) return null;
    const user = await trx
      .insertInto("dashboard_users")
      .values({ name, email: used.email, role: used.role })
      .returning("id")
      .executeTakeFirstOrThrow();
    // How Better Auth stores a password: a "credential" account whose ID is the user's.
    await trx
      .insertInto("dashboard_accounts")
      .values({
        user_id: user.id,
        account_id: user.id,
        provider_id: "credential",
        password: passwordHash,
      })
      .execute();
    const access = accessOf(used);
    if (access !== null) {
      await setUserAccessIn(trx, user.id, { role: "member", ...access });
    }
    return { email: used.email };
  });
}
