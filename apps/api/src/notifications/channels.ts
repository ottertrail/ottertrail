import { randomBytes } from "node:crypto";

import type { Kysely, Selectable } from "kysely";

import { forgetChannel } from "../alerts/rules.ts";
import { canSignInWith } from "../auth/auth.ts";
import type { Database, NotificationChannelsTable } from "../db/schema.ts";
import { outboundUrlOf, type Problem } from "../outbound/url.ts";

/**
 * Notification channels (docs/uptime-alerts.md, "Where alerts go"). Apply outbound address
 * rules when saving webhooks and on each delivery. Generate secrets here and rotate on demand.
 */

export const MAX_CHANNELS = 20;
export const MAX_CHANNEL_NAME = 100;
export const MAX_ADDRESSES = 20;
export const MAX_ADDRESS = 320;

export type ChannelKind = "email" | "webhook";

/** Expose only whether a secret exists; serve its value through secretOf. */
export interface Channel {
  id: string;
  name: string;
  kind: ChannelKind;
  /** An email channel's addresses; null for a webhook. */
  addresses: string[] | null;
  /** A webhook's URL and signing secret; null for an email channel. */
  url: string | null;
  hasSecret: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type ChannelRow = Selectable<NotificationChannelsTable>;

export function channelOf(row: ChannelRow): Channel {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    addresses: row.email_addresses,
    url: row.webhook_url,
    hasSecret: row.webhook_secret !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ChannelInput {
  name?: string | undefined;
  kind?: ChannelKind | undefined;
  addresses?: string[] | undefined;
  url?: string | undefined;
}

export type ChannelValues =
  | { kind: "email"; name: string; addresses: string[] }
  | { kind: "webhook"; name: string; url: string };

// eslint-disable-next-line no-control-regex -- control characters are what it refuses
const CONTROL = /[\u0000-\u001F\u007F]/u;

/** A new signing secret: 32 random bytes, as base64url (43 characters). */
export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** The URL a webhook may request, or why not: the uptime checks' rules (outbound/url.ts). */
export function webhookUrlOf(text: string): URL | Problem {
  return outboundUrlOf(text, {
    label: "A webhook's URL",
    example: "https://example.com/hooks/ottertrail",
  });
}

/** The addresses, trimmed, each once (whatever its case), or why they cannot be used. */
export function addressesOf(list: readonly string[]): string[] | Problem {
  const addresses: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const address = raw.trim();
    if (address === "") continue;
    if (address.length > MAX_ADDRESS || !canSignInWith(address)) {
      return {
        error: "invalid_address",
        message: `"${address.slice(0, 100)}" is not a supported email address. Use letters, digits, and . _ ' + - before the @. Use a domain such as example.com.`,
      };
    }
    if (seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    addresses.push(address);
  }
  if (addresses.length === 0 || addresses.length > MAX_ADDRESSES) {
    return {
      error: "invalid_address",
      message: `An email channel has 1 to ${MAX_ADDRESSES} addresses.`,
    };
  }
  return addresses;
}

/**
 * Fastify checks basic types and bounds first. Validate merged values here and reject kind
 * changes.
 */
export function channelValuesOf(
  input: ChannelInput,
  base?: ChannelValues,
): ChannelValues | Problem {
  const kind = base?.kind ?? input.kind;
  if (kind === undefined) {
    return { error: "invalid_kind", message: "A channel is email or a webhook." };
  }
  if (base !== undefined && input.kind !== undefined && input.kind !== base.kind) {
    return {
      error: "invalid_kind",
      message: "A channel's kind cannot change. Add a new channel instead.",
    };
  }
  if (kind === "email" && input.url !== undefined) {
    return { error: "invalid_url", message: "An email channel has no URL." };
  }
  if (kind === "webhook" && input.addresses !== undefined) {
    return { error: "invalid_address", message: "A webhook has no email addresses." };
  }
  let values: ChannelValues;
  let fallbackName: string;
  if (kind === "email") {
    const list = input.addresses ?? (base?.kind === "email" ? base.addresses : undefined);
    if (list === undefined) {
      return { error: "invalid_address", message: "Enter the addresses to send to." };
    }
    const addresses = addressesOf(list);
    if (!Array.isArray(addresses)) return addresses;
    fallbackName = addresses[0] ?? "Email";
    values = { kind, name: "", addresses };
  } else {
    const text = input.url ?? (base?.kind === "webhook" ? base.url : undefined);
    if (text === undefined) {
      return { error: "invalid_url", message: "Enter the URL to send to." };
    }
    const url = webhookUrlOf(text);
    if (!(url instanceof URL)) return url;
    fallbackName = url.hostname;
    values = { kind, name: "", url: url.href };
  }
  const name = (input.name ?? base?.name ?? "").trim() || fallbackName.slice(0, MAX_CHANNEL_NAME);
  if (name.length > MAX_CHANNEL_NAME || CONTROL.test(name)) {
    return {
      error: "invalid_name",
      message: `A channel's name has at most ${MAX_CHANNEL_NAME} characters, and no control characters.`,
    };
  }
  return { ...values, name };
}

export function valuesOfChannel(channel: Channel): ChannelValues {
  return channel.kind === "email"
    ? { kind: "email", name: channel.name, addresses: channel.addresses ?? [] }
    : { kind: "webhook", name: channel.name, url: channel.url ?? "" };
}

export async function listChannels(db: Kysely<Database>): Promise<Channel[]> {
  const rows = await db
    .selectFrom("notification_channels")
    .selectAll()
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  return rows.map(channelOf);
}

export async function findChannel(db: Kysely<Database>, id: string): Promise<Channel | null> {
  const row = await db
    .selectFrom("notification_channels")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  return row === undefined ? null : channelOf(row);
}

export async function createChannel(
  db: Kysely<Database>,
  values: ChannelValues,
  now: Date,
): Promise<{ channel: Channel } | { refused: "too_many" }> {
  return db.transaction().execute(async (trx) => {
    // Serialize channel saves on the settings row to enforce the cap.
    await trx.selectFrom("instance_settings").select("id").forUpdate().executeTakeFirst();
    const { count } = await trx
      .selectFrom("notification_channels")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    if (Number(count) >= MAX_CHANNELS) return { refused: "too_many" as const };
    const row = await trx
      .insertInto("notification_channels")
      .values({
        name: values.name,
        kind: values.kind,
        email_addresses: values.kind === "email" ? values.addresses : null,
        webhook_url: values.kind === "webhook" ? values.url : null,
        webhook_secret: values.kind === "webhook" ? newSecret() : null,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { channel: channelOf(row) };
  });
}

export async function updateChannel(
  db: Kysely<Database>,
  id: string,
  values: ChannelValues,
  now: Date,
): Promise<Channel | null> {
  const row = await db
    .updateTable("notification_channels")
    .set({
      name: values.name,
      ...(values.kind === "email"
        ? { email_addresses: values.addresses }
        : { webhook_url: values.url }),
      updated_at: now,
    })
    .where("id", "=", id)
    .where("kind", "=", values.kind)
    .returningAll()
    .executeTakeFirst();
  return row === undefined ? null : channelOf(row);
}

/** Return null for email channels and undefined for missing channels. */
export async function secretOf(
  db: Kysely<Database>,
  id: string,
): Promise<string | null | undefined> {
  const row = await db
    .selectFrom("notification_channels")
    .select("webhook_secret")
    .where("id", "=", id)
    .executeTakeFirst();
  return row?.webhook_secret;
}

export async function rotateSecret(
  db: Kysely<Database>,
  id: string,
  now: Date,
): Promise<{ channel: Channel; secret: string } | null> {
  const secret = newSecret();
  const row = await db
    .updateTable("notification_channels")
    .set({ webhook_secret: secret, updated_at: now })
    .where("id", "=", id)
    .where("kind", "=", "webhook")
    .returningAll()
    .executeTakeFirst();
  return row === undefined ? null : { channel: channelOf(row), secret };
}

export async function deleteChannel(
  db: Kysely<Database>,
  id: string,
  now: Date = new Date(),
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    // Update rules in the same transaction; disable any left without channels
    // (alerts/rules.ts).
    await forgetChannel(trx, id, now);
    const result = await trx
      .deleteFrom("notification_channels")
      .where("id", "=", id)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  });
}
