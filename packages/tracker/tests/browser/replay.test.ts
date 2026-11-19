/**
 * The privacy test (docs/session-replay.md, "Proving it"): records a page
 * full of planted values with the recorder as r.js runs it, real rrweb
 * included, triggers an error, takes what the recorder uploads, joins and
 * decompresses it, and checks that no planted value is in it.
 */
import { record } from "@rrweb/record";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { commands } from "vite-plus/test/browser/context";

import { REPLAY_PROPERTY } from "../../src/replay-names.ts";
import { MAX_CHUNK_BYTES, MAX_REPLAY_BYTES } from "../../src/replay-pack.ts";
import type { RecorderOptions, ReplayRecorder } from "../../src/replay-recorder.ts";
import { startReplay } from "../../src/replay-start.ts";
import { STAND_IN } from "../stand-in.ts";

const PAGE = `
  <main>
    <h1>Account</h1>
    <p id="name">Wilhelmina Quarterfield</p>
    <p>Email: <a id="link" href="/account?token=TOKENLINK8842" title="TitleSecretOrchid">wilhelmina.q@example.org</a></p>
    <span id="card">4111 1111 1111 1111</span>
    <img id="photo" alt="AltSecretHeron" width="10" height="10"
      src="https://cdn.example.com/photo.png?token=TOKENIMG5521"
      srcset="https://cdn.example.com/photo-2x.png?token=TOKENSET7730 2x, /photo-3x.png?sig=SIGSET4410 3x">
    <button aria-label="AriaSecretMaple" data-user="DataAttrSecretYew">Go</button>
    <form>
      <input id="text" type="text" placeholder="PlaceholderSecretFern">
      <input id="password" type="password">
      <textarea id="textarea"></textarea>
      <select id="select">
        <option value="a">Option Alpha</option>
        <option value="SelectValueSecretAsh">SelectedSecretLarch</option>
      </select>
    </form>
    <div id="editable" contenteditable="true">Draft</div>
    <div id="mask" data-ottertrail-mask>MaskedSecretPoplar</div>
    <div id="block" data-ottertrail-block><p>BlockedSecretSpruce</p><input value="BlockedInputSecretFir"></div>
    <section id="unmask" data-ottertrail-unmask>
      <h2>UnmaskedVisibleHeading</h2>
      <input id="unmask-input" type="text">
    </section>
    <div id="later-block">LaterTarget</div>
    <div id="later-mask">LaterMaskTarget</div>
    <div style="background-image: url('https://cdn.example.com/bg.png?token=TOKENSTYLE3301')">Styled</div>
  </main>
`;

/** In the page or typed into it: none may be in a recording with the defaults. */
const PLANTED = [
  "Wilhelmina",
  "Quarterfield",
  "wilhelmina.q",
  "example.org",
  "4111",
  "1111 1111",
  "TOKENLINK8842",
  "token=",
  "TOKENIMG5521",
  "TOKENSET7730",
  "SIGSET4410",
  "sig=",
  "TOKENSTYLE3301",
  "TitleSecretOrchid",
  "PlaceholderSecretFern",
  "AltSecretHeron",
  "AriaSecretMaple",
  "DataAttrSecretYew",
  "MetaSecretAlder",
  "PassSecret",
  "9931",
  "TypedSecretQuince",
  "TextareaSecretBirch",
  "SelectedSecretLarch",
  "SelectValueSecretAsh",
  "EditableSecretCedar",
  "InsertedSecretWillow",
  "ChangedAttrSecretAspen",
  "CHANGEDTOKEN6612",
  "MaskedSecretPoplar",
  "BlockedSecretSpruce",
  "BlockedInputSecretFir",
  "UnmaskInputSecretElm",
  "AfterBlockSecretOak",
  "AfterMaskSecretPine",
];

/** Never in a recording, whatever the page shows: typed values, marked elements, tokens. */
const NEVER = [
  "PassSecret",
  "9931",
  "TypedSecretQuince",
  "TextareaSecretBirch",
  "SelectedSecretLarch",
  "SelectValueSecretAsh",
  "EditableSecretCedar",
  "UnmaskInputSecretElm",
  "MaskedSecretPoplar",
  "BlockedSecretSpruce",
  "BlockedInputSecretFir",
  "AfterBlockSecretOak",
  "AfterMaskSecretPine",
  "TOKENLINK8842",
  "TOKENIMG5521",
  "TOKENSET7730",
  "SIGSET4410",
  "TOKENSTYLE3301",
  "CHANGEDTOKEN6612",
  "token=",
  "sig=",
];

