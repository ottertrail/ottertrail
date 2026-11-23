import { createHash } from "node:crypto";

import type { QueryParams } from "../clickhouse/query.ts";
import { PRICE_TABLE } from "./price-table.ts";

/**
 * Bundled prices are estimates in US dollars per million tokens, checked against provider pages
 * each release (docs/ai-usage.md, "Cost"). Excludes batch, flex, priority, regional, and
 * negotiated rates. Admins can override prices (custom-prices.ts).
 *
 * Compute costs on read so corrections apply to past calls. priceSlotAt tries, in order: exact
 * custom model price; custom price on a matching bundled entry's IDs; bundled price; one level of
 * `price as`; no price. Custom prices use the latest start at or before the call. Bundled entries
 * match exact IDs before longest prefixes, regardless of provider. Unpriced calls still count
 * tokens and appear as "no price".
 *
 * toLowerCase and ClickHouse lowerUTF8 differ for language-dependent or length-changing case
 * mappings, such as İ and ẞ.
 */

export type PriceProvider = "openai" | "anthropic" | "google" | "mistral" | "aws.bedrock";

export interface ModelPrice {
  provider: PriceProvider;
  label: string;
  /** Exact lowercase aliases. */
  ids: readonly string[];
  /** Lowercase prefixes for dated snapshots or cloud regions. */
  prefixes?: readonly string[];
  /** US dollars per million input tokens, excluding cache reads and writes. */
  input: number;
  output: number;
  /** Per million cache reads; null charges the input rate. */
  cacheRead: number | null;
  /**
   * Per million cache writes; null charges the input rate. Uses Anthropic's 5-minute rate because
   * spans omit cache duration.
   */
  cacheWrite: number | null;
  /** Reference only; costs use cacheWrite's 5-minute rate. */
  cacheWrite1h?: number;
  /** Omitted pricing conditions, such as prompt-length tiers. */
  notes?: string;
  source: string;
  /** Source check date, YYYY-MM-DD. */
  checked: string;
}

export const PRICES: readonly ModelPrice[] = PRICE_TABLE;

/** US dollars per million tokens; null cache rates use the input rate. */
export type Rates = Pick<ModelPrice, "input" | "output" | "cacheRead" | "cacheWrite">;

/** Exact IDs before longest prefixes; -1 without a match. */
function matchIndex(prices: readonly ModelPrice[], model: string): number {
  const id = model.toLowerCase();
  const exact = prices.findIndex((entry) => entry.ids.includes(id));
  if (exact !== -1) return exact;
  let found = -1;
  let length = 0;
  for (const [index, entry] of prices.entries()) {
    for (const prefix of entry.prefixes ?? []) {
      if (prefix.length > length && id.startsWith(prefix)) {
        found = index;
        length = prefix.length;
      }
    }
  }
  return found;
}

/** Exact IDs before longest prefixes; null without a match. */
export function priceOf(model: string, prices: readonly ModelPrice[] = PRICES): ModelPrice | null {
  return prices[matchIndex(prices, model)] ?? null;
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /**
   * Defaults to inclusive counts unless input is smaller than cached tokens (ai/calls.ts,
   * inputIncludesCache).
   */
  inputIncludesCache?: boolean;
  /** Output includes reasoning by default. */
  reasoning?: number;
  outputIncludesReasoning?: boolean;
}

/**
 * Charges cache reads/writes separately and subtracts them from inclusive input. Input smaller
 * than cached tokens is treated as exclusive. Adds reasoning to output when needed. Returns US
 * dollars; pricedColumns uses the same rules in SQL.
 */
export function costOf(price: Rates, tokens: TokenCounts): number {
  const cached = tokens.cacheRead + tokens.cacheWrite;
  const includes = (tokens.inputIncludesCache ?? true) && tokens.input >= cached;
  const base = includes ? tokens.input - cached : tokens.input;
  return (
    (base * price.input +
      tokens.cacheRead * (price.cacheRead ?? price.input) +
      tokens.cacheWrite * (price.cacheWrite ?? price.input) +
      (tokens.output + (tokens.outputIncludesReasoning === false ? (tokens.reasoning ?? 0) : 0)) *
        price.output) /
    1_000_000
  );
}

