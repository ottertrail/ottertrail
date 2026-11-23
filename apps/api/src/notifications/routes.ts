import type { FastifyPluginCallback } from "fastify";
import type { Kysely } from "kysely";

import { requirePermission } from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireTrustedOrigin } from "../auth/origin.ts";
import { requireSession, signedInUser } from "../auth/routes.ts";
import { type RateLimit, TokenBucketLimiter } from "../collection/rate-limiter.ts";
import type { Database } from "../db/schema.ts";
import {
  type AddressPolicy,
  AddressNotAllowedError,
  type Lookup,
  resolveTarget,
  systemLookup,
} from "../outbound/addresses.ts";
import { MAX_URL, type Problem } from "../outbound/url.ts";
import { readInstanceSettings } from "../settings/settings.ts";
import { testEmailMessage } from "./account-emails.ts";
import {
  type Channel,
  type ChannelInput,
  channelValuesOf,
  createChannel,
  deleteChannel,
  findChannel,
  listChannels,
  MAX_ADDRESS,
  MAX_ADDRESSES,
  MAX_CHANNEL_NAME,
  MAX_CHANNELS,
  rotateSecret,
  secretOf,
  updateChannel,
  valuesOfChannel,
} from "./channels.ts";
import {
  DELIVERY_RETENTION_DAYS,
  listDeliveries,
  MAX_DELIVERY_PAGE,
  sendTest,
  TEST_SENDS_PER_MINUTE,
} from "./deliveries.ts";
import { EMAIL_TIMEOUT_MS, type Mailer, mailError } from "./email.ts";

export const DEFAULT_TEST_EMAIL_LIMIT: RateLimit = { capacity: 5, refillPerSecond: 5 / 600 };

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const PARAMS = {
  type: "object",
  required: ["channelId"],
  properties: { channelId: { type: "string", pattern: UUID_PATTERN } },
};

/** Leave room for channelValuesOf to return specific validation errors. */
const CHANNEL_FIELDS = {
  name: { type: "string", maxLength: MAX_CHANNEL_NAME * 2 },
  addresses: {
    type: "array",
    maxItems: MAX_ADDRESSES * 2,
    items: { type: "string", maxLength: MAX_ADDRESS },
  },
  url: { type: "string", maxLength: MAX_URL * 2 },
};

const BODY_LIMIT = 32 * 1024;

const DEFAULT_DELIVERY_PAGE = 20;

const SAVE_LOOKUP_MS = 5000;

const view = (channel: Channel) => ({ channel });

const NOT_A_WEBHOOK: Problem = { error: "not_a_webhook", message: "Only a webhook has a secret." };

const NO_CHANNEL: Problem = {
  error: "channel_not_found",
  message: "This instance has no notification channel with this ID.",
};

/**
 * Channel routes (channels.ts; docs/uptime-alerts.md). Require channel management access
 * (docs/access.md) and the dashboard's origin for changes. Serve secrets only on their own
 * route to keep them out of dashboard caches. Check webhook addresses on save and again on each
 * delivery.
 */