interface Chunk {
  params: Record<string, string>;
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string | null;
}

let running: ReplayRecorder | undefined;
const added: Element[] = [];

/** Undoes what a test changed in the page beyond its body. */
const cleanups: (() => void)[] = [];

afterEach(() => {
  running?.stop();
  running = undefined;
  // Last in, first out.
  for (let cleanup = cleanups.pop(); cleanup !== undefined; cleanup = cleanups.pop()) cleanup();
  document.body.innerHTML = "";
  for (const element of added.splice(0)) element.remove();
});

const byId = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`no #${id}`);
  return element;
};
/** A field of the form, by its ID. */
const formField = (id: string) => {
  const element = byId(id);
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    return element;
  }
  throw new Error(`#${id} is not a field`);
};
const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

/** Types into a field as a visitor would, as far as rrweb can tell. */
function type(field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  field.focus();
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
}

/** The uploaded pieces joined and decompressed, as the API reads them. */
async function gunzip(chunks: Chunk[]): Promise<string> {
  let binary = "";
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...chunk.bytes.subarray(i, i + 0x8000));
    }
  }
  // Defined in vite.config.ts: Node's zlib reads every gzip member.
  const command: unknown = Reflect.get(commands, "gunzip");
  if (typeof command !== "function") throw new Error("the gunzip command is missing");
  const text: unknown = await command(btoa(binary));
  if (typeof text !== "string") throw new Error("gunzip gave no text");
  return text;
}

interface Settings {
  text?: boolean;
  media?: boolean;
}

/** Starts a recording that uploads with `fetch`; error() reports an error to it. */
type Start = (
  settings: Settings,
  fetch: typeof globalThis.fetch,
  overrides: Partial<RecorderOptions>,
) => Promise<{ error: () => Promise<string | undefined> | string | undefined }>;

/** The recorder started directly, as r.js starts it, with its timings shortened. */
const startDirectly: Start = async (settings, fetch, overrides) => {
  let registered: unknown;
  const recorder = startReplay(
    {
      endpoint: "https://analytics.example.com/api/replays",
      key: "pk_test",
      text: settings.text ?? false,
      media: settings.media ?? false,
      register: (value) => {
        registered = value;
      },
    },
    { fetch, beacon: () => false, afterErrorMs: 300, ...overrides },
  );
  if (recorder === undefined) throw new Error("no CompressionStream");
  running = recorder;
  expect(registered).toBe(recorder);
  return recorder;
};

/**
 * Records PAGE with these settings, does what a visitor and the page's own
 * scripts would, reports an error, and returns what the recorder uploaded.
 */
async function recordPage(
  settings: Settings = {},
  overrides: Partial<RecorderOptions> = {},
  before: () => Promise<void> | void = () => {},
  start: Start = startDirectly,
) {
  document.body.innerHTML = PAGE;
  const meta = document.createElement("meta");
  meta.name = "app-user";
  meta.content = "MetaSecretAlder";
  document.head.append(meta);
  added.push(meta);

  const chunks: Chunk[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const body = init?.body instanceof Blob ? init.body : new Blob([]);
    chunks.push({
      params: Object.fromEntries(url.searchParams),
      bytes: new Uint8Array(await body.arrayBuffer()),
      contentType: body.type,
    });
    return new Response(null, { status: 202 });
  };
  // Every event's time falls between these (leaked).
  const from = Date.now();
  const recorder = await start(settings, fetch, overrides);
  await tick();

  await before();
  type(formField("text"), "TypedSecretQuince");
  type(formField("password"), "PassSecret#9931");
  type(formField("textarea"), "TextareaSecretBirch");
  type(formField("select"), "SelectValueSecretAsh");
  type(formField("unmask-input"), "UnmaskInputSecretElm");
  byId("editable").textContent = "EditableSecretCedar";
  const inserted = document.createElement("p");
  inserted.textContent = "InsertedSecretWillow";
  document.querySelector("main")?.append(inserted);
  byId("name").setAttribute("title", "ChangedAttrSecretAspen");
  byId("link").setAttribute("href", "/next?token=CHANGEDTOKEN6612");
  await tick();
  // Markers added by the page's script after it was recorded.
  byId("later-block").setAttribute("data-ottertrail-block", "");
  byId("later-mask").setAttribute("data-ottertrail-mask", "");
  await tick();
  byId("later-block").textContent = "AfterBlockSecretOak";
  byId("later-mask").textContent = "AfterMaskSecretPine";
  await tick();

  const replayId = await recorder.error();
  expect(replayId).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  // Another error while it still records shares the replay.
  expect(await recorder.error()).toBe(replayId);

  await expect
    .poll(() => chunks.some((chunk) => chunk.params.last === "1"), { timeout: 20_000 })
    .toBe(true);
  // Errors after it was sent get none: one replay per recording.
  expect(await recorder.error()).toBeUndefined();
  const to = Date.now();
  // Not sorted: they must arrive in order (expectWellFormed).
  const text = await gunzip(chunks);
  return { chunks, text, replayId, from, to };
}

