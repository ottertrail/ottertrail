import { Client } from "pg";

import { parseLogRecord, type ServerLogBuffer } from "./buffer.ts";
import { redactRecord } from "./redact.ts";
import { CONNECTION_LIMITS, SERVER_LOG_CHANNEL } from "./relay.ts";

const RETRY_MS = { first: 1000, max: 30_000 };

/** Ping to detect and replace dead connections. */
export const LISTENER_PING_MS = 30_000;

export interface ListenerOptions {
  connectionString: string;
  buffer: ServerLogBuffer;
  channel?: string;
  /** How the connection is named in pg_stat_activity. */
  applicationName?: string;
  /** How often it checks the connection; tests lower it. */
  pingMs?: number;
  /** The API's own log, for losing and getting back the connection. */
  log: { info(msg: string): void; warn(obj: object, msg: string): void };
}

/**
 * Use a separate PostgreSQL LISTEN connection for worker logs (relay.ts).
 * Reconnect after 1 second, backing off to 30 seconds. Lines sent while
 * disconnected are lost.
 */
export class WorkerLogListener {
  readonly #options: ListenerOptions;
  #client: Client | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #ping: ReturnType<typeof setInterval> | undefined;
  #retryMs = RETRY_MS.first;
  #failing = false;
  #stopped = false;

  constructor(options: ListenerOptions) {
    this.#options = options;
  }

  start(): void {
    this.#stopped = false;
    void this.#connect();
  }

  get listening(): boolean {
    return this.#client !== null;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    clearInterval(this.#ping);
    const client = this.#client;
    this.#client = null;
    await client?.end().catch(() => undefined);
  }

  #heard(payload: string | undefined): void {
    const record = parseLogRecord(payload ?? "") ?? {
      level: "warn",
      time: Date.now(),
      msg: "a worker log line could not be read",
    };
    // Redact again because other senders can publish to this channel.
    this.#options.buffer.add("worker", redactRecord(record).value);
  }

  #lost(client: Client, error: unknown): void {
    if (this.#client === client) {
      this.#client = null;
      clearInterval(this.#ping);
    }
    void client.end().catch(() => undefined);
    if (this.#stopped) return;
    if (!this.#failing) {
      this.#failing = true;
      this.#options.log.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "the Server log lost its PostgreSQL connection: the worker's lines don't arrive until it reconnects",
      );
    }
    this.#timer = setTimeout(() => void this.#connect(), this.#retryMs);
    this.#timer.unref();
    this.#retryMs = Math.min(this.#retryMs * 2, RETRY_MS.max);
  }

  async #connect(): Promise<void> {
    if (this.#stopped) return;
    const {
      connectionString,
      channel = SERVER_LOG_CHANNEL,
      applicationName = "ottertrail-server-log",
      pingMs = LISTENER_PING_MS,
    } = this.#options;
    const client = new Client({
      connectionString,
      application_name: applicationName,
      ...CONNECTION_LIMITS,
    });
    client.on("notification", (message) => {
      if (message.channel === channel) this.#heard(message.payload);
    });
    // Handle error and end as one disconnect.
    let lost = false;
    const onLost = (error: unknown) => {
      if (lost) return;
      lost = true;
      this.#lost(client, error);
    };
    client.on("error", onLost);
    client.on("end", () => onLost(new Error("the connection ended")));
    try {
      await client.connect();
      await client.query(`LISTEN ${client.escapeIdentifier(channel)}`);
    } catch (error) {
      onLost(error);
      return;
    }
    if (lost) return;
    if (this.#stopped) {
      await client.end().catch(() => undefined);
      return;
    }
    this.#client = client;
    this.#retryMs = RETRY_MS.first;
    // A timed query detects half-open connections sooner than TCP keepalive.
    clearInterval(this.#ping);
    this.#ping = setInterval(() => {
      client.query("select 1").catch((error: unknown) => onLost(error));
    }, pingMs);
    this.#ping.unref();
    if (this.#failing) {
      this.#failing = false;
      this.#options.log.info("the Server log hears the worker again");
    }
  }
}
