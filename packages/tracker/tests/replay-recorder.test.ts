import { gunzipSync } from "node:zlib";

import { describe, expect, test, vi } from "vite-plus/test";

import { createRecorder, type Emit, type RecorderOptions } from "../src/replay-recorder.ts";

interface Sent {
  params: Record<string, string>;
  bytes: Uint8Array;
  by: "fetch" | "beacon";
}

const meta = (href = "https://example.com/p?secret=1") => ({
  type: 4,
  data: { href, width: 800, height: 600 },
  timestamp: Date.now(),
});
/** A full snapshot whose one paragraph is named, to tell stretches apart. */
const snapshot = (name: string) => ({
  type: 2,
  data: {
    node: {
      type: 0,
      id: 1,
      childNodes: [{ type: 2, id: 2, tagName: "p", attributes: { id: name }, childNodes: [] }],
    },
    initialOffset: { top: 0, left: 0 },
  },
  timestamp: Date.now(),
});
const scroll = () => ({ type: 3, data: { source: 3, id: 1, x: 0, y: 10 }, timestamp: Date.now() });

/** A recorder with a stand-in for rrweb, and an API answering with `statuses` in turn. */
function setup(
  statuses: (number | [number, unknown] | Error)[] = [],
  overrides: Partial<RecorderOptions> = {},
) {
  let emit: Emit | undefined;
  const stopRecording = vi.fn<() => void>();
  const sent: Sent[] = [];
  const answers = [...statuses];
  const record = (url: string, bytes: Uint8Array, by: Sent["by"]) => {
    sent.push({ params: Object.fromEntries(new URL(url).searchParams), bytes, by });
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const body = init?.body instanceof Blob ? init.body : new Blob([]);
    record(
      input instanceof Request ? input.url : input.toString(),
      new Uint8Array(await body.arrayBuffer()),
      "fetch",
    );
    const answer = answers.shift() ?? 202;
    if (answer instanceof Error) throw answer;
    const [status, json] = Array.isArray(answer) ? answer : [answer, undefined];
    return new Response(json === undefined ? null : JSON.stringify(json), {
      status,
      headers: status === 503 ? { "retry-after": "0" } : {},
    });
  });
  const beacon = vi.fn<(url: string, body: Blob) => boolean>((url, body) => {
    void body.arrayBuffer().then((buffer) => record(url, new Uint8Array(buffer), "beacon"));
    return true;
  });
  const recorder = createRecorder({
    endpoint: "https://analytics.example.com/api/replays",
    key: "pk_test",
    showText: false,
    showMedia: false,
    base: "https://example.com/p",
    randomId: () => "8a1c4d2e-0f3b-4c5d-9e6f-7a8b9c0d1e2f",
    fetch,
    beacon,
    afterErrorMs: 20,
    record: (next) => {
      emit = next;
      return stopRecording;
    },
    ...overrides,
  });
  recorder.start();
  const recording = () => {
    // The API keeps each piece once, by its number.
    const bySeq = new Map(sent.map((item) => [Number(item.params.seq), item]));
    const ordered = Array.from(
      { length: bySeq.size },
      (_, seq) => bySeq.get(seq)?.bytes ?? new Uint8Array(),
    );
    const text = gunzipSync(Buffer.concat(ordered)).toString("utf8");
    return JSON.parse(text) as {
      v: number;
      events: { type: number; data: Record<string, unknown> }[];
    };
  };
  return {
    emit: (event: unknown, checkout?: boolean) => emit?.(event, checkout),
    recorder,
    sent,
    fetch,
    beacon,
    stopRecording,
    recording,
  };
}

const lastSent = (sent: Sent[]) => sent.some((item) => item.params.last === "1");

