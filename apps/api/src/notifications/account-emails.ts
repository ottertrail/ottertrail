import { type Kysely, sql, type Transaction } from "kysely";

import { createPasswordReset, EMAILED_RESET_TTL_MS } from "../access/password-resets.ts";
import type { AccountEmailKind, Database } from "../db/schema.ts";
import { readInstanceSettings } from "../settings/settings.ts";
import { LAST_ATTEMPT_LEASE_SECONDS, MAX_ATTEMPTS, RETRY_DELAYS_SECONDS } from "./deliveries.ts";
import {
  EMAIL_TIMEOUT_MS,
  type Mailer,
  type MailMessage,
  mailError,
  MAX_SUBJECT,
  oneLine,
} from "./email.ts";
import { type LinkSealer, sealBinding } from "./link-sealer.ts";

/**
 * Account email (docs/access.md, "Account email"): a reset link someone
 * asked for on the sign-in page, a reset link an owner or admin made, the
 * notice that a password was changed, an invitation, and the notice to an
 * old address that the account's email changed. Only when the instance
 * has SMTP set up; the API enqueues nothing otherwise.
 *
 * The API writes a row to account_emails (enqueueAccountEmail) and
 * answers; the worker sends it (AccountEmailSender), with the alert
 * deliveries' retries, and deletes the row once it is sent or given up.
 * A row with a link (an invitation, a reset link) holds it until then:
 * seconds usually, about an hour through every retry, and a day at most,
 * when every row is deleted. The link is sealed (link-sealer.ts,
 * AES-GCM with a key from AUTH_SECRET), so a dump of the database holds
 * no working link without the secret too.
 *
 * A request for a reset link holds only the address typed: the worker
 * looks the account up and makes the link, so the request does the same
 * work whether or not an account has the address. At most one such
 * request waits per address (a partial unique index); the worker seals
 * the link it made into the row, so a retry sends the same link.
 *
 * The worker takes invitations, reset links, and notices before reset
 * requests, so a flood of requests cannot hold them back.
 *
 * Kept apart from notification_deliveries: these never show among a
 * channel's deliveries, and a channel's limits never hold them back.
 */

/** What each kind's message names, besides the instance (read when it is sent). */
export interface AccountEmailParams {
  /** Asked for on the sign-in page: the worker makes the link, for the account with the address. */
  password_reset: Record<string, never>;
  /** Made on the Members page by `maker`, and emailed. */
  reset_link: { link: string; maker: string };
  password_changed: Record<string, never>;
  invitation: { link: string; inviter: string; invitedEmail: string };
  /** Sent to the old address. */
  email_changed: { oldEmail: string; newEmail: string };
}

export type AccountEmail = {
  [K in AccountEmailKind]: { kind: K; to: string; params: AccountEmailParams[K] };
}[AccountEmailKind];

/** What a message is made from: a reset asked for carries the link the worker made. */
export type AccountMessage =
  | Exclude<AccountEmail, { kind: "password_reset" }>
  | { kind: "password_reset"; to: string; params: { link: string } };

type Db = Kysely<Database> | Transaction<Database>;

/** What a row stores: the email's params, with any link sealed. */
function storedParams(email: AccountEmail, sealer: LinkSealer): Record<string, string> {
  const bound = sealBinding(email.kind, email.to);
  switch (email.kind) {
    case "reset_link":
      return { sealedLink: sealer.seal(email.params.link, bound), maker: email.params.maker };
    case "invitation":
      return {
        sealedLink: sealer.seal(email.params.link, bound),
        inviter: email.params.inviter,
        invitedEmail: email.params.invitedEmail,
      };
    case "email_changed":
      return { ...email.params };
    default:
      return {};
  }
}

/**
 * Queues an email for the worker; it is sent within seconds. A reset
 * request for an address that already has one waiting adds nothing.
 */
export async function enqueueAccountEmail(
  db: Db,
  email: AccountEmail,
  sealer: LinkSealer,
): Promise<void> {
  const params = JSON.stringify(storedParams(email, sealer));
  if (email.kind === "password_reset") {
    await sql`
      insert into account_emails (kind, to_address, params)
      values ('password_reset', ${email.to}, ${params}::jsonb)
      on conflict (to_address) where kind = 'password_reset' do nothing
    `.execute(db);
    return;
  }
  await db
    .insertInto("account_emails")
    .values({ kind: email.kind, to_address: email.to, params })
    .execute();
}

/**
 * Deletes the queued emails of a kind to an address not yet sent: a new
 * invitation or reset link replaces one whose link no longer works.
 */
export async function dropQueuedAccountEmails(
  db: Db,
  kind: AccountEmailKind,
  to: string,
): Promise<void> {
  await db
    .deleteFrom("account_emails")
    .where("kind", "=", kind)
    .where("to_address", "=", to)
    .execute();
}

