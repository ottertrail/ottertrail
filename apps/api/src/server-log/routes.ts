import type { ServerResponse } from "node:http";

import type { FastifyPluginCallback } from "fastify";
import type { Kysely } from "kysely";

import { can, readUserAccess, requirePermission } from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireSameOriginRead } from "../auth/origin.ts";
import { requireSession, toHeaders } from "../auth/routes.ts";
import type { Database } from "../db/schema.ts";
import type { ServerLogBuffer, ServerLogEntry } from "./buffer.ts";

/** Streams open at once, every viewer together; past it a new one is told and closed. */
export const SERVER_LOG_MAX_STREAMS = 5;
/** A comment line this often keeps proxies and the browser from taking a quiet stream for a dead one. */
export const SERVER_LOG_HEARTBEAT_MS = 15_000;
/** How often an open stream checks its session and the owner's permission again. */
export const SERVER_LOG_RECHECK_MS = 30_000;
/**
 * What may wait for a client at two heartbeats in a row, when the lines
 * kept have had that long to go out; and, past the lines kept, at any moment.
 * A client over either is let go, so a stalled reader holds little.
 */
const MAX_PENDING_BYTES = 1024 * 1024;

/** Why the API closed a stream, in its last event: the dashboard says what to do. */
export type StreamEnd = "busy" | "access" | "slow";

export interface ServerLogRouteOptions {
  db: Kysely<Database>;
  auth: Auth;
  /** Origins dashboard requests may come from (Config.trustedOrigins). */
  trustedOrigins: readonly string[];
  buffer: ServerLogBuffer;
  /** LOG_LEVEL: what the API writes at all. Below it, no line exists to show. */
  level: string;
  maxStreams?: number;
  heartbeatMs?: number;
  recheckMs?: number;
}

/** What a stream that never subscribed stops. */
const nothing = () => undefined;

/** One event of the stream, as the EventSource format writes it. */
function event(name: string | null, data: string, id?: string): string {
  return `${id === undefined ? "" : `id: ${id}\n`}${name === null ? "" : `event: ${name}\n`}data: ${data}\n\n`;
}

function lineEvent(boot: string, entry: ServerLogEntry): string {
  return event(null, `{"process":"${entry.process}","line":${entry.text}}`, `${boot}:${entry.seq}`);
}

/** Where a reconnecting stream starts: after its last line, when it is of this run of the API. */
function afterSeq(boot: string, last: string | undefined): number {
  if (last === undefined) return 0;
  const [lastBoot, seq] = last.split(":");
  return lastBoot === boot ? Number(seq) : 0;
}

/**
 * GET /api/settings/server-log: the Server log as Server-Sent Events, for
 * the owner only (docs/access.md). It sends `hello` (the API's LOG_LEVEL
 * and the buffer's size), the lines kept (after `after`, or the
 * Last-Event-ID header, when they are of this run of the API), `ready`,
 * and then each new line as it is written, with a comment line every 15
 * seconds. Each line is `{ process, line }`, its ID `<run>:<seq>`.
 *
 * Closed by the API with an `end` event saying why: too many streams open
 * (`busy`), the session ended or the user is no longer the owner, checked
 * every 30 seconds (`access`), or a client too slow to read (`slow`). The
 * API's shutdown ends every stream without one, and the dashboard reconnects.
 * Nothing is stored: the lines are the buffer's, in memory.
 */
export const serverLogRoutes: FastifyPluginCallback<ServerLogRouteOptions> = (
  app,
  {
    db,
    auth,
    trustedOrigins,
    buffer,
    level,
    maxStreams = SERVER_LOG_MAX_STREAMS,
    heartbeatMs = SERVER_LOG_HEARTBEAT_MS,
    recheckMs = SERVER_LOG_RECHECK_MS,
  },
  done,
) => {
  const signedIn = requireSession(auth);
  const owner = requirePermission(db, "settings");
  const fromDashboard = requireSameOriginRead(trustedOrigins);
  /** Every open stream, and what cuts it off. */
  const streams = new Map<ServerResponse, () => void>();

  app.addHook("preClose", (finish) => {
    // Cut off, not ended: an end would wait for a stalled reader, and so
    // would the close. Each deletes its own entry, which a Map's iteration allows.
    for (const cut of streams.values()) cut();
    finish();
  });

  app.get<{ Querystring: { after?: string } }>(
    "/settings/server-log",
    {
      preHandler: [fromDashboard, signedIn, owner],
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { after: { type: "string", pattern: "^[0-9a-f]{1,32}:[0-9]{1,15}$" } },
        },
      },
    },
    (request, reply) => {
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        // no-transform: a proxy may not compress or hold it (Caddy's encode skips it too).
        "cache-control": "no-store, no-transform",
        // nginx and others buffer a proxied answer unless told not to.
        "x-accel-buffering": "no",
      });
      res.flushHeaders();

      if (streams.size >= maxStreams) {
        res.end(event("end", `{"reason":"busy","maxStreams":${maxStreams}}`));
        return;
      }

      let closed = false;
      let unsubscribe: () => void = nothing;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let recheck: ReturnType<typeof setInterval> | undefined;
      /** Ends the stream; `cut` drops what still waits for the client rather than wait for it. */
      const close = (cut = false) => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearInterval(heartbeat);
        clearInterval(recheck);
        streams.delete(res);
        if (cut) res.destroy();
        else res.end();
      };
      /** Says why, then ends; a client that doesn't read is cut off, as it would never read why. */
      const end = (reason: StreamEnd) => {
        if (closed) return;
        res.write(event("end", `{"reason":"${reason}"}`));
        close(reason === "slow");
      };
      const write = (chunk: string) => {
        if (!closed) res.write(chunk);
      };
      streams.set(res, () => close(true));
      res.on("close", () => close());
      res.on("error", () => close(true));

      write(
        event(
          "hello",
          JSON.stringify({ apiLevel: level, maxLines: buffer.maxLines, run: buffer.boot }),
        ),
      );
      const header = request.headers["last-event-id"];
      const last = request.query.after ?? (typeof header === "string" ? header : undefined);
      for (const entry of buffer.entries(afterSeq(buffer.boot, last))) {
        write(lineEvent(buffer.boot, entry));
      }
      write(event("ready", "{}"));

      unsubscribe = buffer.subscribe((entry) => {
        write(lineEvent(buffer.boot, entry));
        // The lines kept went out at once; past them, a client that doesn't read is let go.
        if (res.writableLength > buffer.maxBytes + MAX_PENDING_BYTES) end("slow");
      });
      /** Whether more than MAX_PENDING_BYTES waited at the last heartbeat too. */
      let behind = false;
      heartbeat = setInterval(() => {
        // Two heartbeats in a row over it: a slow line had time for the lines kept.
        const over = res.writableLength > MAX_PENDING_BYTES;
        if (over && behind) end("slow");
        else write(": heartbeat\n\n");
        behind = over;
      }, heartbeatMs);
      const user = request.dashboardUser;
      recheck = setInterval(() => {
        void (async () => {
          try {
            const session = await auth.api.getSession({ headers: toHeaders(request) });
            const access = user === null ? null : await readUserAccess(db, user.id);
            if (session?.user.id !== user?.id || access === null || !can(access, "settings")) {
              end("access");
            }
          } catch {
            // The database is down: the stream stays until a check can tell.
          }
        })();
      }, recheckMs);
    },
  );
  done();
};
