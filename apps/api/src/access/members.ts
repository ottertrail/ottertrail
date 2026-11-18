import type { Kysely, Transaction } from "kysely";

import type { Auth } from "../auth/auth.ts";
import type { Database } from "../db/schema.ts";
import type { Areas, Role } from "./areas.ts";
import { type AccessChange, setUserAccessIn } from "./grants.ts";

/** A member's access as the Members page shows and sends it. */
export interface MemberAccess {
  /** "all" includes projects created later. */
  projects: "all" | string[];
  areas: Areas;
}

/** A dashboard user on the Members page. */
export interface Member {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** A member's grants; null for the owner and admins, who reach everything. */
  access: MemberAccess | null;
  lastSignInAt: Date | null;
  createdAt: Date;
}

/** Who acts: the signed-in user's ID and role. */
export interface Actor {
  id: string;
  role: Role;
}

/**
 * Whether `actor` may change, remove, or make a reset link for `target`
 * (docs/access.md): the owner for anyone else, an admin for members only.
 * Nobody acts on themselves here, and nobody on the owner.
 */
export function mayManage(actor: Actor, target: Actor): boolean {
  if (target.id === actor.id || target.role === "owner") return false;
  if (actor.role === "owner") return true;
  return actor.role === "admin" && target.role === "member";
}

/** Whether `actor` may give `role` to someone: only the owner makes admins. */
export function mayGrant(actor: Actor, role: "admin" | "member"): boolean {
  return actor.role === "owner" || (actor.role === "admin" && role === "member");
}

/** Every dashboard user, the owner first, then by name. */
export async function listMembers(db: Kysely<Database>): Promise<Member[]> {
  const rows = await db
    .selectFrom("dashboard_users as u")
    .leftJoin("dashboard_member_access as a", "a.user_id", "u.id")
    .select([
      "u.id",
      "u.name",
      "u.email",
      "u.role",
      "u.last_sign_in_at",
      "u.created_at",
      "a.user_id as grant_user_id",
      "a.all_projects",
      "a.web_analytics",
      "a.product_analytics",
      "a.errors",
      "a.replays",
      "a.users",
      "a.monitoring",
      "a.uptime_alerts",
    ])
    .execute();
  const projectRows = await db
    .selectFrom("dashboard_member_projects")
    .select(["user_id", "project_id"])
    .execute();
  const roleOrder: Record<Role, number> = { owner: 0, admin: 1, member: 2 };
  return rows
    .map((row): Member => {
      const access: MemberAccess | null =
        row.role !== "member"
          ? null
          : {
              projects:
                row.all_projects === true
                  ? "all"
                  : projectRows
                      .filter((project) => project.user_id === row.id)
                      .map((project) => project.project_id),
              areas: {
                web_analytics: row.web_analytics ?? "none",
                product_analytics: row.product_analytics ?? "none",
                errors: row.errors ?? "none",
                replays: row.replays ?? "none",
                users: row.users ?? "none",
                monitoring: row.monitoring ?? "none",
                uptime_alerts: row.uptime_alerts ?? "none",
              },
            };
      return {
        id: row.id,
        name: row.name,
        email: row.email,
        role: row.role,
        access,
        lastSignInAt: row.last_sign_in_at,
        createdAt: row.created_at,
      };
    })
    .toSorted(
      (a, b) =>
        roleOrder[a.role] - roleOrder[b.role] ||
        a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
    );
}

/**
 * A user's ID and role, their row locked until the transaction ends, so a
 * role checked against stays the role acted on: the owner promoting
 * someone at the same moment waits, or is waited for.
 */
export async function lockUser(trx: Transaction<Database>, id: string): Promise<Actor | null> {
  return (
    (await trx
      .selectFrom("dashboard_users")
      .select(["id", "role"])
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirst()) ?? null
  );
}

/** Deletes what a user made that their role no longer allows: invitations and reset links. */
async function dropWhatTheyMade(trx: Transaction<Database>, userId: string) {
  await trx.deleteFrom("dashboard_invitations").where("invited_by", "=", userId).execute();
  await trx.deleteFrom("dashboard_password_resets").where("created_by", "=", userId).execute();
}

