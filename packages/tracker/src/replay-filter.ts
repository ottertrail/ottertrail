/**
 * The replay recorder's privacy filter (docs/session-replay.md, "Private by
 * default"). rrweb's own options mask first; every event rrweb emits then
 * passes through this filter before it is kept, which applies the rules
 * again without trusting rrweb:
 *
 * - Page text is masked (each non-space character becomes "*") unless the
 *   site shows it: data-replay-text="show", or a data-ottertrail-unmask
 *   ancestor. data-ottertrail-mask and -block always win. Stylesheet text is
 *   kept (the page needs it); script text is removed.
 * - Attributes people read (title, alt, aria-label, …) are masked as text.
 *   Typed values (the value attribute, Input events) are always masked, and
 *   so is text inside text areas, selects, and editable regions.
 * - Addresses keep only origin and path; other schemes are removed.
 * - Blocked elements are a box of their size, with nothing from inside.
 * - Only known event types pass, rebuilt from the fields the player needs.
 *
 * Every element and text node the filter lets through is kept in a map
 * (id → parent, own flags), rebuilt at each full snapshot, so a later change
 * to a node knows the markers above it. An event the filter cannot read is
 * dropped; an exception stops the recording (replay-recorder.ts).
 */

// rrweb's numbers (@rrweb/types): event types, incremental sources, node types.
const LOAD_EVENTS = new Set([0, 1]); // DomContentLoaded, Load
const FULL_SNAPSHOT = 2;
const INCREMENTAL = 3;
const META = 4;
const CUSTOM = 5;

const MUTATION = 0;
const MOUSE_MOVE = 1;
const MOUSE_INTERACTION = 2;
const SCROLL = 3;
const VIEWPORT_RESIZE = 4;
const INPUT = 5;
const TOUCH_MOVE = 6;
const MEDIA_INTERACTION = 7;
const STYLE_SHEET_RULE = 8;
const DRAG = 12;
const STYLE_DECLARATION = 13;
const SELECTION = 14;
const ADOPTED_STYLE_SHEET = 15;
const CUSTOM_ELEMENT = 16;

const DOCUMENT = 0;
const DOCUMENT_TYPE = 1;
const ELEMENT = 2;
const TEXT = 3;
const CDATA = 4;
const COMMENT = 5;

/** The custom event the recorder adds where an error happened. */
export const ERROR_TAG = "error";

// A node's flags: its own, from its tag and markers; a node's effective
// flags are its own and all its ancestors'.
export const BLOCK = 1;
export const MASK = 2;
export const UNMASK = 4;
/** Inside a text area, select, or editable region: what is typed there. */
export const TYPED = 8;
export const STYLE = 16;
export const SCRIPT = 32;
export const SVG = 64;

/** Never recorded, whatever the settings: what they show is not in the HTML, or is another site. */
const ALWAYS_BLOCKED = ["canvas", "iframe", "frame", "object", "embed", "portal", "fencedframe"];
/** Recorded only with data-replay-media="show". */
const MEDIA = ["img", "picture", "video", "audio", "svg"];
const TYPED_TAGS = new Set(["textarea", "select", "option", "optgroup", "datalist"]);
/** Elements whose data: or blob: addresses may stay when media is shown. */
const MEDIA_SOURCES = new Set(["img", "source", "video", "audio", "track", "image"]);

export const BLOCK_ATTRIBUTE = "data-ottertrail-block";
export const MASK_ATTRIBUTE = "data-ottertrail-mask";
export const UNMASK_ATTRIBUTE = "data-ottertrail-unmask";
/** The heatmaps' element name (heatmap-path.ts), kept only with keepNames. */
const NAME_ATTRIBUTE = "data-ottertrail-name";
const NAME_PATTERN = /^\s*[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,63}\s*$/;

/** The elements rrweb blocks (its blockSelector), and the filter too. */
export function blockSelector(showMedia: boolean): string {
  return [
    ...ALWAYS_BLOCKED,
    ...(showMedia ? [] : [...MEDIA, "input[type=image]"]),
    `[${BLOCK_ATTRIBUTE}]`,
  ].join(",");
}

