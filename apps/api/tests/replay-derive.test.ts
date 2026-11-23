import { readFileSync } from "node:fs";

import { describe, expect, test } from "vite-plus/test";

import {
  CLOCK_TOLERANCE_MS,
  cleanTag,
  deriveReplay,
  isTimelineItem,
  MAX_PAGES,
  MAX_TIMELINE_ITEMS,
  pathOf,
} from "../src/replays/derive.ts";

/**
 * Chromium recording from rrweb 2.2.2 through createFilter (replay-filter.ts).
 * On /cart: click the "Pay now" label, type a masked email, and scroll.
 * On /checkout: take a snapshot, tick a checkbox, click a <div role="button">
 * and a link, and report an error.
 *
 * To recapture in packages/tracker: use startReplay(), retain fetch chunks,
 * perform these actions with userEvent and history.pushState, call
 * record.takeFullSnapshot(true) and error(), then unpack with `gunzip`.
 * Read the origin from the fixture because the test server's port varies.
 */
const RECORDING: { v: 1; events: { type: number; timestamp: number; data: unknown }[] } =
  JSON.parse(readFileSync(new URL("fixtures/replay-recording.json", import.meta.url), "utf8"));
const START = RECORDING.events[0]?.timestamp ?? 0;
const END = RECORDING.events.at(-1)?.timestamp ?? 0;

/** A Meta event: the page's address. */
const meta = (timestamp: number, href: string) => ({ type: 4, timestamp, data: { href } });
/** An element as rrweb serializes it. */
const node = (id: number, tagName: string, attributes = {}, childNodes: unknown[] = []) => ({
  type: 2,
  id,
  tagName,
  attributes,
  childNodes,
});