/** What every upload must be, whatever the settings. */
function expectWellFormed(
  { chunks, text, replayId }: Awaited<ReturnType<typeof recordPage>>,
  cut = false,
) {
  expect(chunks.map((chunk) => Number(chunk.params.seq))).toEqual(chunks.map((_, i) => i));
  expect(chunks.filter((chunk) => chunk.params.last === "1")).toHaveLength(1);
  expect(chunks.at(-1)?.params).toMatchObject({ last: "1", cut: cut ? "1" : "0" });
  for (const chunk of chunks) {
    expect(chunk.params).toMatchObject({ key: "pk_test", replay: replayId });
    expect(chunk.bytes.length).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
    expect(chunk.contentType).toBe("text/plain;charset=utf-8");
  }
  for (const chunk of chunks.slice(0, -1)) {
    expect(chunk.params).toMatchObject({ last: "0", cut: "0" });
  }
  const recording = JSON.parse(text) as { v: number; events: { type: number }[] };
  expect(Object.keys(recording)).toEqual(["v", "events"]);
  expect(recording.v).toBe(1);
  const types = recording.events.map((event) => event.type);
  // Meta, then the full snapshot, before any change to it.
  expect(types[0]).toBe(4);
  expect(types[1]).toBe(2);
  return recording;
}

/** Text that hardly compresses. */
const noise = (length: number) => {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 65_536) {
    crypto.getRandomValues(bytes.subarray(i, i + 65_536));
  }
  return Array.from(bytes, (byte) => String.fromCharCode(48 + (byte % 75))).join("");
};

const present = (text: string, values: string[]) => values.filter((value) => text.includes(value));

/** An event's time in the recording's JSON: a key, as quotes inside a string are escaped. */
const EVENT_TIME = /"timestamp":(\d+)(?=[,}])/g;

/**
 * The values found in a recording, searched as it was sent except for its
 * events' times. A time has 13 digits, so it now and then holds a planted
 * number ("4111", "9931") by chance; each must be a time while the page was
 * recorded, which no page text can be, and only then is left out.
 */
function leaked(recording: { text: string; from: number; to: number }, values: string[]) {
  const rest = recording.text.replace(EVENT_TIME, (_, time: string) => {
    const ms = Number(time);
    if (ms < recording.from || ms > recording.to) {
      throw new Error(`"timestamp":${time} is not a time while the page was recorded`);
    }
    return '"timestamp":0';
  });
  return present(rest, values);
}