/** Attributes that hold addresses: origin and path only. */
const ADDRESSES = new Set([
  "href",
  "src",
  "action",
  "formaction",
  "poster",
  "cite",
  "data",
  "ping",
  "background",
  "xlink:href",
  "srcset",
  "imagesrcset",
  "longdesc",
  "lowsrc",
  "manifest",
  "codebase",
  "itemtype",
]);
/** Attributes people read: masked as text. */
const READ_TEXT = new Set([
  "title",
  "placeholder",
  "alt",
  "aria-label",
  "aria-description",
  "aria-placeholder",
  "aria-valuetext",
  "aria-roledescription",
  "label",
]);
/**
 * Attributes about structure and style, kept as they are. Any attribute not
 * named in one of these lists (data-*, custom ones) is treated as text:
 * masked unless the page's text is shown.
 */
const STRUCTURE = new Set(
  (
    "class id name type rel role lang dir hidden inert disabled checked selected readonly " +
    "required multiple autofocus open novalidate formnovalidate tabindex draggable " +
    "contenteditable spellcheck translate autocomplete autocapitalize autocorrect inputmode " +
    "enterkeyhint maxlength minlength min max step size cols rows wrap accept method enctype " +
    "target for form list headers width height colspan rowspan span scope start reversed align " +
    "valign bgcolor color border cellpadding cellspacing nowrap frameborder media sizes as " +
    "crossorigin integrity referrerpolicy loading decoding fetchpriority charset http-equiv " +
    "slot part is popover popovertarget popovertargetaction xmlns xmlns:xlink viewbox " +
    "preserveaspectratio controls loop muted playsinline autoplay preload data-rr-is-password " +
    "aria-hidden aria-expanded aria-selected aria-checked aria-pressed aria-disabled " +
    "aria-current aria-haspopup aria-controls aria-labelledby aria-describedby aria-owns " +
    "aria-activedescendant aria-live aria-atomic aria-relevant aria-busy aria-modal " +
    "aria-orientation aria-level aria-posinset aria-setsize aria-sort aria-invalid " +
    "aria-required aria-readonly aria-multiselectable aria-colcount aria-colindex " +
    "aria-colspan aria-rowcount aria-rowindex aria-rowspan aria-autocomplete aria-errormessage " +
    "aria-details"
  ).split(" "),
);
/** rrweb's own attributes that the player needs; any other rr_ attribute is dropped. */
const RRWEB_ATTRIBUTES = new Set([
  "rr_width",
  "rr_height",
  "rr_scrollleft",
  "rr_scrolltop",
  "rr_mediastate",
  "rr_mediacurrenttime",
  "rr_mediaplaybackrate",
  "rr_mediamuted",
  "rr_medialoop",
  "rr_mediavolume",
  "rr_open_mode",
]);

// Masking and addresses: pure, and tested on their own.

/** Page text: each non-space character becomes "*", so length and spacing stay. */
export function maskText(text: string): string {
  return text.replace(/\S/g, "*");
}

/** A typed value: every character becomes "*". */
export function maskValue(text: string): string {
  return "*".repeat(text.length);
}

/**
 * An address as the replay may keep it: an http(s) URL, absolute or
 * relative to `base`, as origin and path; data: and blob: addresses only
 * when `keepData`; undefined for anything else (javascript:, mailto:, …).
 */
export function cleanUrl(value: string, base: string, keepData = false): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  let url: URL;
  try {
    url = new URL(trimmed, base);
  } catch {
    return undefined;
  }
  if (url.protocol === "http:" || url.protocol === "https:") return url.origin + url.pathname;
  if (keepData && (url.protocol === "data:" || url.protocol === "blob:")) return trimmed;
  return undefined;
}

const DESCRIPTOR = /^\d+(?:\.\d+)?[wxh]$/i;

