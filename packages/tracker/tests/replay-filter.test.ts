import { describe, expect, test } from "vite-plus/test";

import {
  blockSelector,
  cleanCss,
  cleanSrcset,
  cleanUrl,
  createFilter,
  maskText,
  maskValue,
  stripQueries,
} from "../src/replay-filter.ts";

const BASE = "https://shop.example.com/account/orders?session=abc#top";

describe("masking", () => {
  test("text keeps its length and spaces; typed values keep only their length", () => {
    expect(maskText("Ada Lovelace\n 42")).toBe("*** ********\n **");
    expect(maskValue("pass word")).toBe("*********");
  });
});

describe("addresses", () => {
  test("http(s) addresses keep origin and path, resolved against the page", () => {
    expect(cleanUrl("https://cdn.example.com/a.png?token=x#y", BASE)).toBe(
      "https://cdn.example.com/a.png",
    );
    expect(cleanUrl("../cart?coupon=SECRET", BASE)).toBe("https://shop.example.com/cart");
    expect(cleanUrl("?token=x", BASE)).toBe("https://shop.example.com/account/orders");
    expect(cleanUrl("https://user:pw@example.com/p", BASE)).toBe("https://example.com/p");
  });

  test("other schemes are removed; data: and blob: stay only when allowed", () => {
    for (const value of ["javascript:alert(1)", "mailto:ada@example.com", "tel:+15550100", ""]) {
      expect(cleanUrl(value, BASE)).toBeUndefined();
    }
    expect(cleanUrl("data:image/png;base64,AAAA", BASE)).toBeUndefined();
    expect(cleanUrl("data:image/png;base64,AAAA", BASE, true)).toBe("data:image/png;base64,AAAA");
    expect(cleanUrl("blob:https://shop.example.com/1234", BASE, true)).toBe(
      "blob:https://shop.example.com/1234",
    );
  });

  test("every srcset address is cleaned, with valid descriptors only", () => {
    expect(cleanSrcset("/a.png?t=1 1x, https://cdn.example.com/b.png?t=2 2x", BASE)).toBe(
      "https://shop.example.com/a.png 1x, https://cdn.example.com/b.png 2x",
    );
    expect(cleanSrcset("a.png?x=1 100w,b.png 200w", BASE)).toBe(
      "https://shop.example.com/account/a.png 100w, https://shop.example.com/account/b.png 200w",
    );
    expect(cleanSrcset("data:image/png;base64,AA,BB 1x, javascript:x 2x", BASE)).toBeUndefined();
    expect(cleanSrcset("/a.png secret-word 2x", BASE)).toBe("https://shop.example.com/a.png 2x");
  });

  test("url() in CSS is cleaned; escapes and other schemes become url()", () => {
    expect(
      cleanCss(`background: url("/bg.png?token=a") , url('x.png#f'), url(y.png?q)`, BASE),
    ).toBe(
      'background: url("https://shop.example.com/bg.png") , url("https://shop.example.com/account/x.png"), url("https://shop.example.com/account/y.png")',
    );
    expect(cleanCss(`a{b:url("javascript:alert(1)")}`, BASE)).toBe("a{b:url()}");
    expect(cleanCss("a{b:url(/x\\3f token=1)}", BASE)).toBe("a{b:url()}");
    expect(cleanCss(String.raw`a{b:url("/x\"?token=1")}`, BASE)).toBe("a{b:url()}");
    expect(cleanCss(`@import "https://cdn.example.com/a.css?t=1"; @import 'mailto:x';`, BASE)).toBe(
      '@import "https://cdn.example.com/a.css"; @import "";',
    );
    expect(cleanCss(`b:image-set("/a.png?t=1" 1x, 'b.png#f' 2x)`, BASE)).toBe(
      'b:image-set("https://shop.example.com/a.png" 1x, "https://shop.example.com/account/b.png" 2x)',
    );
    // Whatever the syntax, no address keeps its query.
    expect(cleanCss("b:src(https://cdn.example.com/x.png?token=1)", BASE)).toBe(
      "b:src(https://cdn.example.com/x.png)",
    );
    expect(cleanCss("a{b:url(data:image/png;base64,AA)}", BASE)).toBe("a{b:url()}");
    expect(cleanCss("a{b:url(data:image/png;base64,AA)}", BASE, true)).toBe(
      'a{b:url("data:image/png;base64,AA")}',
    );
  });

  test("queries are stripped from addresses inside other text", () => {
    expect(stripQueries("see https://a.example/p?token=1#x and http://b.example/?q")).toBe(
      "see https://a.example/p and http://b.example/",
    );
  });

  test("rrweb blocks frames and canvas always, media unless shown", () => {
    expect(blockSelector(true)).toBe(
      "canvas,iframe,frame,object,embed,portal,fencedframe,[data-ottertrail-block]",
    );
    expect(blockSelector(false)).toContain("img,picture,video,audio,svg,input[type=image]");
  });
});