/** Instance price from ai_model_prices (custom-prices.ts). */
export interface CustomPrice {
  /** Lowercase. */
  provider: string;
  /** Exact lowercase match. */
  model: string;
  /** Null applies to all calls. */
  effectiveFrom: Date | null;
  rates: Rates | null;
  /** Model to price as; null when rates are supplied. */
  priceAs: { provider: string; model: string } | null;
}

/**
 * Slots start at 1 for bundled prices, then custom rate rows; 0 means no price. Custom models
 * carry timelines of price-change times and slots, including changes to the model they are priced
 * as. Queries resolve prices with a count over that timeline.
 */
export interface PriceBook {
  readonly bundled: readonly ModelPrice[];
  readonly custom: readonly CustomPrice[];
  /** Invalidates an AI cost rule's saved hours when prices change. */
  readonly fingerprint: string;
  readonly arrays: PriceArrays;
  readonly lookup: Lookup;
}

interface PriceArrays {
  ids: string[];
  idEntries: number[];
  prefixes: string[];
  prefixEntries: number[];
  input: number[];
  output: number[];
  cacheRead: number[];
  cacheWrite: number[];
  /** Custom model timelines use ascending milliseconds and matching slots. */
  customModels: string[];
  customFroms: number[][];
  customSlots: number[][];
  /** Bundled entries numbered from 1, with timelines for custom prices on their IDs. */
  entryNumbers: number[];
  entryFroms: number[][];
  entrySlots: number[][];
}

interface Lookup {
  byModel: ReadonlyMap<string, readonly { row: CustomPrice; slot: number }[]>;
  byEntry: ReadonlyMap<number, readonly { row: CustomPrice; slot: number }[]>;
  priceAs: ReadonlyMap<string, CustomPrice>;
}

/** Starts all-call timelines before any call timestamp. */
const ALWAYS = -1e15;

const fromMs = (row: CustomPrice) => row.effectiveFrom?.getTime() ?? ALWAYS;

export type PriceSource = "custom" | "built_in" | "price_as";

function latest(rows: readonly { row: CustomPrice; slot: number }[] | undefined, atMs: number) {
  let found: { slot: number; from: number; row: CustomPrice } | null = null;
  for (const { row, slot } of rows ?? []) {
    const from = fromMs(row);
    if (from <= atMs && (found === null || from > found.from)) found = { slot, from, row };
  }
  return found;
}

/** Resolves precedence documented above. Slot 0 means no price. */
function priceSlotAt(
  bundled: readonly ModelPrice[],
  lookup: Lookup,
  model: string,
  atMs: number,
): { slot: number; source: PriceSource | null; row: CustomPrice | null } {
  const direct = (id: string) => {
    const own = latest(lookup.byModel.get(id), atMs);
    if (own !== null) return { slot: own.slot, row: own.row, custom: true };
    const index = matchIndex(bundled, id);
    if (index === -1) return null;
    const entry = latest(lookup.byEntry.get(index), atMs);
    if (entry !== null) return { slot: entry.slot, row: entry.row, custom: true };
    return { slot: index + 1, row: null, custom: false };
  };
  const id = model.toLowerCase();
  const found = direct(id);
  if (found !== null) {
    return { slot: found.slot, row: found.row, source: found.custom ? "custom" : "built_in" };
  }
  const target = lookup.priceAs.get(id)?.priceAs?.model;
  const as = target === undefined ? null : direct(target);
  if (as === null) return { slot: 0, source: null, row: null };
  return { slot: as.slot, row: as.row, source: "price_as" };
}