describe("what a replay shows, from its recording", () => {
  test("pages, clicks, inputs, scrolls, and the error, from a real recording", () => {
    const details = deriveReplay(RECORDING.events, new Date(END + 2_000));
    expect(details.pages).toEqual(["/cart", "/checkout"]);
    expect(details.pageChanges).toBe(1);
    expect(details.clicks).toBe(4);
    // On time: the recording's own times are kept.
    expect(details.clockOffsetMs).toBe(0);
    expect(details.startedAt.getTime()).toBe(START);
    expect(details.endedAt.getTime()).toBe(END);
    expect(details.timeline.truncated).toBe(false);
    // Without times and positions, in order.
    expect(
      details.timeline.items.map((item) => {
        const { at: _at, ...rest } = item;
        if (rest.kind === "click") return { kind: rest.kind, tag: rest.tag, role: rest.role };
        if (rest.kind === "scroll") return { kind: rest.kind };
        return rest;
      }),
    ).toEqual([
      { kind: "page", path: "/cart" },
      // The click landed on the label inside the button: the button is what was clicked.
      { kind: "click", tag: "button", role: "button" },
      // Three scrolls a moment apart are one.
      { kind: "scroll" },
      { kind: "page", path: "/checkout" },
      { kind: "scroll" },
      { kind: "input", tag: "input", role: "textbox" },
      { kind: "click", tag: "input", role: "checkbox" },
      { kind: "input", tag: "input", role: "checkbox" },
      { kind: "click", tag: "div", role: "button" },
      { kind: "click", tag: "a", role: "link" },
      { kind: "error" },
    ]);
    const [first] = details.timeline.items;
    expect(first?.at).toBe(0);
    const click = details.timeline.items.find((item) => item.kind === "click");
    expect(click).toMatchObject({ x: 43, y: 148 });
    expect(details.timeline.items.at(-1)?.at).toBeGreaterThan(2_000);
    for (const item of details.timeline.items) expect(isTimelineItem(item)).toBe(true);
  });

  test("keeps none of the recording's identifiers, attributes, or origin", () => {
    const fixture = JSON.stringify(RECORDING);
    const origin = /http:\/\/localhost:\d+/.exec(fixture)?.[0] ?? "";
    // In the recording: the page's element IDs, its origin, and masked text.
    const present = ["pricing", "custom", "pay", "pay-label", "terms", "email", origin];
    for (const value of present) expect(fixture).toContain(value);
    expect(origin).toMatch(/^http:\/\/localhost:\d+$/);
    const derived = JSON.stringify(deriveReplay(RECORDING.events, new Date(END)));
    for (const value of [...present.map((id) => `"${id}"`), origin, "localhost", "*"]) {
      expect(derived).not.toContain(value);
    }
  });

  test("keeps nothing planted in a forged recording", () => {
    const planted = {
      id: "PlantedIdOak",
      class: "PlantedClassElm",
      aria: "PlantedAriaAsh",
      data: "PlantedDataYew",
      role: "PlantedRoleFir",
      type: "plantedtype",
      value: "PlantedValueIvy",
      name: "PlantedNameBay",
      text: "PlantedTextRue",
      message: "PlantedMessageSage",
      user: "planteduser",
      password: "plantedpass",
      query: "PlantedQueryRye",
      fragment: "PlantedFragmentKale",
    };
    const events = [
      {
        type: 4,
        timestamp: 0,
        data: {
          href: `https://${planted.user}:${planted.password}@shop.example/a?token=${planted.query}#${planted.fragment}`,
        },
      },
      {
        type: 2,
        timestamp: 1,
        data: {
          node: {
            type: 0,
            id: 1,
            childNodes: [
              node(
                2,
                "div",
                {
                  id: planted.id,
                  class: planted.class,
                  "aria-label": planted.aria,
                  "data-secret": planted.data,
                  role: planted.role,
                },
                [
                  node(3, "input", {
                    type: planted.type,
                    value: planted.value,
                    name: planted.name,
                  }),
                ],
              ),
            ],
          },
        },
      },
      { type: 3, timestamp: 2, data: { source: 2, type: 2, id: 2, x: 5, y: 6 } },
      { type: 3, timestamp: 3, data: { source: 2, type: 2, id: 3, x: 5, y: 6 } },
      { type: 3, timestamp: 4, data: { source: 5, id: 3, text: planted.text, isChecked: false } },
      { type: 5, timestamp: 5, data: { tag: "error", payload: { message: planted.message } } },
    ];
    const details = deriveReplay(events, new Date(5));
    const derived = JSON.stringify(details);
    for (const value of Object.values(planted)) {
      expect(derived.toLowerCase()).not.toContain(value.toLowerCase());
    }
    // What it does keep: the path, the tags, and roles from the fixed lists.
    expect(details.pages).toEqual(["/a"]);
    expect(details.timeline.items.map((item) => item.kind)).toEqual([
      "page",
      "click",
      "click",
      "input",
      "error",
    ]);
    expect(details.timeline.items[1]).toMatchObject({ tag: "div", role: null });
    expect(details.timeline.items[2]).toMatchObject({ tag: "input", role: "textbox" });
  });

  test("corrects a visitor's clock that is off, by when the first chunk came", () => {
    const received = new Date(END + 3 * 3_600_000);
    const details = deriveReplay(RECORDING.events, received);
    expect(details.clockOffsetMs).toBe(3 * 3_600_000);
    expect(details.endedAt).toEqual(received);
    expect(details.endedAt.getTime() - details.startedAt.getTime()).toBe(END - START);
    // Within the tolerance, nothing moves: a first chunk that came only on a retry,
    // minutes late, leaves a right clock alone.
    expect(deriveReplay(RECORDING.events, new Date(END + 8 * 60_000)).clockOffsetMs).toBe(0);
    expect(deriveReplay(RECORDING.events, new Date(END + CLOCK_TOLERANCE_MS)).clockOffsetMs).toBe(
      0,
    );
    expect(CLOCK_TOLERANCE_MS).toBe(10 * 60_000);
  });

  test("cleans each page's address to its path, as page URLs are", () => {
    expect(pathOf("https://shop.example/cart?token=abc#pay")).toBe("/cart");
    expect(pathOf("http://shop.example:8080/a/b/")).toBe("/a/b/");
    expect(pathOf("https://shop.example")).toBe("/");
    for (const bad of ["", "javascript:alert(1)", "/relative", "not a url", 42, null]) {
      expect(pathOf(bad)).toBeNull();
    }
    expect(pathOf(`https://shop.example/${"a".repeat(3000)}`)).toBeNull();
    const details = deriveReplay(
      [
        meta(0, "https://shop.example/a?x=1"),
        // The same path with another query string: not a page change.
        meta(10, "https://shop.example/a?x=2#top"),
        meta(20, "https://other.example/b"),
        meta(30, "data:text/html,hello"),
        meta(40, "https://shop.example/a"),
      ],
      new Date(40),
    );
    expect(details.pages).toEqual(["/a", "/b"]);
    expect(details.pageChanges).toBe(2);
  });

  test("past 500 items, drops only as many scrolls as needed, the earliest", () => {
    const events = [];
    for (let index = 0; index < 450; index += 1) {
      events.push({
        type: 3,
        timestamp: index * 10,
        data: { source: 2, type: 2, id: 1, x: 1, y: 1 },
      });
    }
    // 100 scrolls, each more than a second apart: 100 items.
    for (let index = 0; index < 100; index += 1) {
      events.push({
        type: 3,
        timestamp: 10_000 + index * 2_000,
        data: { source: 3, id: 1, x: 0, y: index },
      });
    }
    const details = deriveReplay(events, new Date(210_000));
    expect(details.timeline.truncated).toBe("scrolls");
    expect(details.timeline.items).toHaveLength(MAX_TIMELINE_ITEMS);
    expect(details.timeline.items.filter((item) => item.kind === "click")).toHaveLength(450);
    const scrolls = details.timeline.items.filter((item) => item.kind === "scroll");
    // The latest 50 kept.
    expect(scrolls).toHaveLength(50);
    expect(scrolls[0]).toMatchObject({ y: 50 });
    expect(scrolls.at(-1)).toMatchObject({ y: 99 });
  });

  test("keeps at most 30 paths and 500 items, dropping scrolls, then the earliest", () => {
    const events = [];
    for (let index = 0; index < 600; index += 1) {
      events.push({
        type: 4,
        timestamp: index * 10,
        data: { href: `https://s.example/p${index}` },
      });
      events.push({
        type: 3,
        timestamp: index * 10 + 5,
        data: { source: 3, id: 1, x: 0, y: index },
      });
    }
    const details = deriveReplay(events, new Date(6_000));
    expect(details.pages).toHaveLength(MAX_PAGES);
    expect(details.pageChanges).toBe(599);
    expect(details.timeline.truncated).toBe("earliest");
    expect(details.timeline.items).toHaveLength(MAX_TIMELINE_ITEMS);
    expect(details.timeline.items.some((item) => item.kind === "scroll")).toBe(false);
    // The latest kept: those nearest the error.
    expect(details.timeline.items.at(-1)).toEqual({ at: 5_990, kind: "page", path: "/p599" });
  });

  test("describes elements by plain tags and known roles only", () => {
    expect(cleanTag("BUTTON")).toBe("button");
    expect(cleanTag("my-widget")).toBe("my-widget");
    for (const bad of ["<script>", "a b", "", 1, "x".repeat(41)]) {
      expect(cleanTag(bad)).toBe("element");
    }
    const details = deriveReplay(
      [
        {
          type: 2,
          timestamp: 0,
          data: {
            node: {
              type: 0,
              id: 1,
              childNodes: [
                node(2, "div", { role: "<img src=x>" }, [node(3, "span")]),
                node(4, "div", { role: " TAB " }),
                node(5, "IMG<x>"),
              ],
            },
          },
        },
        { type: 3, timestamp: 1, data: { source: 2, type: 2, id: 3, x: 1, y: 2 } },
        { type: 3, timestamp: 2, data: { source: 2, type: 2, id: 4, x: 1, y: 2 } },
        { type: 3, timestamp: 3, data: { source: 2, type: 2, id: 5, x: 1, y: 2 } },
        // A node the recording never showed.
        { type: 3, timestamp: 4, data: { source: 2, type: 2, id: 99, x: "1", y: null } },
        // Added later, inside the first div.
        {
          type: 3,
          timestamp: 5,
          data: { source: 0, adds: [{ parentId: 2, node: node(6, "button") }], removes: [] },
        },
        { type: 3, timestamp: 6, data: { source: 2, type: 2, id: 6, x: 1, y: 2 } },
      ],
      new Date(6),
    );
    expect(
      details.timeline.items.map((item) =>
        item.kind === "click" ? [item.tag, item.role, item.x, item.y] : item.kind,
      ),
    ).toEqual([
      ["span", null, 1, 2],
      ["div", "tab", 1, 2],
      ["element", null, 1, 2],
      ["element", null, 0, 0],
      ["button", "button", 1, 2],
    ]);
  });

  test("a cut recording's start is described as far as it goes", () => {
    // The first half only, as a replay whose end never came is kept.
    const half = RECORDING.events.filter((event) => event.timestamp - START < 1_000);
    const details = deriveReplay(half, new Date(END));
    expect(details.pages).toEqual(["/cart"]);
    expect(details.clicks).toBe(1);
    expect(details.timeline.items.map((item) => item.kind)).toEqual(["page", "click", "scroll"]);
  });

  test("checks stored items' shape", () => {
    expect(isTimelineItem({ at: 1, kind: "page", path: "/a" })).toBe(true);
    expect(isTimelineItem({ at: 1, kind: "click", tag: "a", role: "link", x: 1, y: 1 })).toBe(true);
    expect(isTimelineItem({ at: 1, kind: "click", tag: "a", role: "evil", x: 1, y: 1 })).toBe(
      false,
    );
    expect(isTimelineItem({ at: "1", kind: "error" })).toBe(false);
    expect(isTimelineItem({ at: 1, kind: "script" })).toBe(false);
  });
});
