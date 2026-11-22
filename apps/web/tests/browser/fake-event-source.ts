/**
 * A stand-in for the browser's EventSource, which setup.ts installs for
 * every test: nothing connects, and a test plays the server's side of the
 * Server log's stream (apps/api/src/server-log/routes.ts) with its methods.
 */
export class FakeEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  /** Every source opened since the test started, oldest first. */
  static opened: FakeEventSource[] = [];

  readonly url: string;
  readonly withCredentials = false;
  readyState = FakeEventSource.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  #seq = 0;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    FakeEventSource.opened.push(this);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }

  get closed(): boolean {
    return this.readyState === FakeEventSource.CLOSED;
  }

  /** An event as the server sends it; nothing once closed, as a real source hears nothing. */
  emit(type: string, data: unknown, lastEventId = ""): void {
    if (this.closed) return;
    this.readyState = FakeEventSource.OPEN;
    this.dispatchEvent(
      new MessageEvent(type, {
        data: typeof data === "string" ? data : JSON.stringify(data),
        lastEventId,
      }),
    );
  }

  hello(apiLevel = "info", maxLines = 2000): void {
    this.emit("hello", { apiLevel, maxLines, run: "abc123" });
  }

  /** One line, with the next ID of run "abc123". */
  line(process: "api" | "worker", line: Record<string, unknown>): void {
    this.#seq += 1;
    this.emit("message", { process, line }, `abc123:${this.#seq}`);
  }

  ready(): void {
    this.emit("ready", {});
  }

  end(reason: string, extra: Record<string, unknown> = {}): void {
    this.emit("end", { reason, ...extra });
  }

  /** The connection dropped: what a real source does on a network error. */
  fail(): void {
    if (this.closed) return;
    this.readyState = FakeEventSource.CONNECTING;
    this.dispatchEvent(new Event("error"));
  }
}

export function installFakeEventSource(): void {
  FakeEventSource.opened = [];
  Object.defineProperty(globalThis, "EventSource", {
    value: FakeEventSource,
    configurable: true,
    writable: true,
  });
}

/** The source the page opened last; throws when it opened none. */
export function latestSource(): FakeEventSource {
  const source = FakeEventSource.opened.at(-1);
  if (source === undefined) throw new Error("The page opened no EventSource");
  return source;
}
