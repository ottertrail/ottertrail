import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { apiRequest, expectShape } from "./api";
import { isListOf, isNumber, isRecord, isText, isTextOrNull } from "./telemetry-shapes";

/**
 * The instance's notification channels (docs/uptime-alerts.md, "Where
 * alerts go"; apps/api/src/notifications): email lists and webhooks that
 * alert rules send to, with their deliveries of the last 30 days.
 */

export const MAX_CHANNEL_NAME = 100;
export const MAX_ADDRESSES = 20;

export type ChannelKind = "email" | "webhook";

export interface Channel {
  id: string;
  name: string;
  kind: ChannelKind;
  /** An email channel's addresses; null for a webhook. */
  addresses: string[] | null;
  /** A webhook's URL; null for an email channel. */
  url: string | null;
  /** Whether it has a signing secret (a webhook): fetchSecret reads it, on request only. */
  hasSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/channels */
export interface ChannelList {
  maxChannels: number;
  /** Whether the instance has an SMTP server (SMTP_URL). */
  email: { configured: boolean };
  channels: Channel[];
}

export type DeliveryStatus = "pending" | "sent" | "failed";

export interface Delivery {
  id: string;
  notificationId: string;
  type: string;
  message: string;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

/** One page of GET /api/channels/:id/deliveries: `next` asks for the following one. */
export interface DeliveryPage {
  retentionDays: number;
  deliveries: Delivery[];
  next: string | null;
}

/** What the form sends; a channel's kind is set once. */
export interface ChannelFields {
  kind?: ChannelKind;
  name: string;
  addresses?: string[];
  url?: string;
}

const isChannel = (value: unknown): value is Channel =>
  isRecord(value) &&
  isText(value.id) &&
  isText(value.name) &&
  (value.kind === "email" || value.kind === "webhook") &&
  (value.addresses === null || isListOf(value.addresses, isText)) &&
  isTextOrNull(value.url) &&
  typeof value.hasSecret === "boolean" &&
  isText(value.createdAt) &&
  isText(value.updatedAt);

const isChannelList = (value: unknown): value is ChannelList =>
  isRecord(value) &&
  isNumber(value.maxChannels) &&
  isRecord(value.email) &&
  typeof value.email.configured === "boolean" &&
  isListOf(value.channels, isChannel);

const isChannelBody = (value: unknown): value is { channel: Channel } =>
  isRecord(value) && isChannel(value.channel);

const isDelivery = (value: unknown): value is Delivery =>
  isRecord(value) &&
  isText(value.id) &&
  isText(value.notificationId) &&
  isText(value.type) &&
  isText(value.message) &&
  (value.status === "pending" || value.status === "sent" || value.status === "failed") &&
  isNumber(value.attempts) &&
  isTextOrNull(value.nextAttemptAt) &&
  isTextOrNull(value.lastError) &&
  isText(value.createdAt) &&
  isTextOrNull(value.sentAt);

const isDeliveryPage = (value: unknown): value is DeliveryPage =>
  isRecord(value) &&
  isNumber(value.retentionDays) &&
  isListOf(value.deliveries, isDelivery) &&
  isTextOrNull(value.next);

const channelPath = (id: string) => `/api/channels/${encodeURIComponent(id)}`;

export const channelsQuery = () =>
  queryOptions({
    queryKey: ["channels"],
    queryFn: async ({ signal }) =>
      expectShape(await apiRequest("/api/channels", { signal }), isChannelList),
  });

/**
 * A channel's deliveries, newest first, 20 at a time. While one is
 * waiting to be sent or retried, the list is read again every 5 seconds.
 */
export const deliveriesQuery = (channelId: string) =>
  infiniteQueryOptions({
    queryKey: ["channels", channelId, "deliveries"],
    initialPageParam: "",
    queryFn: async ({ pageParam, signal }) =>
      expectShape(
        await apiRequest(
          `${channelPath(channelId)}/deliveries${pageParam === "" ? "" : `?before=${encodeURIComponent(pageParam)}`}`,
          { signal },
        ),
        isDeliveryPage,
      ),
    getNextPageParam: (last) => last.next ?? undefined,
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) =>
        page.deliveries.some((delivery) => delivery.status === "pending"),
      ) === true
        ? 5000
        : false,
  });

export async function createChannel(fields: ChannelFields): Promise<Channel> {
  const body = await apiRequest("/api/channels", { method: "POST", body: fields });
  return expectShape(body, isChannelBody).channel;
}

export async function updateChannel(id: string, fields: ChannelFields): Promise<Channel> {
  const { kind: _kind, ...changes } = fields;
  const body = await apiRequest(channelPath(id), { method: "PATCH", body: changes });
  return expectShape(body, isChannelBody).channel;
}

export async function deleteChannel(id: string): Promise<void> {
  await apiRequest(channelPath(id), { method: "DELETE" });
}

const isSecretBody = (value: unknown): value is { secret: string } =>
  isRecord(value) && isText(value.secret);

/**
 * A webhook's signing secret. Not a query: the secret stays out of React
 * Query's cache, and the page keeps it only while it is shown.
 */
export async function fetchSecret(id: string): Promise<string> {
  const body = await apiRequest(`${channelPath(id)}/secret`);
  return expectShape(body, isSecretBody).secret;
}

/** Replaces a webhook's signing secret, answered once; the old one stops working at once. */
export async function rotateSecret(id: string): Promise<{ channel: Channel; secret: string }> {
  const body = await apiRequest(`${channelPath(id)}/secret`, { method: "POST" });
  return expectShape(
    body,
    (value): value is { channel: Channel; secret: string } =>
      isChannelBody(value) && isSecretBody(value),
  );
}

/** Queues a test notification to the channel; the worker sends it within seconds. */
export async function sendTest(id: string): Promise<void> {
  await apiRequest(`${channelPath(id)}/test`, { method: "POST" });
}

/** The addresses typed in a box, one per line or separated by commas, each once. */
export function addressesFromText(text: string): string[] {
  const seen = new Set<string>();
  const addresses: string[] = [];
  for (const part of text.split(/[\s,;]+/u)) {
    const address = part.trim();
    if (address === "" || seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    addresses.push(address);
  }
  return addresses;
}
