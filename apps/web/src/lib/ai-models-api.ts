import { queryOptions } from "@tanstack/react-query";

import { apiRequest, expectShape } from "./api";
import { isListOf, isNumber, isRecord, isText, isTextOrNull } from "./telemetry-shapes";

/**
 * AI model prices in US dollars per million tokens, for the owner and admins
 * (docs/ai-usage.md, "Prices"; apps/api/src/ai/model-routes.ts).
 */

/** A model's prices per million tokens; a null cache price is charged as input. */
export interface Rates {
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
}

export type PriceSource = "built_in" | "custom" | "price_as";

export interface CustomRates {
  /** From when it applies (midnight in the instance's timezone); null: all calls. */
  effectiveFrom: string | null;
  rates: Rates;
  updatedAt: string;
  /** Who last changed it; null once that user is deleted. */
  updatedBy: string | null;
}

export interface AiModel {
  model: string;
  provider: string;
  /** The bundled entry's name, if it has one. */
  label: string | null;
  /** Calls in the last `callsDays` days, across the instance's projects; null: not counted. */
  calls: number | null;
  /** What a call costs now; null: no price. */
  price: Rates | null;
  source: PriceSource | null;
  /** With a custom source: the row that prices a call now, on this model or another ID of its entry. */
  current: {
    model: string;
    effectiveFrom: string | null;
    updatedAt: string;
    updatedBy: string | null;
  } | null;
  /** The built-in entry a price on this model covers; null: it covers this model only. */
  covers: { ids: string[]; prefixes: string[] } | null;
  /** The bundled price, the provider's page it was read from, and what it leaves out. */
  builtIn: {
    label: string;
    checked: string;
    source: string;
    notes: string | null;
    rates: Rates;
  } | null;
  prices: CustomRates[];
  priceAs: { provider: string; model: string; updatedAt: string; updatedBy: string | null } | null;
}

/** GET /api/settings/ai-models */
export interface AiModelList {
  now: string;
  callsDays: number;
  /** false: ClickHouse could not count the calls; the prices still list. */
  callsCounted: boolean;
  limits: { maxPrice: number; decimals: number };
  models: AiModel[];
}

const isNumberOrNull = (value: unknown): value is number | null =>
  value === null || isNumber(value);

const isRates = (value: unknown): value is Rates =>
  isRecord(value) &&
  isNumber(value.input) &&
  isNumber(value.output) &&
  isNumberOrNull(value.cacheRead) &&
  isNumberOrNull(value.cacheWrite);

const isCustomRates = (value: unknown): value is CustomRates =>
  isRecord(value) &&
  isTextOrNull(value.effectiveFrom) &&
  isRates(value.rates) &&
  isText(value.updatedAt) &&
  isTextOrNull(value.updatedBy);

const SOURCES: readonly unknown[] = ["built_in", "custom", "price_as", null];

const isModel = (value: unknown): value is AiModel =>
  isRecord(value) &&
  isText(value.model) &&
  isText(value.provider) &&
  isTextOrNull(value.label) &&
  isNumberOrNull(value.calls) &&
  (value.price === null || isRates(value.price)) &&
  SOURCES.includes(value.source) &&
  (value.current === null ||
    (isRecord(value.current) &&
      isText(value.current.model) &&
      isTextOrNull(value.current.effectiveFrom) &&
      isText(value.current.updatedAt) &&
      isTextOrNull(value.current.updatedBy))) &&
  (value.covers === null ||
    (isRecord(value.covers) &&
      isListOf(value.covers.ids, isText) &&
      isListOf(value.covers.prefixes, isText))) &&
  (value.builtIn === null ||
    (isRecord(value.builtIn) &&
      isText(value.builtIn.label) &&
      isText(value.builtIn.checked) &&
      isText(value.builtIn.source) &&
      isTextOrNull(value.builtIn.notes) &&
      isRates(value.builtIn.rates))) &&
  isListOf(value.prices, isCustomRates) &&
  (value.priceAs === null ||
    (isRecord(value.priceAs) &&
      isText(value.priceAs.provider) &&
      isText(value.priceAs.model) &&
      isText(value.priceAs.updatedAt) &&
      isTextOrNull(value.priceAs.updatedBy)));

const isModelList = (value: unknown): value is AiModelList =>
  isRecord(value) &&
  isText(value.now) &&
  isNumber(value.callsDays) &&
  typeof value.callsCounted === "boolean" &&
  isRecord(value.limits) &&
  isNumber(value.limits.maxPrice) &&
  isNumber(value.limits.decimals) &&
  isListOf(value.models, isModel);

export const aiModelsQuery = () =>
  queryOptions({
    queryKey: ["settings", "ai-models"],
    queryFn: async ({ signal }) =>
      expectShape(await apiRequest("/api/settings/ai-models", { signal }), isModelList),
  });

/** A price for a model: from a day ("YYYY-MM-DD", in the instance's timezone) or for all calls. */
export async function setModelPrice(change: {
  provider: string;
  model: string;
  effectiveFrom: string | null;
  rates: Rates;
}): Promise<void> {
  await apiRequest("/api/settings/ai-models/price", {
    method: "PUT",
    body: {
      provider: change.provider,
      model: change.model,
      effectiveFrom: change.effectiveFrom,
      ...change.rates,
    },
  });
}

/** Prices a model as another, for all its calls. */
export async function setPriceAs(change: {
  provider: string;
  model: string;
  priceAs: { provider: string; model: string };
}): Promise<void> {
  await apiRequest("/api/settings/ai-models/price-as", { method: "PUT", body: change });
}

/** Removes a model's own prices: it goes back to the built-in price, or none. */
export async function resetModel(model: string): Promise<void> {
  await apiRequest("/api/settings/ai-models/reset", { method: "POST", body: { model } });
}

/** What a price on the model covers: "gpt-4o, gpt-4o-2024-08-06 and gpt-4o-2024-11-20". */
export function coversText(model: AiModel): string {
  if (model.covers === null) return `only ${model.model}`;
  const { ids, prefixes } = model.covers;
  const names = ids.length === 1 ? ids[0] : `${ids.slice(0, -1).join(", ")} and ${ids.at(-1)}`;
  return prefixes.length === 0 ? names : `${names}, and IDs that start with ${prefixes.join(", ")}`;
}

/** The instance's prices that start after `now`. */
export const upcoming = (model: AiModel, now: string): CustomRates[] =>
  model.prices.filter(
    (price) => price.effectiveFrom !== null && Date.parse(price.effectiveFrom) > Date.parse(now),
  );