const hashOf = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function priceBookOf(
  custom: readonly CustomPrice[],
  bundled: readonly ModelPrice[] = PRICES,
): PriceBook {
  const arrays: PriceArrays = {
    ids: [],
    idEntries: [],
    prefixes: [],
    prefixEntries: [],
    input: [],
    output: [],
    cacheRead: [],
    cacheWrite: [],
    customModels: [],
    customFroms: [],
    customSlots: [],
    entryNumbers: [],
    entryFroms: [],
    entrySlots: [],
  };
  const addRates = (rates: Rates) => {
    arrays.input.push(rates.input);
    arrays.output.push(rates.output);
    arrays.cacheRead.push(rates.cacheRead ?? rates.input);
    arrays.cacheWrite.push(rates.cacheWrite ?? rates.input);
  };
  const prefixes: [string, number][] = [];
  for (const [index, entry] of bundled.entries()) {
    const number = index + 1;
    for (const id of entry.ids) {
      arrays.ids.push(id);
      arrays.idEntries.push(number);
    }
    for (const prefix of entry.prefixes ?? []) prefixes.push([prefix, number]);
    addRates(entry);
  }
  for (const [prefix, number] of prefixes.toSorted((a, b) => b[0].length - a[0].length)) {
    arrays.prefixes.push(prefix);
    arrays.prefixEntries.push(number);
  }

  const byModel = new Map<string, { row: CustomPrice; slot: number }[]>();
  const byEntry = new Map<number, { row: CustomPrice; slot: number }[]>();
  const priceAs = new Map<string, CustomPrice>();
  /** Each exact alias belongs to one bundled entry. */
  const entryOfId = new Map<string, number>();
  for (const [index, entry] of bundled.entries()) {
    for (const id of entry.ids) if (!entryOfId.has(id)) entryOfId.set(id, index);
  }
  const push = <K>(
    map: Map<K, { row: CustomPrice; slot: number }[]>,
    key: K,
    item: { row: CustomPrice; slot: number },
  ) => {
    const list = map.get(key);
    if (list === undefined) map.set(key, [item]);
    else list.push(item);
  };
  for (const row of custom) {
    if (row.rates !== null) {
      addRates(row.rates);
      const item = { row, slot: arrays.input.length };
      push(byModel, row.model, item);
      const entry = entryOfId.get(row.model);
      if (entry !== undefined) push(byEntry, entry, item);
    } else if (row.priceAs !== null) {
      priceAs.set(row.model, row);
    }
  }
  const lookup: Lookup = { byModel, byEntry, priceAs };
  const momentsOf = (id: string, into: Set<number>) => {
    for (const { row } of byModel.get(id) ?? []) into.add(fromMs(row));
    const index = matchIndex(bundled, id);
    for (const { row } of byEntry.get(index) ?? []) into.add(fromMs(row));
  };
  const timeline = (model: string, moments: Set<number>) => {
    const froms: number[] = [];
    const slots: number[] = [];
    for (const moment of [...moments].toSorted((a, b) => a - b)) {
      const { slot } = priceSlotAt(bundled, lookup, model, moment);
      if (slots.at(-1) === slot) continue;
      froms.push(moment);
      slots.push(slot);
    }
    return { froms, slots };
  };
  for (const model of [...new Set(custom.map((row) => row.model))].toSorted()) {
    const moments = new Set([ALWAYS]);
    momentsOf(model, moments);
    const target = priceAs.get(model)?.priceAs?.model;
    if (target !== undefined) momentsOf(target, moments);
    const { froms, slots } = timeline(model, moments);
    arrays.customModels.push(model);
    arrays.customFroms.push(froms);
    arrays.customSlots.push(slots);
  }
  for (const [index, rows] of [...byEntry.entries()].toSorted((a, b) => a[0] - b[0])) {
    const moments = new Set([ALWAYS]);
    for (const { row } of rows) moments.add(fromMs(row));
    const entry = bundled[index];
    const id = entry?.ids[0];
    if (id === undefined) continue;
    // Ignore first-ID-specific prices here; this timeline also prices dated IDs without their own
    // rows.
    const entryLookup: Lookup = { ...lookup, byModel: new Map(), priceAs: new Map() };
    const froms: number[] = [];
    const slots: number[] = [];
    for (const moment of [...moments].toSorted((a, b) => a - b)) {
      const { slot } = priceSlotAt(bundled, entryLookup, id, moment);
      if (slots.at(-1) === slot) continue;
      froms.push(moment);
      slots.push(slot);
    }
    arrays.entryNumbers.push(index + 1);
    arrays.entryFroms.push(froms);
    arrays.entrySlots.push(slots);
  }
  return {
    bundled,
    custom,
    // Hash pricing behavior; exclude audit metadata.
    fingerprint: hashOf([
      bundled === PRICES ? BUNDLED_HASH : hashOf(bundled),
      custom.map((row) => [
        row.model,
        row.effectiveFrom?.getTime() ?? null,
        row.rates,
        row.priceAs,
      ]),
    ]),
    arrays,
    lookup,
  };
}