export type MemberResult = "done" | "not_found" | "forbidden";

/**
 * Changes a user's role or a member's access, within the role rules,
 * their row locked first. Their own reset link goes (setUserAccessIn). An
 * admin made a member loses the invitations and reset links they made:
 * they could no longer make them.
 */
export async function changeMember(
  db: Kysely<Database>,
  actor: Actor,
  targetId: string,
  change: AccessChange,
): Promise<MemberResult> {
  return db.transaction().execute(async (trx) => {
    const target = await lockUser(trx, targetId);
    if (target === null) return "not_found";
    if (!mayManage(actor, target) || !mayGrant(actor, change.role)) return "forbidden";
    await setUserAccessIn(trx, target.id, change);
    if (target.role === "admin" && change.role === "member") {
      await dropWhatTheyMade(trx, target.id);
    }
    return "done";
  });
}

/**
 * Deletes a user, within the role rules: their sessions, password, grants,
 * pending invitations, and reset links (theirs, and those they made) go
 * with them (foreign keys), so they are signed out at once. What they did
 * stays: error_resolutions.resolved_by becomes null. The row is locked
 * while its role is checked, and only deleted with that role.
 */
export async function removeMember(
  db: Kysely<Database>,
  actor: Actor,
  targetId: string,
): Promise<MemberResult> {
  return db.transaction().execute(async (trx) => {
    const target = await lockUser(trx, targetId);
    if (target === null) return "not_found";
    if (!mayManage(actor, target)) return "forbidden";
    const deleted = await trx
      .deleteFrom("dashboard_users")
      .where("id", "=", target.id)
      .where("role", "=", target.role)
      .where("role", "<>", "owner")
      .executeTakeFirst();
    return deleted.numDeletedRows > 0n ? "done" : "not_found";
  });
}

/** Whether `password` is the user's own, checked against Better Auth's hash. */
export async function checkPassword(
  db: Kysely<Database>,
  auth: Auth,
  userId: string,
  password: string,
): Promise<boolean> {
  const account = await db
    .selectFrom("dashboard_accounts")
    .select("password")
    .where("user_id", "=", userId)
    .where("provider_id", "=", "credential")
    .executeTakeFirst();
  if (account?.password == null) return false;
  return (await auth.$context).password.verify({ hash: account.password, password });
}

/**
 * Hands the instance to another user, after the owner typed their password
 * again: the old owner becomes an admin, the new one loses any member
 * grants. Demoting first keeps the one-owner index satisfied. The heir's
 * row is locked first; should promoting them change nothing, the whole
 * change rolls back, so the instance never ends without an owner. Both
 * users' own reset links go, and the old owner's pending admin
 * invitations, which an admin could not make.
 */
export async function transferOwnership(
  db: Kysely<Database>,
  auth: Auth,
  ownerId: string,
  targetId: string,
  password: string,
): Promise<"done" | "not_found" | "wrong_password"> {
  if (!(await checkPassword(db, auth, ownerId, password))) return "wrong_password";
  return db.transaction().execute(async (trx) => {
    const target = await lockUser(trx, targetId);
    if (target === null || target.id === ownerId) return "not_found";
    const demoted = await trx
      .updateTable("dashboard_users")
      .set({ role: "admin" })
      .where("id", "=", ownerId)
      .where("role", "=", "owner")
      .executeTakeFirst();
    if (demoted.numUpdatedRows === 0n) return "not_found";
    const promoted = await trx
      .updateTable("dashboard_users")
      .set({ role: "owner" })
      .where("id", "=", target.id)
      .executeTakeFirst();
    if (promoted.numUpdatedRows === 0n) {
      throw new Error("The new owner's row is gone: ownership stays where it was");
    }
    await trx.deleteFrom("dashboard_member_access").where("user_id", "=", target.id).execute();
    await trx
      .deleteFrom("dashboard_password_resets")
      .where("user_id", "in", [ownerId, target.id])
      .execute();
    await trx
      .deleteFrom("dashboard_invitations")
      .where("invited_by", "=", ownerId)
      .where("role", "=", "admin")
      .execute();
    return "done";
  });
}