/** A subject line: the instance's name first, on one line, not too long. */
function subjectOf(instance: string, text: string): string {
  const line = oneLine(`${instance}: ${text}`);
  return line.length <= MAX_SUBJECT ? line : `${line.slice(0, MAX_SUBJECT - 1)}…`;
}

const escapeHtml = (text: string) =>
  text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");

/** A line of a message: text, or a link shown as itself. */
type Line = string | { link: string };

/**
 * A message from paragraphs of lines: plain text, and the same as simple
 * HTML with every value escaped and each link as itself.
 */
function messageOf(subject: string, paragraphs: Line[][]): Omit<MailMessage, "to"> {
  const text = `${paragraphs
    .map((lines) => lines.map((line) => (typeof line === "string" ? line : line.link)).join("\n"))
    .join("\n\n")}\n`;
  const body = paragraphs
    .map(
      (lines) =>
        `<p>${lines
          .map((line) =>
            typeof line === "string"
              ? escapeHtml(line)
              : `<a href="${escapeHtml(line.link)}">${escapeHtml(line.link)}</a>`,
          )
          .join("<br>\n")}</p>`,
    )
    .join("\n");
  const html = `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>\n<body style="font-family: sans-serif; line-height: 1.5">\n${body}\n</body></html>\n`;
  return { subject, text, html };
}

/** An account email's subject and body, for the instance named `instanceName`. */
export function accountEmailMessage(
  email: AccountMessage,
  instanceName: string,
): Omit<MailMessage, "to"> {
  const instance = oneLine(instanceName);
  switch (email.kind) {
    case "password_reset":
      return messageOf(subjectOf(instance, "Reset your password"), [
        [`You requested a password reset for ${instance} on Ottertrail.`],
        ["Set a new password:", { link: email.params.link }],
        [
          "This link works once and expires in 1 hour.",
          "A newer request replaces this link.",
          "Your current password works until you reset it.",
        ],
        ["If you didn't request this, you can ignore this email."],
      ]);
    case "reset_link": {
      const maker = oneLine(email.params.maker);
      return messageOf(subjectOf(instance, "Reset your password"), [
        [`${maker} made a password reset link for your Ottertrail account on ${instance}.`],
        ["Set a new password:", { link: email.params.link }],
        [
          "This link works once and expires in 24 hours.",
          "Your current password works until you reset it.",
        ],
        [`If you weren't expecting this, ask ${maker} about it before you use the link.`],
      ]);
    }
    case "password_changed":
      return messageOf(subjectOf(instance, "Your password was changed"), [
        [`Your Ottertrail password for ${instance} was changed.`],
        ["All sessions that were active before the reset were ended."],
        ["If you didn't make this change, contact the person who runs this instance."],
      ]);
    case "invitation": {
      const inviter = oneLine(email.params.inviter);
      return messageOf(subjectOf(instance, `Invitation from ${inviter}`), [
        [`${inviter} invited you to the Ottertrail instance ${instance}.`],
        ["Create your account:", { link: email.params.link }],
        [`This invitation is for ${email.params.invitedEmail} and expires in 7 days.`],
        ["If you weren't expecting it, you can ignore this email."],
      ]);
    }
  }
  // email_changed: to the old address.
  return messageOf(subjectOf(instance, "Your account email was changed"), [
    [
      `Your Ottertrail account email for ${instance} changed from:`,
      email.params.oldEmail,
      "to:",
      email.params.newEmail,
    ],
    ["If you didn't make this change, contact the person who runs this instance."],
  ]);
}

/** The test email from the Notification channels tab, sent at once rather than queued. */
export function testEmailMessage(instanceName: string): Omit<MailMessage, "to"> {
  const instance = oneLine(instanceName);
  return messageOf(subjectOf(instance, "Test email"), [
    [`This is a test email from the Ottertrail instance ${instance}.`],
    [
      "If you can read it, email from this instance reaches you: invitations, reset links, and email alerts. You don't need to do anything.",
    ],
  ]);
}

/** Account emails one worker sends at once. */
export const MAX_ACCOUNT_SENDING = 5;

/** A row the worker took: its attempt already counted. */
export interface DueAccountEmail {
  id: string;
  kind: AccountEmailKind;
  to: string;
  params: unknown;
  /** This attempt's number, from 1. */
  attempt: number;
}

/** Deletes every row a day old, sent or not: none keeps a link longer. How many. */
export async function pruneAccountEmails(db: Kysely<Database>, now?: Date): Promise<number> {
  const at = sql`coalesce(${now ?? null}::timestamptz, now())`;
  const result = await sql`
    delete from account_emails where created_at < ${at} - interval '1 day'
  `.execute(db);
  return Number(result.numAffectedRows ?? 0n);
}