/** Every address in a srcset cleaned, with its width or density; undefined when none is left. */
export function cleanSrcset(value: string, base: string, keepData = false): string | undefined {
  const candidates: string[] = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /[\s,]/.test(value.charAt(i))) i += 1;
    if (i >= value.length) break;
    const start = i;
    while (i < value.length && !/\s/.test(value.charAt(i))) i += 1;
    let url = value.slice(start, i);
    let descriptors: string[] = [];
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
    } else {
      const end = value.indexOf(",", i);
      const stop = end === -1 ? value.length : end;
      descriptors = value.slice(i, stop).trim().split(/\s+/);
      i = stop + 1;
    }
    const clean = cleanUrl(url, base, keepData);
    if (clean !== undefined) {
      candidates.push([clean, ...descriptors.filter((d) => DESCRIPTOR.test(d))].join(" "));
    }
  }
  return candidates.length === 0 ? undefined : candidates.join(", ");
}

/** A CSS string, with its escapes: "…" or '…'. */
const QUOTED = String.raw`"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'`;
/** url(…), quoted or not; anything up to the closing parenthesis counts as the address. */
const CSS_URL = new RegExp(String.raw`url\(\s*(?:${QUOTED}|([^)"']*))\s*\)`, "gi");
/** @import "…": an address without url(). */
const CSS_IMPORT = new RegExp(String.raw`(@import\s+)(?:${QUOTED})`, "gi");
/** image-set(…): its candidates' addresses may be plain strings. */
const IMAGE_SET = /(image-set\()([^)]*)\)/gi;
const STRING = new RegExp(QUOTED, "g");

/**
 * Addresses in CSS cleaned: url(…), @import strings, and image-set()
 * strings; one that may not stay is emptied. Then, whatever the syntax, no
 * http(s) address keeps a query string or fragment.
 */
