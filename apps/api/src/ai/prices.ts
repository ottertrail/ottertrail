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
 * Cost is worked out when calls are read, never stored (pricedCostSql):
 * a corrected price applies to past calls too. A model is matched by its
 * ID, in any case, whatever provider sent it: first exactly, then by the
 * longest prefix (dated snapshots and region prefixes). A model that
 * matches nothing has no price: its tokens count, its cost does not, and
 * reports count its calls as "no price".
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

/** The entry a model ID matches, or null: exactly first, then the longest prefix. */
export function priceOf(model: string): ModelPrice | null {
  const id = model.toLowerCase();
  const exact = PRICES.find((entry) => entry.ids.includes(id));
  if (exact !== undefined) return exact;
  let found: ModelPrice | null = null;
  let length = 0;
  for (const entry of PRICES) {
    for (const prefix of entry.prefixes ?? []) {
      if (prefix.length > length && id.startsWith(prefix)) {
        found = entry;
        length = prefix.length;
      }
    }
  }
  return found;
}

/** Tokens of each kind a call or a sum of calls has. */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * The estimated cost of one call's tokens at a price, in US dollars:
 * cache reads and writes at their own prices, the rest of the input at the
 * input price, and the output (reasoning included) at the output price.
 * The conventions count cached tokens in the input, so the rest is the
 * input less both; a sender whose input is smaller than its cached tokens
 * counts them apart (as Anthropic's API does), so all of its input is the rest.
 */
export function costOf(price: ModelPrice, tokens: TokenCounts): number {
  const cached = tokens.cacheRead + tokens.cacheWrite;
  const base = tokens.input >= cached ? tokens.input - cached : tokens.input;
  return (
    (base * price.input +
      tokens.cacheRead * (price.cacheRead ?? price.input) +
      tokens.cacheWrite * (price.cacheWrite ?? price.input) +
      tokens.output * price.output) /
    1_000_000
  );
}

/** The table as query parameters, built once: lookups by exact ID and by prefix, longest first. */
interface PriceArrays {
  ids: string[];
  idEntries: number[];
  prefixes: string[];
  prefixEntries: number[];
  input: number[];
  output: number[];
  cacheRead: number[];
  cacheWrite: number[];
}

function arraysOf(prices: readonly ModelPrice[]): PriceArrays {
  const arrays: PriceArrays = {
    ids: [],
    idEntries: [],
    prefixes: [],
    prefixEntries: [],
    input: [],
    output: [],
    cacheRead: [],
    cacheWrite: [],
  };
  const prefixes: [string, number][] = [];
  for (const [index, entry] of prices.entries()) {
    // Entries are numbered from 1: 0 is "no price", what ClickHouse answers for index 0.
    const number = index + 1;
    for (const id of entry.ids) {
      arrays.ids.push(id);
      arrays.idEntries.push(number);
    }
    for (const prefix of entry.prefixes ?? []) prefixes.push([prefix, number]);
    arrays.input.push(entry.input);
    arrays.output.push(entry.output);
    arrays.cacheRead.push(entry.cacheRead ?? entry.input);
    arrays.cacheWrite.push(entry.cacheWrite ?? entry.input);
  }
  for (const [prefix, number] of prefixes.toSorted((a, b) => b[0].length - a[0].length)) {
    arrays.prefixes.push(prefix);
    arrays.prefixEntries.push(number);
  }
  return arrays;
}

const BUNDLED = arraysOf(PRICES);

/**
 * SQL columns over an ai_calls row, for a SELECT list: `price_entry`, the
 * entry its model matches (0: none), `cost`, its estimated cost in US
 * dollars (0 without a price), and `priced`, whether its model has one.
 * The price table goes in as query parameters, never as SQL text. A sum
 * of these is the cost of the calls summed.
 */
export function pricedColumns(params: QueryParams, prices: readonly ModelPrice[] = PRICES): string {
  const arrays = prices === PRICES ? BUNDLED : arraysOf(prices);
  const ids = params.add(arrays.ids, "Array(String)");
  const prefixes = params.add(arrays.prefixes, "Array(String)");
  const model = "lower(model)";
  const entry = `if(has(${ids}, ${model}),
      ${params.add(arrays.idEntries, "Array(UInt32)")}[indexOf(${ids}, ${model})],
      ${params.add(arrays.prefixEntries, "Array(UInt32)")}[arrayFirstIndex(prefix -> startsWith(${model}, prefix), ${prefixes})])`;
  // ClickHouse answers 0 for index 0: no entry, no price.
  const at = (values: number[]) => `${params.add(values, "Array(Float64)")}[price_entry]`;
  // The input less what was read from and written to a cache; all of it
  // when it is smaller, from a sender that counts cached tokens apart (costOf).
  const base = `if(input_tokens >= cache_read_tokens + cache_write_tokens,
    input_tokens - cache_read_tokens - cache_write_tokens, input_tokens)`;
  return `${entry} AS price_entry,
    (${base} * ${at(arrays.input)}
      + cache_read_tokens * ${at(arrays.cacheRead)}
      + cache_write_tokens * ${at(arrays.cacheWrite)}
      + output_tokens * ${at(arrays.output)}) / 1000000 AS cost,
    price_entry > 0 AS priced`;
}