const BUNDLED_HASH = hashOf(PRICES);

export const BUNDLED_BOOK: PriceBook = priceBookOf([]);

/** Matches pricedColumns in JavaScript; null without a price. */
export function priceAt(
  book: PriceBook,
  model: string,
  at: Date,
): { rates: Rates; source: PriceSource; row: CustomPrice | null } | null {
  const { slot, source, row } = priceSlotAt(book.bundled, book.lookup, model, at.getTime());
  if (slot === 0 || source === null) return null;
  const rates = row?.rates ?? book.bundled[slot - 1];
  return rates === undefined ? null : { rates, source, row };
}

const timelineAt = (froms: string, slots: string) =>
  `${slots}[arrayCount(moment -> moment <= toUnixTimestamp64Milli(timestamp), ${froms})]`;

/**
 * Adds price slot, estimated USD cost (0 unpriced), priced status, and inclusive input/output
 * counts. Prices are parameters, never SQL text. Each call resolves its bundled match and custom
 * timeline, then counts timeline starts at or before its time.
 */
export function pricedColumns(params: QueryParams, book: PriceBook = BUNDLED_BOOK): string {
  const { arrays } = book;
  const ids = params.add(arrays.ids, "Array(String)");
  const prefixes = params.add(arrays.prefixes, "Array(String)");
  const model = "lowerUTF8(model)";
  const bundled = `if(has(${ids}, ${model}),
      ${params.add(arrays.idEntries, "Array(UInt32)")}[indexOf(${ids}, ${model})],
      ${params.add(arrays.prefixEntries, "Array(UInt32)")}[arrayFirstIndex(prefix -> startsWith(${model}, prefix), ${prefixes})])`;
  let entry = bundled;
  if (arrays.entryNumbers.length > 0) {
    // ClickHouse computes the repeated bundled match once.
    const entries = params.add(arrays.entryNumbers, "Array(UInt32)");
    const found = `indexOf(${entries}, ${bundled})`;
    entry = `if(${found} > 0,
      ${timelineAt(
        `${params.add(arrays.entryFroms, "Array(Array(Int64))")}[${found}]`,
        `${params.add(arrays.entrySlots, "Array(Array(UInt32))")}[${found}]`,
      )},
      ${bundled})`;
  }
  if (arrays.customModels.length > 0) {
    const models = params.add(arrays.customModels, "Array(String)");
    const custom = `indexOf(${models}, ${model})`;
    const froms = `${params.add(arrays.customFroms, "Array(Array(Int64))")}[${custom}]`;
    const slots = `${params.add(arrays.customSlots, "Array(Array(UInt32))")}[${custom}]`;
    entry = `if(${custom} > 0, ${timelineAt(froms, slots)}, ${entry})`;
  }
  // ClickHouse index 0 returns 0, representing no price.
  const at = (values: number[]) => `${params.add(values, "Array(Float64)")}[price_entry]`;
  // Subtract cached tokens only from inclusive input; keep the unsigned result nonnegative
  // (costOf).
  const base = `if(input_includes_cache AND input_tokens >= cache_read_tokens + cache_write_tokens,
    input_tokens - cache_read_tokens - cache_write_tokens, input_tokens)`;
  return `${entry} AS price_entry,
    (${base} * ${at(arrays.input)}
      + cache_read_tokens * ${at(arrays.cacheRead)}
      + cache_write_tokens * ${at(arrays.cacheWrite)}
      + (output_tokens + if(output_includes_reasoning, 0, reasoning_tokens)) * ${at(arrays.output)})
      / 1000000 AS cost,
    price_entry > 0 AS priced,
    if(input_includes_cache, input_tokens,
      input_tokens + cache_read_tokens + cache_write_tokens) AS all_input_tokens,
    output_tokens + if(output_includes_reasoning, 0, reasoning_tokens) AS all_output_tokens`;
}
