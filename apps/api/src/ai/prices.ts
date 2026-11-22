import { createHash } from "node:crypto";

import type { QueryParams } from "../clickhouse/query.ts";
import { PRICE_TABLE } from "./price-table.ts";

/**
 * What models cost (docs/ai-usage.md, "Cost"): a small table kept by hand,
 * from each provider's own price page, checked again for each release.
 * Every entry names its source and the day its prices were read there.
 * Prices are the standard, pay-as-you-go ones, in US dollars per million
 * tokens: no batch, flex, priority, or regional prices, no negotiated
 * discounts. So every cost the API answers is an estimate.
 *
 * The owner and admins set the instance's own prices over it (Settings →
 * AI models; custom-prices.ts): a price from a moment on or for all calls,
 * or another model's price for one the table lacks (`price as`).
 *
 * Cost is worked out when calls are read, never stored (pricedColumns):
 * a corrected price applies to past calls too. A call's price is, in
 * order (priceSlotAt):
 *
 * 1. the instance's price for its model ID (exactly, in lower case) with
 *    the latest start at or before the call's time;
 * 2. else, when the model matches a bundled entry (exactly, then by the
 *    longest prefix: dated snapshots and region prefixes), the instance's
 *    price on any of that entry's IDs, the latest start at or before the
 *    call's time: a price on gpt-4o covers gpt-4o-2024-08-06 too;
 * 3. else that entry's bundled price, whatever provider sent the call;
 * 4. else, when the model is priced as another, that model's price at the
 *    call's time, by 1 to 3 (one level: its own `price as` is not followed);
 * 5. else none: its tokens count, its cost does not, and reports count
 *    its calls as "no price".
 *
 * Model IDs are lower-cased with toLowerCase here and lowerUTF8 in
 * ClickHouse: the same for ASCII and most letters, not for the few whose
 * case mapping depends on the language or changes the length (İ, ẞ).
 */

export type PriceProvider = "openai" | "anthropic" | "google" | "mistral" | "aws.bedrock";

export interface ModelPrice {
  provider: PriceProvider;
  /** The provider's name for the model. */
  label: string;
  /** Model IDs and documented aliases, exactly, in lower case. */
  ids: readonly string[];
  /** ID prefixes, in lower case: dated snapshots priced the same, or a cloud's region prefixes. */
  prefixes?: readonly string[];
  /** US dollars per million input tokens: those neither read from nor written to a cache. */
  input: number;
  output: number;
  /** Per million cached input tokens read; null: the provider has no separate price (charged as input). */
  cacheRead: number | null;
  /**
   * Per million input tokens written to a cache; null: no separate price
   * (charged as input). For Anthropic, the 5-minute cache's: spans do not
   * say which was used.
   */
  cacheWrite: number | null;
  /** Anthropic's 1-hour cache write, for reference: costs use cacheWrite. */
  cacheWrite1h?: number;
  /** What the table leaves out, such as a higher price past a prompt length. */
  notes?: string;
  /** The page the prices were read from. */
  source: string;
  /** The day they were read there, "YYYY-MM-DD". */
  checked: string;
}

/** The bundled table (price-table.ts). */
export const PRICES: readonly ModelPrice[] = PRICE_TABLE;

/** What a model costs, in US dollars per million tokens; a null cache price is charged as input. */
export type Rates = Pick<ModelPrice, "input" | "output" | "cacheRead" | "cacheWrite">;

/** The index of the entry a model ID matches in `prices`, or -1: exactly first, then the longest prefix. */
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

/** The bundled entry a model ID matches, or null: exactly first, then the longest prefix. */
export function priceOf(model: string, prices: readonly ModelPrice[] = PRICES): ModelPrice | null {
  return prices[matchIndex(prices, model)] ?? null;
}

/** Tokens of each kind a call or a sum of calls has. */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /**
   * Whether `input` holds the cached tokens too (the ai_calls column,
   * ai/calls.ts, inputIncludesCache); when left out, it does unless it is
   * smaller than them.
   */
  inputIncludesCache?: boolean;
}

/**
 * The estimated cost of one call's tokens at a price, in US dollars:
 * cache reads and writes at their own prices, the rest of the input at the
 * input price, and the output (reasoning included) at the output price.
 * The rest is the input less both when the input holds them (the GenAI
 * conventions, OpenAI's API), else all of the input (Anthropic's API):
 * each call says which (inputIncludesCache). An input smaller than its
 * cached tokens never holds them. pricedColumns works out the same in SQL.
 */
export function costOf(price: Rates, tokens: TokenCounts): number {
  const cached = tokens.cacheRead + tokens.cacheWrite;
  const includes = (tokens.inputIncludesCache ?? true) && tokens.input >= cached;
  const base = includes ? tokens.input - cached : tokens.input;
  return (
    (base * price.input +
      tokens.cacheRead * (price.cacheRead ?? price.input) +
      tokens.cacheWrite * (price.cacheWrite ?? price.input) +
      tokens.output * price.output) /
    1_000_000
  );
}

/** One of the instance's own prices (the ai_model_prices table, custom-prices.ts). */
export interface CustomPrice {
  /** In lower case. */
  provider: string;
  /** In lower case: matched exactly. */
  model: string;
  /** From when it prices the model's calls; null: all of them. */
  effectiveFrom: Date | null;
  /** null for a `price as` row. */
  rates: Rates | null;
  /** The model whose price this one takes, for all calls; null for a row with prices. */
  priceAs: { provider: string; model: string } | null;
}

