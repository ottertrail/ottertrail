import { Client } from "pg";

import { parseLogRecord, type ServerLogBuffer } from "./buffer.ts";
import { redactRecord } from "./redact.ts";
import { SERVER_LOG_CHANNEL } from "./relay.ts";

const RETRY_MS = { first: 1000, max: 30_000 };

export interface ListenerOptions {
  connectionString: string;
  buffer: ServerLogBuffer;
  channel?: string;
  /** How the connection is named in pg_stat_activity. */
  applicationName?: string;
  /** The API's own log, for losing and getting back the connection. */
  log: { info(msg: string): void; warn(obj: object, msg: string): void };
}

/**
 * The API's side of the Server log's worker lines (relay.ts): one
 * PostgreSQL connection of its own, apart from the pool, LISTENing on the
 * channel, adding each notification to the buffer as a worker line. A lost
 * connection is opened again, after 1 second and then up to 30; the
 * worker's lines sent meanwhile are lost, and the API's log says so.
 */
export class WorkerLogListener {
  readonly #options: ListenerOptions;
  #client: Client | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #retryMs = RETRY_MS.first;
  #failing = false;
  #stopped = false;

  constructor(options: ListenerOptions) {
    this.#options = options;
  }

  /** Connects and listens, now and after every loss, until stop(). */
  start(): void {
    this.#stopped = false;
    void this.#connect();
  }

  /** Whether a connection is listening now. */
  get listening(): boolean {
    return this.#client !== null;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
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
    // The worker masks its lines; masked again here, so another sender on the channel can't slip a secret in.
    this.#options.buffer.add("worker", redactRecord(record).value);
  }

  #lost(client: Client, error: unknown): void {
    if (this.#client === client) this.#client = null;
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
    } = this.#options;
    const client = new Client({ connectionString, application_name: applicationName });
    client.on("notification", (message) => {
      if (message.channel === channel) this.#heard(message.payload);
    });
    // Each connection is lost once, whether it errs, ends, or both.
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
      // A channel name is an identifier: quoted, as escapeIdentifier does.
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
    if (this.#failing) {
      this.#failing = false;
      this.#options.log.info("the Server log hears the worker again");
    }
  }
}