export const channelRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  auth: Auth;
  trustedOrigins: readonly string[];
  /** The instance's address: a test notification links to its settings. */
  publicUrl: string;
  /** Whether SMTP_URL is set: the dashboard says so beside email channels. */
  emailConfigured: boolean;
  /** The SMTP server's mailer, for the test email; null when SMTP_URL is unset. */
  mailer?: Mailer | null;
  /** Test emails per user (DEFAULT_TEST_EMAIL_LIMIT). */
  testEmailLimit?: RateLimit;
  /** The uptime checks' address rules (UPTIME_ALLOW_PRIVATE_ADDRESSES, UPTIME_DENY_ADDRESSES). */
  policy: AddressPolicy;
  /** Resolves a webhook's host when it is saved; tests pass a fake. */
  lookup?: Lookup;
  now?: () => Date;
}> = (
  app,
  {
    db,
    auth,
    trustedOrigins,
    publicUrl,
    emailConfigured,
    mailer = null,
    testEmailLimit = DEFAULT_TEST_EMAIL_LIMIT,
    policy,
    lookup = systemLookup,
    now = () => new Date(),
  },
  done,
) => {
  const signedIn = requireSession(auth);
  const fromDashboard = requireTrustedOrigin(trustedOrigins);
  // The owner and admins (docs/access.md); members see channels by name on the Alerts page.
  const manageChannels = requirePermission(db, "channels");
  const testEmails = new TokenBucketLimiter(testEmailLimit);

  /**
   * Send test email during the request so the page can show the outcome. mailError hides
   * SMTP_URL. Keep it outside queued channel deliveries.
   */
  app.post(
    "/channels/email-test",
    { preHandler: [fromDashboard, signedIn, manageChannels] },
    async (request, reply) => {
      const user = signedInUser(request);
      if (mailer === null || !emailConfigured) {
        return reply.code(409).send({
          error: "email_not_set_up",
          message:
            "Email isn't set up on this instance, so there's nothing to test. Whoever runs the server sets SMTP_URL and EMAIL_FROM, then restarts it.",
        });
      }
      const tried = testEmails.take(user.id);
      if (!tried.allowed) {
        return reply
          .code(429)
          .header("retry-after", String(tried.retryAfterSeconds))
          .send({
            error: "rate_limited",
            message: `You can send ${testEmailLimit.capacity} test emails in 10 minutes. Try again in ${tried.retryAfterSeconds} seconds.`,
          });
      }
      const { name } = await readInstanceSettings(db);
      const signal = AbortSignal.timeout(EMAIL_TIMEOUT_MS);
      let error: string | null = null;
      try {
        const { accepted } = await mailer.send(
          { to: [user.email], ...testEmailMessage(name) },
          signal,
        );
        if (accepted === 0) error = "The SMTP server accepted none of the addresses.";
      } catch (failure) {
        error = mailError(failure, signal);
      }
      if (error !== null) {
        return reply.code(502).send({
          error: "email_failed",
          message: `The test email could not be sent. Check the server's email settings, then try again. Error: ${error}`,
        });
      }
      return {
        email: user.email,
        message: `The mail server accepted a test email for ${user.email}. Check your inbox.`,
      };
    },
  );

  /**
   * Refuse prohibited webhook addresses. Save unresolved hosts; deliveries fail until DNS
   * works.
   */
  async function addressProblem(
    url: string,
    log: { info: (fields: object, message: string) => void },
  ): Promise<Problem | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SAVE_LOOKUP_MS);
    try {
      await resolveTarget(new URL(url), {
        lookup,
        policy,
        signal: controller.signal,
        who: "webhooks",
      });
      return null;
    } catch (error) {
      if (error instanceof AddressNotAllowedError) {
        // Show addresses only when the user supplied a literal IP; keep resolved addresses in
        // logs.
        log.info(
          { host: error.host, address: error.address, kind: error.kind },
          "a webhook's address was refused",
        );
        return { error: "address_not_allowed", message: error.message };
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  app.get("/channels", { preHandler: [signedIn, manageChannels] }, async () => ({
    maxChannels: MAX_CHANNELS,
    email: { configured: emailConfigured },
    channels: await listChannels(db),
  }));

  app.post<{ Body: ChannelInput }>(
    "/channels",
    {
      preHandler: [fromDashboard, signedIn, manageChannels],
      bodyLimit: BODY_LIMIT,
      schema: {
        body: {
          type: "object",
          required: ["kind"],
          additionalProperties: false,
          properties: { kind: { type: "string", enum: ["email", "webhook"] }, ...CHANNEL_FIELDS },
        },
      },
    },
    async (request, reply) => {
      const values = channelValuesOf(request.body);
      if ("error" in values) return reply.code(400).send(values);
      if (values.kind === "webhook") {
        const refused = await addressProblem(values.url, request.log);
        if (refused !== null) return reply.code(400).send(refused);
      }
      const created = await createChannel(db, values, now());
      if ("refused" in created) {
        return reply.code(409).send({
          error: "too_many_channels",
          message: `An instance has at most ${MAX_CHANNELS} notification channels.`,
        });
      }
      return reply.code(201).send(view(created.channel));
    },
  );

  app.get<{ Params: { channelId: string } }>(
    "/channels/:channelId",
    { preHandler: [signedIn, manageChannels], schema: { params: PARAMS } },
    async (request, reply) => {
      const channel = await findChannel(db, request.params.channelId);
      return channel === null ? reply.code(404).send(NO_CHANNEL) : view(channel);
    },
  );

  app.patch<{ Params: { channelId: string }; Body: ChannelInput }>(
    "/channels/:channelId",
    {
      preHandler: [fromDashboard, signedIn, manageChannels],
      bodyLimit: BODY_LIMIT,
      schema: {
        params: PARAMS,
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          // Accept kind here so channelValuesOf can explain why changing it is refused.
          properties: { kind: { type: "string", enum: ["email", "webhook"] }, ...CHANNEL_FIELDS },
        },
      },
    },
    async (request, reply) => {
      const current = await findChannel(db, request.params.channelId);
      if (current === null) return reply.code(404).send(NO_CHANNEL);
      const values = channelValuesOf(request.body, valuesOfChannel(current));
      if ("error" in values) return reply.code(400).send(values);
      if (values.kind === "webhook" && values.url !== current.url) {
        const refused = await addressProblem(values.url, request.log);
        if (refused !== null) return reply.code(400).send(refused);
      }
      const updated = await updateChannel(db, current.id, values, now());
      return updated === null ? reply.code(404).send(NO_CHANNEL) : view(updated);
    },
  );

  app.delete<{ Params: { channelId: string } }>(
    "/channels/:channelId",
    { preHandler: [fromDashboard, signedIn, manageChannels], schema: { params: PARAMS } },
    async (request, reply) => {
      const deleted = await deleteChannel(db, request.params.channelId, now());
      return deleted ? reply.code(204).send() : reply.code(404).send(NO_CHANNEL);
    },
  );

  app.post<{ Params: { channelId: string } }>(
    "/channels/:channelId/secret",
    { preHandler: [fromDashboard, signedIn, manageChannels], schema: { params: PARAMS } },
    async (request, reply) => {
      const current = await findChannel(db, request.params.channelId);
      if (current === null) return reply.code(404).send(NO_CHANNEL);
      if (current.kind !== "webhook") {
        return reply.code(400).send(NOT_A_WEBHOOK);
      }
      const rotated = await rotateSecret(db, current.id, now());
      if (rotated === null) return reply.code(404).send(NO_CHANNEL);
      return reply.header("cache-control", "no-store").send(rotated);
    },
  );

  app.get<{ Params: { channelId: string } }>(
    "/channels/:channelId/secret",
    { preHandler: [signedIn, manageChannels], schema: { params: PARAMS } },
    async (request, reply) => {
      const secret = await secretOf(db, request.params.channelId);
      if (secret === undefined) return reply.code(404).send(NO_CHANNEL);
      if (secret === null) return reply.code(400).send(NOT_A_WEBHOOK);
      return reply.header("cache-control", "no-store").send({ secret });
    },
  );

  app.post<{ Params: { channelId: string } }>(
    "/channels/:channelId/test",
    { preHandler: [fromDashboard, signedIn, manageChannels], schema: { params: PARAMS } },
    async (request, reply) => {
      const channel = await findChannel(db, request.params.channelId);
      if (channel === null) return reply.code(404).send(NO_CHANNEL);
      const user = signedInUser(request);
      const recorded = await sendTest(db, channel.id, {
        project: null,
        subject: { type: "channel", id: channel.id, name: channel.name },
        message: `A test notification for the channel "${channel.name}", sent by ${user.name} from the dashboard.`,
        url: new URL("/settings", publicUrl).href,
        time: now(),
      });
      if (recorded === null) return reply.code(404).send(NO_CHANNEL);
      if ("limited" in recorded) {
        return reply.code(429).send({
          error: "too_many_tests",
          message: `A channel takes at most ${TEST_SENDS_PER_MINUTE} test sends a minute. Wait a moment. Then try again.`,
        });
      }
      const [delivery] = recorded.deliveries;
      return reply.code(202).send({ notificationId: recorded.notificationId, delivery });
    },
  );

  app.get<{ Params: { channelId: string }; Querystring: { before?: string; limit?: number } }>(
    "/channels/:channelId/deliveries",
    {
      preHandler: [signedIn, manageChannels],
      schema: {
        params: PARAMS,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            before: { type: "string", pattern: UUID_PATTERN },
            limit: { type: "integer", minimum: 1, maximum: MAX_DELIVERY_PAGE },
          },
        },
      },
    },
    async (request, reply) => {
      const channel = await findChannel(db, request.params.channelId);
      if (channel === null) return reply.code(404).send(NO_CHANNEL);
      const page = await listDeliveries(db, channel.id, {
        before: request.query.before,
        limit: request.query.limit ?? DEFAULT_DELIVERY_PAGE,
      });
      return { retentionDays: DELIVERY_RETENTION_DAYS, ...page };
    },
  );

  done();
};