/**
 * The prices a query uses: the bundled table and the instance's own,
 * with the parameters ClickHouse reads them from, built once.
 *
 * Every price is a numbered slot: the bundled entries from 1, then each
 * custom row with prices; 0 is "no price", what ClickHouse answers for
 * index 0. A model with custom rows has a timeline: the moments its price
 * may change (its rows' starts, and those of the model it is priced as),
 * each with the slot that applies from it (priceSlotAt), so a call's
 * price is one count over a short array.
 */
export interface PriceBook {
  readonly bundled: readonly ModelPrice[];
  readonly custom: readonly CustomPrice[];
  /** Changes whenever any price does: what an AI cost rule's kept hours were added up with. */
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
  /** The models with custom rows, and each one's timeline: moments (ms) ascending, and slots. */
  customModels: string[];
  customFroms: number[][];
  customSlots: number[][];
  /** The bundled entries (numbered from 1) with custom rows on their IDs, and each one's timeline. */
  entryNumbers: number[];
  entryFroms: number[][];
  entrySlots: number[][];
}

/** The custom rows by what they price, for priceSlotAt. */
interface Lookup {
  /** Rows with prices, by model, each with its slot. */
  byModel: ReadonlyMap<string, readonly { row: CustomPrice; slot: number }[]>;
  /** Rows with prices on a bundled entry's IDs, by its index in the table. */
  byEntry: ReadonlyMap<number, readonly { row: CustomPrice; slot: number }[]>;
  priceAs: ReadonlyMap<string, CustomPrice>;
}

/** Before any call: the start of a timeline, for rows of all calls. */
const ALWAYS = -1e15;

const fromMs = (row: CustomPrice) => row.effectiveFrom?.getTime() ?? ALWAYS;

/** Where a call's price comes from. */
export type PriceSource = "custom" | "built_in" | "price_as";

/** The slot of the latest of `rows` that starts at or before `atMs`, or null. */
function latest(rows: readonly { row: CustomPrice; slot: number }[] | undefined, atMs: number) {
  let found: { slot: number; from: number; row: CustomPrice } | null = null;
  for (const { row, slot } of rows ?? []) {
    const from = fromMs(row);
    if (from <= atMs && (found === null || from > found.from)) found = { slot, from, row };
  }
  return found;
}

/**
 * The slot that prices a call of `model` at `atMs` (0: none), where it
 * comes from, and the custom row it is, if one: the order in the header.
 */
function priceSlotAt(
  bundled: readonly ModelPrice[],
  lookup: Lookup,
  model: string,
  atMs: number,
): { slot: number; source: PriceSource | null; row: CustomPrice | null } {
  /** The price of `id` by its own rows, its entry's rows, then its entry. */
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

/** The prices of the bundled table and the instance's custom rows, ready for queries. */
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
  /** Each bundled ID's entry index: an exact ID belongs to one entry. */
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
  /** The moments a price by `direct` (own rows, the entry's rows) of `id` may change. */
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
  // A model with rows of its own (prices, or price as): its own timeline.
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
  // Every other call of an entry with rows: the entry's timeline, by its first ID's.
  for (const [index, rows] of [...byEntry.entries()].toSorted((a, b) => a[0] - b[0])) {
    const moments = new Set([ALWAYS]);
    for (const { row } of rows) moments.add(fromMs(row));
    const entry = bundled[index];
    const id = entry?.ids[0];
    if (id === undefined) continue;
    // Its first ID's own rows are not the entry's: price as if from a dated ID without any.
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
    // What prices calls, not who changed it or when.
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

/** The bundled table alone: an instance without prices of its own. */
export const BUNDLED_BOOK: PriceBook = priceBookOf([]);

/**
 * The price of a call of `model` at `at`, where it comes from, and the
 * custom row it is, if one; null without a price. What the SQL of
 * pricedColumns works out, in JavaScript.
 */
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

/** The slot of a timeline (its moments and slots, as SQL) that applies at the call's time. */
const timelineAt = (froms: string, slots: string) =>
  `${slots}[arrayCount(moment -> moment <= toUnixTimestamp64Milli(timestamp), ${froms})]`;

/**
 * SQL columns over an ai_calls row, for a SELECT list: `price_entry`, the
 * slot that prices it (0: none), `cost`, its estimated cost in US dollars
 * (0 without a price), `priced`, whether it has one, and
 * `all_input_tokens`, its input with the cached tokens, however the call
 * counted them (the cache-read share's whole). The prices go in
 * as query parameters, never as SQL text. A sum of these is the cost of
 * the calls summed.
 *
 * Per call: the bundled match is `indexOf` and `arrayFirstIndex` over the
 * IDs and prefixes; a model with custom rows is found with one `indexOf`
 * over those models, else its bundled entry with one `indexOf` over the
 * entries with custom rows, and its slot is the count of that timeline's
 * moments at or before the call (each timeline starts before any call).
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
    // A call of an entry with custom rows on its IDs: the entry's timeline (ClickHouse
    // computes the repeated bundled match once).
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
  // ClickHouse answers 0 for index 0: no entry, no price.
  const at = (values: number[]) => `${params.add(values, "Array(Float64)")}[price_entry]`;
  // The input less what was read from and written to a cache when it holds
  // them, else all of it (costOf); never below 0, as the columns are unsigned.
  const base = `if(input_includes_cache AND input_tokens >= cache_read_tokens + cache_write_tokens,
    input_tokens - cache_read_tokens - cache_write_tokens, input_tokens)`;
  return `${entry} AS price_entry,
    (${base} * ${at(arrays.input)}
      + cache_read_tokens * ${at(arrays.cacheRead)}
      + cache_write_tokens * ${at(arrays.cacheWrite)}
      + output_tokens * ${at(arrays.output)}) / 1000000 AS cost,
    price_entry > 0 AS priced,
    if(input_includes_cache, input_tokens,
      input_tokens + cache_read_tokens + cache_write_tokens) AS all_input_tokens`;
}