describe("the privacy test", () => {
  test("the search skips only events' times, and only times while it recorded", () => {
    const from = 1_795_054_111_000;
    const to = from + 2_000;
    const recording = (event: string) => ({ text: `{"v":1,"events":[${event}]}`, from, to });
    // The failure this guards against: an error event at 1795054111000 matched "4111".
    expect(leaked(recording(`{"type":5,"timestamp":${from}}`), PLANTED)).toEqual([]);
    expect(
      leaked(recording(`{"type":3,"data":{"text":"4111"},"timestamp":${from}}`), PLANTED),
    ).toEqual(["4111"]);
    expect(
      leaked(recording(`{"type":3,"data":{"text":"\\"timestamp\\":4111"},"timestamp":${from}}`), [
        "4111",
      ]),
    ).toEqual(["4111"]);
    expect(leaked(recording(`{"type":3,"data":{"x":9931},"timestamp":${from}}`), NEVER)).toEqual([
      "9931",
    ]);
    expect(() => leaked(recording(`{"type":3,"timestamp":4111}`), PLANTED)).toThrow(
      "is not a time while the page was recorded",
    );
  });

  test("with the defaults, nothing planted is in the recording", async () => {
    const result = await recordPage();
    const recording = expectWellFormed(result);
    expect(leaked(result, PLANTED)).toEqual([]);
    // It still recorded the page: masked text keeps its length, the error is marked.
    expect(result.text).toContain("********** ************");
    expect(recording.events.some((event) => event.type === 5)).toBe(true);
    // The blocked region and the image are boxes, the link keeps its path only.
    expect(result.text).toContain(`${location.origin}/account"`);
    expect(result.text).not.toContain("cdn.example.com/photo");
  });

  test("the filter alone holds, with rrweb's own masking turned off", async () => {
    const raw: string[] = [];
    const result = await recordPage(
      {},
      {
        record: (emit) =>
          record({
            emit: (event, isCheckout) => {
              raw.push(JSON.stringify(event));
              emit(event, isCheckout);
            },
            checkoutEveryNms: 30_000,
            slimDOMOptions: "all",
          }),
      },
    );
    expectWellFormed(result);
    expect(leaked(result, PLANTED)).toEqual([]);
    // What rrweb gave the filter had them: the filter took them out.
    const unfiltered = raw.join("\n");
    expect(
      present(unfiltered, [
        "Wilhelmina Quarterfield",
        "4111 1111 1111 1111",
        "TOKENLINK8842",
        "TitleSecretOrchid",
        "DataAttrSecretYew",
        "TypedSecretQuince",
        "SelectValueSecretAsh",
        "EditableSecretCedar",
        "BlockedSecretSpruce",
        "AfterBlockSecretOak",
        "AfterMaskSecretPine",
        "TOKENSTYLE3301",
      ]),
    ).toHaveLength(12);
  });

  test('data-replay-text="show" shows page text, never typed values, marked text, or tokens', async () => {
    const result = await recordPage({ text: true });
    expectWellFormed(result);
    expect(leaked(result, NEVER)).toEqual([]);
    expect(
      present(result.text, [
        "Wilhelmina Quarterfield",
        "wilhelmina.q@example.org",
        "4111 1111 1111 1111",
        "InsertedSecretWillow",
        "TitleSecretOrchid",
        "LaterTarget",
      ]),
    ).toHaveLength(6);
  });

  test("with text shown, the filter alone holds too", async () => {
    const result = await recordPage(
      { text: true },
      { record: (emit) => record({ emit, checkoutEveryNms: 30_000, slimDOMOptions: "all" }) },
    );
    expectWellFormed(result);
    expect(leaked(result, NEVER)).toEqual([]);
    expect(result.text).toContain("Wilhelmina Quarterfield");
  });

  test("data-ottertrail-unmask shows its text in a private recording, never a typed value", async () => {
    const result = await recordPage();
    expect(result.text).toContain("UnmaskedVisibleHeading");
    expect(result.text).not.toContain("UnmaskInputSecretElm");
    expect(result.text).not.toContain("Wilhelmina");
  });

  test('data-replay-media="show" keeps image addresses, without their queries', async () => {
    const result = await recordPage({ media: true });
    expectWellFormed(result);
    expect(result.text).toContain('"https://cdn.example.com/photo.png"');
    expect(result.text).toContain("https://cdn.example.com/photo-2x.png 2x");
    expect(result.text).toContain(`${location.origin}/photo-3x.png 3x`);
    expect(leaked(result, NEVER)).toEqual([]);
    expect(leaked(result, PLANTED)).toEqual([]);
  });

  test("a recording past 2 MB is cut at an event's end, and still parses", async () => {
    // Text that hardly compresses, added after the snapshot: about 3 MB.
    const result = await recordPage({ text: true }, {}, async () => {
      for (let i = 0; i < 30; i += 1) {
        const paragraph = document.createElement("p");
        paragraph.textContent = noise(100_000);
        document.body.append(paragraph);
        await tick(5);
      }
      await tick();
    });
    expectWellFormed(result, true);
    const total = result.chunks.reduce((sum, chunk) => sum + chunk.bytes.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_REPLAY_BYTES);
    expect(total).toBeGreaterThan(MAX_REPLAY_BYTES * 0.9);
  }, 60_000);
});