export function cleanCss(css: string, base: string, keepData = false): string {
  // An escape could hide a query string from the cleaning: drop the address.
  const clean = (value: string) =>
    value.includes("\\") ? undefined : cleanUrl(value, base, keepData);
  return css
    .replace(CSS_URL, (_match, double?: string, single?: string, bare?: string) => {
      const url = clean(double ?? single ?? bare ?? "");
      return url === undefined ? "url()" : `url("${url}")`;
    })
    .replace(CSS_IMPORT, (_match, start: string, double?: string, single?: string) => {
      return `${start}"${clean(double ?? single ?? "") ?? ""}"`;
    })
    .replace(IMAGE_SET, (_match, start: string, inside: string) => {
      const cleaned = inside.replace(STRING, (_string, double?: string, single?: string) => {
        return `"${clean(double ?? single ?? "") ?? ""}"`;
      });
      return `${start}${cleaned})`;
    })
    .replace(/(https?:\/\/[^\s?#"'()<>]*)[?#][^\s"'()<>]*/gi, "$1");
}

/** Query strings and fragments removed from http(s) addresses inside other text. */
export function stripQueries(text: string): string {
  return text.replace(/(https?:\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi, "$1");
}

// The filter.

export interface FilterOptions {
  /** data-replay-text="show". */
  showText: boolean;
  /** data-replay-media="show". */
  showMedia: boolean;
  /** The page's URL, for relative addresses. */
  base: string;
  /**
   * The flags of a recorded node as the live page has them now (markers on
   * it and above it), when the page is at hand: a marker added after the
   * node was recorded counts too. They add to the map's flags.
   */
  live?: (id: number) => number;
  /**
   * Keeps data-ottertrail-name, which heatmap keys start from: a saved
   * heatmap view (snapshot-take.ts) finds elements by it. Replays drop it.
   */
  keepNames?: boolean;
}

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value);
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** Only the named fields that hold a number, a boolean, or null. */
function primitives(data: Json, keys: string[]): Json {
  const out: Json = {};
  for (const key of keys) {
    const value = data[key];
    if (isNumber(value) || typeof value === "boolean" || value === null) out[key] = value;
  }
  return out;
}

/** The objects in a list, or none when it is not one. */
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : []);

/** An index into a stylesheet: a number, or a path of numbers into nested rules. */
const isIndex = (value: unknown): value is number | number[] =>
  isNumber(value) || (Array.isArray(value) && value.every(isNumber));

interface NodeInfo {
  parent: number | undefined;
  own: number;
  /** For elements: the tag name, lower case. */
  tag?: string;
}

export type ReplayFilter = (event: unknown) => Json | undefined;

export function createFilter({
  showText,
  showMedia,
  base,
  live,
  keepNames = false,
}: FilterOptions): ReplayFilter {
  /** Every node let through since the last full snapshot. */
  let nodes = new Map<number, NodeInfo>();

  /** A node's flags and all its ancestors'; MASK when the chain is broken. */
  const effective = (id: number): number => {
    let flags = live?.(id) ?? 0;
    let current: number | undefined = id;
    for (let depth = 0; current !== undefined; depth += 1) {
      const info = nodes.get(current);
      if (info === undefined || depth > 10_000) return flags | MASK;
      flags |= info.own;
      current = info.parent;
    }
    return flags;
  };

  const textShown = (flags: number) =>
    (flags & (BLOCK | MASK | TYPED | SCRIPT)) === 0 && (showText || (flags & UNMASK) !== 0);

  const cleanText = (text: string, flags: number): string => {
    if (flags & SCRIPT) return "";
    if (flags & STYLE) return cleanCss(text, base, true);
    return textShown(flags) ? text : maskText(text);
  };

  /** Text in an attribute: masked unless shown, and then without addresses' queries. */
  const attributeText = (value: string, flags: number) =>
    textShown(flags) ? stripQueries(value) : maskText(value);

  function cleanAttribute(
    tag: string,
    rawName: string,
    value: unknown,
    flags: number,
  ): string | number | boolean | undefined {
    const name = rawName.toLowerCase();
    if (typeof value === "boolean" || isNumber(value)) {
      // rrweb's own values (selected, checked, media state): no text in them.
      return name === "value" ? undefined : value;
    }
    if (typeof value !== "string") return undefined;
    if (keepNames && name === NAME_ATTRIBUTE) return NAME_PATTERN.test(value) ? value : undefined;
    if (name.startsWith("on") || name === "nonce" || name.startsWith("data-ottertrail-")) {
      return undefined;
    }
    if (name === "_csstext") return cleanCss(value, base, true);
    if (name.startsWith("rr_")) {
      return RRWEB_ATTRIBUTES.has(name) && /^[\w.%-]{0,40}$/.test(value) ? value : undefined;
    }
    if (name === "value") return maskValue(value);
    if (name === "style") return cleanCss(value, base, showMedia);
    if (ADDRESSES.has(name)) {
      const keepData = showMedia && MEDIA_SOURCES.has(tag);
      if (name === "srcset" || name === "imagesrcset") return cleanSrcset(value, base, keepData);
      if (name === "ping") {
        const urls = value.split(/\s+/).flatMap((url) => cleanUrl(url, base) ?? []);
        return urls.length === 0 ? undefined : urls.join(" ");
      }
      // An SVG <use href="#icon"> points into the page itself.
      if ((flags & SVG) !== 0 && /^#[A-Za-z_][\w:.-]*$/.test(value)) return value;
      return cleanUrl(value, base, keepData);
    }
    if (READ_TEXT.has(name) || (tag === "meta" && name === "content")) {
      return (flags & TYPED) !== 0 ? maskText(value) : attributeText(value, flags);
    }
    if (
      STRUCTURE.has(name) ||
      ((flags & SVG) !== 0 && !name.startsWith("data-") && !name.startsWith("aria-"))
    ) {
      return value;
    }
    return attributeText(value, flags);
  }

  function cleanAttributes(tag: string, attributes: unknown, flags: number): Json {
    const out: Json = {};
    if (!isRecord(attributes)) return out;
    for (const [name, value] of Object.entries(attributes)) {
      const clean = cleanAttribute(tag, name, value, flags);
      if (clean !== undefined) out[name] = clean;
    }
    return out;
  }

  /** An element's own flags, from its tag and markers. */
  function ownFlags(tag: string, attributes: Json, isSvg: boolean): number {
    const has = (name: string) => typeof attributes[name] === "string";
    let flags = 0;
    if (
      ALWAYS_BLOCKED.includes(tag) ||
      (!showMedia &&
        (MEDIA.includes(tag) ||
          (tag === "input" && str(attributes.type).toLowerCase() === "image"))) ||
      has(BLOCK_ATTRIBUTE)
    ) {
      flags |= BLOCK;
    }
    if (has(MASK_ATTRIBUTE)) flags |= MASK;
    if (has(UNMASK_ATTRIBUTE)) flags |= UNMASK;
    if (TYPED_TAGS.has(tag) || (has("contenteditable") && attributes.contenteditable !== "false")) {
      flags |= TYPED;
    }
    if (tag === "style") flags |= STYLE;
    if (tag === "script") flags |= SCRIPT;
    if (isSvg) flags |= SVG;
    return flags;
  }

  /**
   * A serialized node and its children, cleaned, under a parent with
   * `inherited` flags; each node is added to the map. Undefined drops it.
   */
  function cleanNode(
    node: unknown,
    parent: number | undefined,
    inherited: number,
  ): Json | undefined {
    if (!isRecord(node) || !isId(node.id)) return undefined;
    const { id, type } = node;
    const root = isId(node.rootId) ? { rootId: node.rootId } : {};
    const children = (flags: number) =>
      (Array.isArray(node.childNodes) ? node.childNodes : []).flatMap(
        (child) => cleanNode(child, id, flags) ?? [],
      );
    switch (type) {
      case DOCUMENT: {
        nodes.set(id, { parent, own: 0 });
        const compat = typeof node.compatMode === "string" ? { compatMode: node.compatMode } : {};
        return { type, id, childNodes: children(inherited), ...compat, ...root };
      }
      case DOCUMENT_TYPE:
        nodes.set(id, { parent, own: 0 });
        return {
          type,
          id,
          name: str(node.name),
          publicId: str(node.publicId),
          systemId: str(node.systemId),
          ...root,
        };
      case ELEMENT: {
        if (typeof node.tagName !== "string" || !/^[A-Za-z][\w:.-]*$/.test(node.tagName)) {
          return undefined;
        }
        const tag = node.tagName.toLowerCase();
        const attributes = isRecord(node.attributes) ? node.attributes : {};
        const isSvg = node.isSVG === true;
        const own = ownFlags(tag, attributes, isSvg);
        nodes.set(id, { parent, own, tag });
        const flags = inherited | own;
        const svg = isSvg ? { isSVG: true } : {};
        if (flags & BLOCK) {
          // A box of the element's size, and nothing from inside it.
          const size: Json = {};
          for (const name of ["rr_width", "rr_height"]) {
            const value = attributes[name];
            if (typeof value === "string" && /^\d+(?:\.\d+)?px$/.test(value)) size[name] = value;
          }
          return {
            type,
            id,
            tagName: node.tagName,
            attributes: size,
            childNodes: [],
            ...svg,
            ...root,
          };
        }
        return {
          type,
          id,
          tagName: node.tagName,
          attributes: cleanAttributes(tag, attributes, flags),
          childNodes: children(flags),
          ...svg,
          ...(node.isCustom === true ? { isCustom: true } : {}),
          ...root,
        };
      }
      case TEXT: {
        nodes.set(id, { parent, own: 0 });
        const textContent = cleanText(str(node.textContent), inherited);
        return { type, id, textContent, ...(inherited & STYLE ? { isStyle: true } : {}), ...root };
      }
      case CDATA:
      case COMMENT:
        nodes.set(id, { parent, own: 0 });
        return { type, id, textContent: "", ...root };
      default:
        return undefined;
    }
  }

  /** CSS values of a style attribute change, given as a diff of properties. */
  function cleanStyleDiff(diff: Json): Json {
    const out: Json = {};
    for (const [property, value] of Object.entries(diff)) {
      if (!/^-{0,2}[\w-]+$/.test(property)) continue;
      if (typeof value === "string") out[property] = cleanCss(value, base, showMedia);
      else if (value === false) out[property] = false;
      else if (Array.isArray(value) && typeof value[0] === "string") {
        out[property] = [cleanCss(value[0], base, showMedia), str(value[1])];
      }
    }
    return out;
  }

  function mutation(data: Json): Json | undefined {
    if (data.isAttachIframe === true) return undefined; // Frames are always blocked.
    const changes = list(data.attributes);

    // Markers first: they decide how the rest of this change is cleaned. A
    // block or mask, once seen, stays (fail closed); losing an unmask is stricter.
    for (const change of changes) {
      const info = isId(change.id) ? nodes.get(change.id) : undefined;
      if (info === undefined || !isRecord(change.attributes)) continue;
      const attributes = change.attributes;
      const set = (name: string) => typeof attributes[name] === "string";
      if (set(BLOCK_ATTRIBUTE)) info.own |= BLOCK;
      if (set(MASK_ATTRIBUTE)) info.own |= MASK;
      if (set(UNMASK_ATTRIBUTE)) info.own |= UNMASK;
      if (attributes[UNMASK_ATTRIBUTE] === null) info.own &= ~UNMASK;
      if (set("contenteditable") && attributes.contenteditable !== "false") info.own |= TYPED;
    }

    const removes = list(data.removes).flatMap((remove) =>
      isId(remove.parentId) && isId(remove.id)
        ? [
            {
              parentId: remove.parentId,
              id: remove.id,
              ...(remove.isShadow === true ? { isShadow: true } : {}),
            },
          ]
        : [],
    );

    // rrweb lists a parent before the nodes added into it.
    const adds = list(data.adds).flatMap((add) => {
      if (!isId(add.parentId) || !nodes.has(add.parentId)) return [];
      const flags = effective(add.parentId);
      if (flags & BLOCK) return [];
      const node = cleanNode(add.node, add.parentId, flags);
      if (node === undefined) return [];
      const sibling = (value: unknown) => (isId(value) ? value : null);
      return [
        {
          parentId: add.parentId,
          nextId: sibling(add.nextId),
          ...("previousId" in add ? { previousId: sibling(add.previousId) } : {}),
          node,
        },
      ];
    });

    const texts = list(data.texts).flatMap((text) => {
      if (!isId(text.id) || !nodes.has(text.id)) return [];
      const flags = effective(text.id);
      if (flags & BLOCK) return [];
      const value = typeof text.value === "string" ? cleanText(text.value, flags) : null;
      return [{ id: text.id, value }];
    });

    const attributes = changes.flatMap((change) => {
      const info = isId(change.id) ? nodes.get(change.id) : undefined;
      if (!isId(change.id) || info?.tag === undefined || !isRecord(change.attributes)) return [];
      const flags = effective(change.id);
      if (flags & BLOCK) return [];
      const out: Json = {};
      for (const [name, value] of Object.entries(change.attributes)) {
        if (keepNames && name.toLowerCase() === NAME_ATTRIBUTE) {
          out[name] = typeof value === "string" && NAME_PATTERN.test(value) ? value : null;
        } else if (name.toLowerCase().startsWith("data-ottertrail-")) {
          // Markers are read above; the player has no use for them.
        } else if (value === null) {
          out[name] = null;
        } else if (name.toLowerCase() === "style" && isRecord(value)) {
          out[name] = cleanStyleDiff(value);
        } else {
          const clean = cleanAttribute(info.tag, name, value, flags);
          // An attribute whose new value may not be kept is removed instead.
          out[name] = clean === undefined ? null : clean;
        }
      }
      return [{ id: change.id, attributes: out }];
    });

    if (removes.length + adds.length + texts.length + attributes.length === 0) return undefined;
    return { source: MUTATION, texts, attributes, removes, adds };
  }

  const rule = (value: unknown) =>
    isRecord(value) && typeof value.rule === "string" && isIndex(value.index)
      ? [{ rule: cleanCss(value.rule, base, true), index: value.index }]
      : [];

  function incremental(data: Json): Json | undefined {
    const { source } = data;
    switch (source) {
      case MUTATION:
        return mutation(data);
      case MOUSE_MOVE:
      case TOUCH_MOVE:
      case DRAG: {
        if (!Array.isArray(data.positions)) return undefined;
        const positions = data.positions
          .filter(isRecord)
          .map((position) => primitives(position, ["x", "y", "id", "timeOffset"]));
        return { source, positions };
      }
      case MOUSE_INTERACTION:
        return { source, ...primitives(data, ["type", "id", "x", "y", "pointerType"]) };
      case SCROLL:
        return { source, ...primitives(data, ["id", "x", "y"]) };
      case VIEWPORT_RESIZE:
        return { source, ...primitives(data, ["width", "height"]) };
      case INPUT: {
        if (!isId(data.id) || !nodes.has(data.id) || effective(data.id) & BLOCK) return undefined;
        return {
          source,
          ...primitives(data, ["id", "isChecked", "userTriggered"]),
          text: maskValue(str(data.text)),
        };
      }
      case MEDIA_INTERACTION:
        return {
          source,
          ...primitives(data, [
            "type",
            "id",
            "currentTime",
            "volume",
            "muted",
            "loop",
            "playbackRate",
          ]),
        };
      case STYLE_SHEET_RULE: {
        const out: Json = { source, ...primitives(data, ["id", "styleId"]) };
        if (Array.isArray(data.adds)) out.adds = data.adds.flatMap(rule);
        if (Array.isArray(data.removes)) {
          out.removes = data.removes.flatMap((remove) =>
            isRecord(remove) && isIndex(remove.index) ? [{ index: remove.index }] : [],
          );
        }
        for (const key of ["replace", "replaceSync"]) {
          const value = data[key];
          if (typeof value === "string") out[key] = cleanCss(value, base, true);
        }
        return out;
      }
      case STYLE_DECLARATION: {
        if (!isIndex(data.index)) return undefined;
        const out: Json = { source, ...primitives(data, ["id", "styleId"]), index: data.index };
        const { set, remove } = data;
        if (isRecord(set) && typeof set.property === "string") {
          out.set = {
            property: set.property,
            value: typeof set.value === "string" ? cleanCss(set.value, base, true) : null,
            ...(typeof set.priority === "string" ? { priority: set.priority } : {}),
          };
        }
        if (isRecord(remove) && typeof remove.property === "string") {
          out.remove = { property: remove.property };
        }
        return out;
      }
      case SELECTION: {
        if (!Array.isArray(data.ranges)) return undefined;
        const ranges = data.ranges
          .filter(isRecord)
          .map((range) => primitives(range, ["start", "startOffset", "end", "endOffset"]));
        return { source, ranges };
      }
      case ADOPTED_STYLE_SHEET: {
        if (!isId(data.id) || !Array.isArray(data.styleIds)) return undefined;
        const out: Json = { source, id: data.id, styleIds: data.styleIds.filter(isId) };
        if (Array.isArray(data.styles)) {
          out.styles = data.styles.flatMap((style) =>
            isRecord(style) && isId(style.styleId) && Array.isArray(style.rules)
              ? [{ styleId: style.styleId, rules: style.rules.flatMap(rule) }]
              : [],
          );
        }
        return out;
      }
      case CUSTOM_ELEMENT: {
        const name = isRecord(data.define) ? str(data.define.name) : "";
        return /^[a-z][a-z0-9._]*-[a-z0-9._-]*$/.test(name)
          ? { source, define: { name } }
          : undefined;
      }
      default:
        // Canvas drawing, fonts, console output, and anything unknown.
        return undefined;
    }
  }

  return (event) => {
    if (!isRecord(event) || !isNumber(event.timestamp)) return undefined;
    const { type, timestamp } = event;
    const data = isRecord(event.data) ? event.data : undefined;
    if (typeof type !== "number" || data === undefined) return undefined;
    let out: Json | undefined;
    if (LOAD_EVENTS.has(type)) {
      out = {};
    } else if (type === META) {
      out = {
        href: cleanUrl(str(data.href), base) ?? "",
        ...primitives(data, ["width", "height"]),
      };
    } else if (type === FULL_SNAPSHOT) {
      // The whole page again: the map starts over from it.
      nodes = new Map();
      const node = cleanNode(data.node, undefined, 0);
      const offset = isRecord(data.initialOffset) ? data.initialOffset : {};
      out = node && { node, initialOffset: primitives(offset, ["top", "left"]) };
    } else if (type === INCREMENTAL) {
      out = incremental(data);
    } else if (type === CUSTOM) {
      out = data.tag === ERROR_TAG ? { tag: ERROR_TAG, payload: {} } : undefined;
    }
    return out && { type, data: out, timestamp };
  };
}