/**
 * Takes up to `limit` due account emails, each one's attempt counted and
 * its next attempt moved on before anything is sent, as alert deliveries
 * are (deliveries.ts, takeDueDeliveries), never by two workers at once.
 * Invitations, reset links, and notices come before reset requests, then
 * the oldest first. Rows whose last attempt never finished are deleted
 * first.
 */
export async function takeDueAccountEmails(
  db: Kysely<Database>,
  { limit, now }: { limit: number; now?: Date | undefined },
): Promise<DueAccountEmail[]> {
  if (limit <= 0) return [];
  const at = sql`coalesce(${now ?? null}::timestamptz, now())`;
  const delays = [...RETRY_DELAYS_SECONDS, LAST_ATTEMPT_LEASE_SECONDS];
  return db.transaction().execute(async (trx) => {
    await sql`
      delete from account_emails
      where attempts >= ${MAX_ATTEMPTS} and next_attempt_at <= ${at}
    `.execute(trx);
    const taken = await sql<{
      id: string;
      kind: AccountEmailKind;
      to_address: string;
      params: unknown;
      attempts: number;
    }>`
      with due as (
        select id from account_emails
        where attempts < ${MAX_ATTEMPTS} and next_attempt_at <= ${at}
        order by (kind = 'password_reset'), next_attempt_at, id
        limit ${limit}
        for update skip locked
      )
      update account_emails as a
      set attempts = a.attempts + 1,
        next_attempt_at = ${at} + make_interval(secs => (${delays}::int[])[a.attempts + 1])
      from due
      where a.id = due.id
      returning a.id, a.kind, a.to_address, a.params, a.attempts
    `.execute(trx);
    return taken.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      to: row.to_address,
      params: row.params,
      attempt: row.attempts,
    }));
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const textOf = (record: Record<string, unknown>, key: string) =>
  typeof record[key] === "string" ? record[key] : null;

/**
 * A stored row as the email it stands for; null when it is not one, or
 * its link cannot be opened (AUTH_SECRET changed since).
 */
function emailOf(row: DueAccountEmail, sealer: LinkSealer): AccountEmail | null {
  const params = isRecord(row.params) ? row.params : {};
  const sealed = textOf(params, "sealedLink");
  const link = sealed === null ? null : sealer.open(sealed, sealBinding(row.kind, row.to));
  switch (row.kind) {
    case "password_reset":
    case "password_changed":
      return { kind: row.kind, to: row.to, params: {} };
    case "reset_link": {
      const maker = textOf(params, "maker");
      return link === null || maker === null
        ? null
        : { kind: row.kind, to: row.to, params: { link, maker } };
    }
    case "invitation": {
      const inviter = textOf(params, "inviter");
      const invitedEmail = textOf(params, "invitedEmail");
      return link === null || inviter === null || invitedEmail === null
        ? null
        : { kind: row.kind, to: row.to, params: { link, inviter, invitedEmail } };
    }
    case "email_changed": {
      const oldEmail = textOf(params, "oldEmail");
      const newEmail = textOf(params, "newEmail");
      return oldEmail === null || newEmail === null
        ? null
        : { kind: row.kind, to: row.to, params: { oldEmail, newEmail } };
    }
    default:
      return null;
  }
}

/** How one account email went. */
export type AccountEmailOutcome =
  | "sent"
  /** A reset asked for an address no account has: nothing is sent. */
  | "no_account"
  /** Failed; tried again later. */
  | "retrying"
  /** Failed for good (the last attempt, or a row that is not an email or cannot be opened). */
  | "given_up";

export interface AccountEmailSenderOptions {
  db: Kysely<Database>;
  /**
   * The SMTP server's mailer; null when SMTP_URL is unset on the worker:
   * nothing is taken, and rows wait (a day at most) for a worker with it.
   */
  mailer: Mailer | null;
  /** Opens the sealed links, and seals the one a reset request's first attempt makes. */
  sealer: LinkSealer;
  /** The instance's address (PUBLIC_URL): the links' base, as copied links use. */
  publicUrl: string;
  maxSending?: number;
  /** The moment rows are taken at and links made at (tests); now when left out. */
  now?: () => Date;
  /** Never given an address or a link. */
  log?: (level: "info" | "error", msg: string, fields?: Record<string, unknown>) => void;
}

/**
 * Sends due account emails: each tick takes as many as there is room for
 * and sends them without waiting, as DeliverySender does. A row is
 * deleted when its email is sent, when no account has a reset's address,
 * and when it is given up; otherwise it waits for its next attempt.
 */
export class AccountEmailSender {
  readonly #options: AccountEmailSenderOptions;
  readonly #sending = new Set<Promise<void>>();

  constructor(options: AccountEmailSenderOptions) {
    this.#options = options;
  }

  get sending(): number {
    return this.#sending.size;
  }