interface TrackerApi {
  replay(on: boolean): void;
  captureError(error: unknown): void;
}
const api = () => Reflect.get(window, "ottertrail") as TrackerApi;

let runs = 0;

/**
 * Runs the tracker (script.ts) in this page as its <script> tag with these
 * attributes would, with fetch answering for the API. Scripts it adds to
 * the page are kept, not loaded; returns them.
 */
async function runTracker(
  attributes: Record<string, string>,
  answer: (url: URL, init?: RequestInit) => Promise<Response> = async () =>
    new Response(null, { status: 202 }),
) {
  const scripts: HTMLScriptElement[] = [];
  const append = vi.spyOn(document.head, "append").mockImplementation((...nodes) => {
    for (const node of nodes) if (node instanceof HTMLScriptElement) scripts.push(node);
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) =>
    answer(new URL(input instanceof Request ? input.url : input.toString()), init);
  cleanups.push(() => {
    append.mockRestore();
    globalThis.fetch = realFetch;
    // The page's recording, and the tracker's API, go with the test.
    Reflect.get(window, "ottertrail")?.replay?.(false);
    Reflect.deleteProperty(window, "ottertrail");
  });

  const tag = document.createElement("script");
  tag.src = "https://analytics.example.com/t.js";
  Object.assign(tag.dataset, {
    key: "pk_test",
    host: "https://analytics.example.com",
    vitals: "off",
    ...attributes,
  });
  Object.defineProperty(document, "currentScript", { configurable: true, get: () => tag });
  try {
    // A module of its own each time: the tracker runs when imported.
    const url = `../../src/script.ts?run=${(runs += 1)}`;
    await import(/* @vite-ignore */ url);
  } finally {
    Reflect.deleteProperty(document, "currentScript");
  }
  return scripts;
}

/** Runs r.js's entry point (replay.ts) as the script the tracker added for it. */
async function runRecorderScript(script: HTMLScriptElement) {
  expect(script.src).toBe("https://analytics.example.com/r.js");
  Object.defineProperty(document, "currentScript", { configurable: true, get: () => script });
  try {
    const url = `../../src/replay.ts?run=${(runs += 1)}`;
    await import(/* @vite-ignore */ url);
  } finally {
    Reflect.deleteProperty(document, "currentScript");
  }
}

/** What the page wrote to cookies and storage while `run` ran. */
async function storageWrites(run: () => Promise<void>) {
  const writes: string[] = [];
  const cookie = vi.spyOn(Document.prototype, "cookie", "set").mockImplementation((value) => {
    writes.push(`cookie ${value}`);
  });
  const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation((key) => {
    writes.push(`storage ${key}`);
  });
  try {
    await run();
  } finally {
    cookie.mockRestore();
    setItem.mockRestore();
  }
  return writes;
}

/** The stand-in, run as the site's own <script> before the tracker's deferred one. */
const defineStandIn = () => {
  const inline = document.createElement("script");
  inline.textContent = STAND_IN;
  document.head.appendChild(inline);
  cleanups.push(() => inline.remove());
};

describe("a recording started by replay(true)", () => {
  test('with data-replay-consent="wait", r.js is requested only after replay(true)', async () => {
    document.body.innerHTML = PAGE;
    const scripts = await runTracker({
      replay: "errors",
      replayConsent: "wait",
      replayText: "show",
    });
    expect(scripts).toEqual([]);
    api().replay(true);
    api().replay(true);
    expect(scripts.map((script) => script.src)).toEqual(["https://analytics.example.com/r.js"]);
    expect(Reflect.get(scripts[0] ?? {}, REPLAY_PROPERTY)).toMatchObject({
      endpoint: "https://analytics.example.com/api/replays",
      key: "pk_test",
      text: true,
      media: false,
    });
  });

  test("the before-load pattern queues the answer until the tracker runs", async () => {
    defineStandIn();
    api().replay(true);
    expect(Reflect.get(window, "ottertrail")).toMatchObject({ q: [true] });
    // Calls the site guards only with ?. work before the tracker runs.
    api().captureError(new Error("before the tracker"));

    const scripts = await runTracker({ replay: "errors", replayConsent: "wait" });
    expect(scripts.map((script) => script.src)).toEqual(["https://analytics.example.com/r.js"]);
    expect(Reflect.get(window, "ottertrail")).not.toHaveProperty("q");
  });

  test("with the before-load pattern, a decline after agreeing requests nothing", async () => {
    defineStandIn();
    api().replay(true);
    api().replay(false);
    const scripts = await runTracker({ replay: "errors", replayConsent: "wait" });
    expect(scripts).toEqual([]);
  });

  test("the privacy test passes, and nothing is stored on the device", async () => {
    // What the tracker sent to /api/events: each error's replay ID.
    const errors: { message?: string; replayId?: string }[] = [];
    let count = 0;
    const writes = await storageWrites(async () => {
      const result = await recordPage({}, {}, undefined, async (_settings, fetch) => {
        const scripts = await runTracker(
          { replay: "errors", replayConsent: "wait" },
          async (url, init) => {
            if (url.pathname === "/api/replays") return fetch(url, init);
            const batch = JSON.parse(typeof init?.body === "string" ? init.body : "") as {
              events: { error?: { message?: string; replayId?: string } }[];
            };
            for (const event of batch.events) if (event.error) errors.push(event.error);
            return new Response(null, { status: 202 });
          },
        );
        expect(scripts).toEqual([]);
        api().replay(true); // The visitor agreed.
        const [recorderScript] = scripts;
        if (recorderScript === undefined) throw new Error("r.js was not requested");
        await runRecorderScript(recorderScript);
        return {
          // An error the site caught, sent with the replay's ID.
          error: async () => {
            const message = `Caught ${(count += 1)}`;
            api().captureError(new Error(message));
            await expect
              .poll(() => errors.some((error) => error.message === message), { timeout: 5_000 })
              .toBe(true);
            return errors.find((error) => error.message === message)?.replayId;
          },
        };
      });
      expectWellFormed(result);
      expect(leaked(result, PLANTED)).toEqual([]);
      expect(result.text).toContain("********** ************");
    });
    expect(writes).toEqual([]);
    expect(document.cookie).toBe("");
  }, 60_000);
  test("a recording started again after replay(false) is new: the first sent nothing", async () => {
    const errors: { message?: string; replayId?: string }[] = [];
    let count = 0;
    let restartedAt = 0;
    let sentBeforeRestart = -1;
    let uploads = 0;
    const result = await recordPage({}, {}, undefined, async (_settings, fetch) => {
      const scripts = await runTracker(
        { replay: "errors", replayConsent: "wait" },
        async (url, init) => {
          if (url.pathname === "/api/replays") {
            uploads += 1;
            return fetch(url, init);
          }
          const batch = JSON.parse(typeof init?.body === "string" ? init.body : "") as {
            events: { error?: { message?: string; replayId?: string } }[];
          };
          for (const event of batch.events) if (event.error) errors.push(event.error);
          return new Response(null, { status: 202 });
        },
      );
      api().replay(true);
      const [recorderScript] = scripts;
      if (recorderScript === undefined) throw new Error("r.js was not requested");
      await runRecorderScript(recorderScript);
      // The first recording takes the page in, typed values included.
      await tick(100);
      byId("name").textContent = "FirstRecordingSecretHazel";
      await tick(100);
      api().replay(false); // Withdrawn: dropped.
      await tick(100);
      sentBeforeRestart = uploads;
      restartedAt = Date.now();
      api().replay(true); // Agreed again: a new recording.
      expect(scripts).toHaveLength(1); // r.js is not loaded again.
      return {
        error: async () => {
          const message = `Again ${(count += 1)}`;
          api().captureError(new Error(message));
          await expect
            .poll(() => errors.some((error) => error.message === message), { timeout: 5_000 })
            .toBe(true);
          return errors.find((error) => error.message === message)?.replayId;
        },
      };
    });
    expect(sentBeforeRestart).toBe(0);
    expect(uploads).toBe(result.chunks.length);
    // One replay, the second recording's, from its own snapshot on.
    const recording = expectWellFormed(result);
    const times = recording.events.map((event) => Reflect.get(event, "timestamp") as number);
    expect(Math.min(...times)).toBeGreaterThanOrEqual(restartedAt);
    expect(leaked(result, [...PLANTED, "FirstRecordingSecretHazel"])).toEqual([]);
    expect(result.text).not.toContain("FirstRecordingSecretHazel");
  }, 60_000);
});