describe("the replay recorder", () => {
  test("sends nothing until an error, then the last two stretches and the 10 seconds after", async () => {
    const page = setup();
    page.emit(meta());
    page.emit(snapshot("first"));
    page.emit(scroll());
    page.emit(meta(), true); // A checkout: a new stretch begins.
    page.emit(snapshot("second"), true);
    page.emit(meta(), true);
    page.emit(snapshot("third"), true);
    page.emit(scroll());
    expect(page.sent).toEqual([]);

    const id = page.recorder.error();
    expect(id).toBe("8a1c4d2e-0f3b-4c5d-9e6f-7a8b9c0d1e2f");
    expect(page.recorder.error()).toBe(id); // Still recording: the same replay.
    page.emit(meta(), true); // After an error, a checkout drops nothing.
    page.emit(snapshot("fourth"), true);

    await vi.waitFor(() => expect(lastSent(page.sent)).toBe(true));
    expect(page.stopRecording).toHaveBeenCalled();
    expect(page.recorder.error()).toBeUndefined(); // One replay per page load.

    const { v, events } = page.recording();
    expect(v).toBe(1);
    const names = events.flatMap((event) =>
      event.type === 2 ? [JSON.stringify(event.data).match(/"id":"(\w+)"/)?.[1]] : [],
    );
    expect(names).toEqual(["second", "third", "fourth"]);
    expect(events.filter((event) => event.type === 5)).toHaveLength(2); // Each error marked.
    expect(events[0]).toMatchObject({ type: 4, data: { href: "https://example.com/p" } });
    for (const item of page.sent) {
      expect(item.params).toMatchObject({
        key: "pk_test",
        replay: id,
        cut: "0",
      });
    }
    expect(page.sent.map((item) => item.params.seq)).toEqual(page.sent.map((_, i) => String(i)));
  });

  test("no replay before rrweb has recorded anything", () => {
    const page = setup();
    expect(page.recorder.error()).toBeUndefined();
  });

  test("a failed piece is sent again with the same number", async () => {
    const page = setup([503, new Error("offline"), 202, 202]);
    page.emit(meta());
    page.emit(snapshot("only"));
    page.recorder.error();
    await vi.waitFor(() => expect(lastSent(page.sent)).toBe(true), { timeout: 10_000 });
    const seqs = page.sent.map((item) => item.params.seq);
    expect(seqs.slice(0, 3)).toEqual(["0", "0", "0"]);
    expect(page.recording().events[1]?.type).toBe(2);
  }, 15_000);

  test("a refused replay is dropped; replay_off stops for the page load", async () => {
    const page = setup([[403, { error: "replay_off" }]]);
    page.emit(meta());
    page.emit(snapshot("only"));
    page.recorder.error();
    await vi.waitFor(() => expect(page.fetch).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(page.fetch).toHaveBeenCalledTimes(1);
    expect(page.recorder.error()).toBeUndefined();

    const bad = setup([400]);
    bad.emit(meta());
    bad.emit(snapshot("only"));
    bad.emit(scroll());
    bad.recorder.error();
    await vi.waitFor(() => expect(bad.fetch).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bad.fetch).toHaveBeenCalledTimes(1);
  });

  test("leaving the page sends what is ready by beacon", async () => {
    const page = setup([], { afterErrorMs: 60_000 });
    page.emit(meta());
    page.emit(snapshot("only"));
    page.recorder.error();
    page.emit(scroll());
    page.recorder.exit(); // The recording ends here, not 60 seconds later.
    expect(page.stopRecording).toHaveBeenCalled();
    await vi.waitFor(() => expect(lastSent(page.sent)).toBe(true));
    expect(page.sent.every((item) => item.by === "beacon")).toBe(true);
    expect(page.fetch).not.toHaveBeenCalled();
    expect(page.recording().events.map((event) => event.type)).toEqual([4, 2, 5, 3]);
  });

  test("a refused beacon falls back to a keepalive fetch", async () => {
    const page = setup([], { afterErrorMs: 60_000, beacon: () => false });
    page.emit(meta());
    page.emit(snapshot("only"));
    page.recorder.error();
    page.recorder.exit();
    await vi.waitFor(() => expect(lastSent(page.sent)).toBe(true));
    expect(page.fetch.mock.calls.every(([, init]) => init?.keepalive === true)).toBe(true);
  });

  test("replay(false) stops recording and drops the buffer", async () => {
    const page = setup();
    page.emit(meta());
    page.emit(snapshot("only"));
    page.recorder.stop();
    expect(page.stopRecording).toHaveBeenCalled();
    expect(page.recorder.error()).toBeUndefined();
    page.recorder.exit();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(page.sent).toEqual([]);
  });

  test("if the filter fails, the recording stops and nothing is sent (fail closed)", async () => {
    const page = setup();
    page.emit(meta());
    page.emit(snapshot("only"));
    page.emit({
      get timestamp(): number {
        throw new Error("unreadable");
      },
    });
    expect(page.stopRecording).toHaveBeenCalled();
    expect(page.recorder.error()).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(page.sent).toEqual([]);
  });
});