  /** How many account emails wait: the worker logs it at start when it has no mailer. */
  async waiting(): Promise<number> {
    const row = await this.#options.db
      .selectFrom("account_emails")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  /**
   * Deletes rows a day old, then takes the emails due now and starts
   * them; returns how many it started. Without a mailer it takes none:
   * giving them up would lose them, and a worker with SMTP sends them.
   */
  async tick(): Promise<number> {
    const { db, mailer, maxSending = MAX_ACCOUNT_SENDING, now } = this.#options;
    await pruneAccountEmails(db, now?.());
    if (mailer === null) return 0;
    const due = await takeDueAccountEmails(db, {
      limit: maxSending - this.#sending.size,
      now: now?.(),
    });
    for (const row of due) {
      const run: Promise<void> = this.deliver(row).then(
        () => undefined,
        () => undefined,
      );
      void run.finally(() => this.#sending.delete(run));
      this.#sending.add(run);
    }
    return due.length;
  }

  /** Waits for every email in flight, as on shutdown. */
  async drain(): Promise<void> {
    while (this.#sending.size > 0) await Promise.allSettled(this.#sending);
  }

  /** Sends one and deletes its row, or leaves it for the next attempt; never throws. */
  async deliver(row: DueAccountEmail): Promise<AccountEmailOutcome> {
    const { db, log } = this.#options;
    let outcome: AccountEmailOutcome;
    try {
      outcome = await this.#send(row);
    } catch (error) {
      // Not the error itself: it may hold the address.
      log?.("error", "sending an account email failed unexpectedly", {
        kind: row.kind,
        err: error instanceof Error ? error.name : "unknown",
      });
      outcome = row.attempt >= MAX_ATTEMPTS ? "given_up" : "retrying";
    }
    if (outcome !== "retrying") {
      try {
        await db.deleteFrom("account_emails").where("id", "=", row.id).execute();
      } catch (error) {
        log?.("error", "deleting a sent account email failed", {
          kind: row.kind,
          err: String(error),
        });
      }
    }
    if (outcome === "given_up") {
      log?.("info", "an account email could not be sent", {
        kind: row.kind,
        attempts: row.attempt,
      });
    }
    return outcome;
  }

  async #send(row: DueAccountEmail): Promise<AccountEmailOutcome> {
    const { db, mailer, sealer, publicUrl, now = () => new Date(), log } = this.#options;
    // Taken by a worker with a mailer only; left for one if not.
    if (mailer === null) return "retrying";
    const email = emailOf(row, sealer);
    if (email === null) return "given_up";
    const { name } = await readInstanceSettings(db);
    let message: Omit<MailMessage, "to">;
    if (email.kind === "password_reset") {
      const user = await db
        .selectFrom("dashboard_users")
        .select("id")
        .where("email", "=", email.to)
        .executeTakeFirst();
      if (user === undefined) return "no_account";
      const bound = sealBinding(row.kind, row.to);
      const params = isRecord(row.params) ? row.params : {};
      const sealed = textOf(params, "sealedLink");
      // A retry sends the link the first attempt made, so an email that
      // arrives after a timeout still works.
      let link = sealed === null ? null : sealer.open(sealed, bound);
      if (link === null) {
        // Made now: it replaces the user's earlier emailed link.
        const { token } = await createPasswordReset(db, user.id, {
          madeBy: "email",
          ttlMs: EMAILED_RESET_TTL_MS,
          now: now(),
        });
        link = resetLink(publicUrl, token);
        await db
          .updateTable("account_emails")
          .set({ params: JSON.stringify({ sealedLink: sealer.seal(link, bound) }) })
          .where("id", "=", row.id)
          .execute();
      }
      message = accountEmailMessage(
        { kind: "password_reset", to: email.to, params: { link } },
        name,
      );
    } else {
      message = accountEmailMessage(email, name);
    }
    const signal = AbortSignal.timeout(EMAIL_TIMEOUT_MS);
    try {
      const { accepted } = await mailer.send({ to: [email.to], ...message }, signal);
      if (accepted > 0) return "sent";
    } catch (error) {
      // mailError never holds SMTP_URL, but a server's answer may name the address: not logged.
      log?.("info", "an account email attempt failed", {
        kind: row.kind,
        attempt: row.attempt,
        failure: mailError(error, signal).split(":")[0],
      });
    }
    return row.attempt >= MAX_ATTEMPTS ? "given_up" : "retrying";
  }
}

/** Where a reset link points: the instance's own address, never a request's Host. */
export const resetLink = (publicUrl: string, token: string) =>
  `${publicUrl}/reset-password#token=${token}`;

/** Where an invitation link points. */
export const inviteLink = (publicUrl: string, token: string) =>
  `${publicUrl}/invite#token=${token}`;