// A small page as rrweb serializes it.
const element = (
  id: number,
  tagName: string,
  attributes: Record<string, unknown>,
  childNodes: unknown[] = [],
) => ({ type: 2, id, tagName, attributes, childNodes });
const text = (id: number, textContent: string) => ({ type: 3, id, textContent });

const snapshot = (body: unknown[]) => ({
  type: 2,
  timestamp: 1,
  data: {
    node: {
      type: 0,
      id: 1,
      childNodes: [element(2, "html", {}, [element(3, "body", {}, body)])],
    },
    initialOffset: { top: 0, left: 0 },
  },
});

const mutation = (data: Record<string, unknown>) => ({
  type: 3,
  timestamp: 2,
  data: { source: 0, texts: [], attributes: [], removes: [], adds: [], ...data },
});

const filterOf = (options: { showText?: boolean; showMedia?: boolean } = {}) =>
  createFilter({ showText: false, showMedia: false, base: BASE, ...options });

const json = (value: unknown) => JSON.stringify(value);

describe("the filter", () => {
  test("only known event types pass", () => {
    const filter = filterOf();
    expect(filter({ type: 0, data: {}, timestamp: 1 })).toEqual({
      type: 0,
      data: {},
      timestamp: 1,
    });
    const unknown = [
      { type: 6, data: { plugin: "rrweb/console@1", payload: { payload: ["secret"] } } }, // Plugin
      { type: 5, data: { tag: "user", payload: { email: "a@b.c" } } }, // Another custom event
      { type: 3, data: { source: 9, id: 1, commands: [] } }, // Canvas
      { type: 3, data: { source: 10, family: "x", fontSource: "url(secret)" } }, // Font
      { type: 3, data: { source: 11, payload: ["secret"] } }, // Log
      { type: 3, data: { source: 99 } },
      { type: 42, data: {} },
    ];
    for (const event of unknown) {
      expect(filter({ ...event, timestamp: 1 })).toBeUndefined();
    }
    expect(filter({ type: 5, data: { tag: "error", payload: { x: 1 } }, timestamp: 3 })).toEqual({
      type: 5,
      data: { tag: "error", payload: {} },
      timestamp: 3,
    });
  });

  test("the page's URL keeps origin and path", () => {
    expect(
      filterOf()({ type: 4, data: { href: BASE, width: 800, height: 600, x: "y" }, timestamp: 1 }),
    ).toEqual({
      type: 4,
      data: { href: "https://shop.example.com/account/orders", width: 800, height: 600 },
      timestamp: 1,
    });
  });

  test("markers: block, then mask, then unmask; stylesheets kept, scripts emptied", () => {
    const page = snapshot([
      element(10, "p", {}, [text(11, "Ada Lovelace")]),
      element(12, "nav", { "data-ottertrail-unmask": "" }, [
        text(13, "Menu"),
        element(14, "span", { "data-ottertrail-mask": "" }, [text(15, "Grace")]),
        element(16, "textarea", {}, [text(17, "typed")]),
      ]),
      element(
        18,
        "div",
        { "data-ottertrail-block": "", class: "card", rr_width: "300px", rr_height: "20px" },
        [text(19, "4111")],
      ),
      element(20, "style", { _cssText: ".a{background:url(/i.png?t=1)}" }, [
        text(21, ".b{color:red}"),
      ]),
      element(22, "script", { src: "/app.js?v=1", "data-config": "secret" }, [
        text(23, "var token=1"),
      ]),
    ]);
    const out = json(filterOf()(page));
    expect(out).not.toMatch(/Ada|Grace|typed|4111|card|token|secret|t=1|v=1/);
    expect(out).toContain('"textContent":"Menu"');
    expect(out).toContain('"textContent":"*** ********"');
    expect(out).toContain(
      '{"type":2,"id":18,"tagName":"div","attributes":{"rr_width":"300px","rr_height":"20px"},"childNodes":[]}',
    );
    expect(out).toContain('"textContent":".b{color:red}","isStyle":true');
    expect(out).toContain('"_cssText":".a{background:url(\\"https://shop.example.com/i.png\\")}"');
    expect(out).toContain('{"type":3,"id":23,"textContent":""}');

    const shown = json(filterOf({ showText: true })(page));
    expect(shown).toContain("Ada Lovelace");
    expect(shown).not.toMatch(/Grace|typed|4111/);
  });

  test("attributes: read text masked, typed values always, unknown ones as text", () => {
    const page = snapshot([
      element(10, "input", {
        type: "email",
        value: "ada@example.com",
        placeholder: "Your email",
        "aria-label": "Email",
        onfocus: "steal()",
        "data-user": "ada",
        class: "field",
      }),
      element(11, "a", { href: "mailto:ada@example.com", title: "Write to Ada" }),
      element(12, "meta", { name: "author", content: "Ada" }),
    ]);
    const hidden = json(filterOf()(page));
    expect(hidden).not.toMatch(/ada|Ada|Your|Email|steal|mailto/);
    expect(hidden).toContain('"class":"field"');
    const shown = json(filterOf({ showText: true })(page));
    expect(shown).toContain('"placeholder":"Your email"');
    expect(shown).toContain('"data-user":"ada"');
    expect(shown).not.toMatch(/ada@example|steal|mailto/);
  });

  test("changes know their element's markers, also ones added later", () => {
    const filter = filterOf({ showText: true });
    filter(
      snapshot([
        element(10, "div", { "data-ottertrail-mask": "" }, [text(11, "x")]),
        element(12, "div", {}, [text(13, "y")]),
        element(14, "div", {}, []),
      ]),
    );
    const out = filter(
      mutation({
        attributes: [{ id: 14, attributes: { "data-ottertrail-block": "" } }],
        texts: [
          { id: 11, value: "Masked Name" },
          { id: 13, value: "Shown" },
          { id: 999, value: "Unknown node" },
        ],
        adds: [
          { parentId: 10, nextId: null, node: text(20, "Added Under Mask") },
          { parentId: 14, nextId: null, node: text(21, "Added Under Block") },
          { parentId: 12, nextId: null, node: element(22, "b", { "data-ottertrail-unmask": "" }) },
          { parentId: 22, nextId: null, node: text(23, "Bold") },
          { parentId: 998, nextId: null, node: text(24, "Orphan") },
        ],
      }),
    );
    const result = json(out);
    expect(result).not.toMatch(/Masked|Under|Unknown|Orphan|ottertrail/);
    expect(result).toContain('{"id":13,"value":"Shown"}');
    expect(result).toContain('"textContent":"Bold"');
    // Later text inside the newly blocked element is dropped.
    expect(filter(mutation({ texts: [{ id: 21, value: "Late" }] }))).toBeUndefined();
  });

  test("input events are always masked; attribute changes cleaned", () => {
    const filter = filterOf({ showText: true });
    filter(snapshot([element(10, "input", { type: "text" }), element(11, "a", {})]));
    expect(
      filter({ type: 3, timestamp: 5, data: { source: 5, id: 10, text: "Ada", isChecked: false } }),
    ).toEqual({
      type: 3,
      timestamp: 5,
      data: { source: 5, id: 10, isChecked: false, text: "***" },
    });
    const changed = json(
      filter(
        mutation({
          attributes: [
            {
              id: 10,
              attributes: { value: "Ada", style: { background: "url(/b.png?t=1)", color: false } },
            },
            { id: 11, attributes: { href: "javascript:void 0", ping: "/p?x=1 /q" } },
          ],
        }),
      ),
    );
    expect(changed).toContain('"value":"***"');
    expect(changed).toContain(
      '"background":"url(\\"https://shop.example.com/b.png\\")","color":false',
    );
    expect(changed).toContain('"href":null');
    expect(changed).toContain('"ping":"https://shop.example.com/p https://shop.example.com/q"');
  });

  test("media addresses stay, without queries, only when media is shown", () => {
    const page = snapshot([
      element(10, "img", {
        src: "https://cdn.example.com/a.png?sig=1",
        srcset: "data:image/png;base64,AA 2x",
      }),
    ]);
    expect(json(filterOf()(page))).not.toContain("cdn.example.com");
    const shown = json(filterOf({ showMedia: true })(page));
    expect(shown).toContain('"src":"https://cdn.example.com/a.png"');
    expect(shown).toContain('"srcset":"data:image/png;base64,AA 2x"');
  });
});
