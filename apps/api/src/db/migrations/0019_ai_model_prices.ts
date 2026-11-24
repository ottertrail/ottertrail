import { type Kysely, sql } from "kysely";

/**
 * The instance's own AI model prices (docs/ai-usage.md, "Prices";
 * ai/custom-prices.ts), set in Settings → AI models by the owner and
 * admins over the bundled table (ai/price-table.ts). Like
 * instance_settings, it is the customer's, deployment-wide today: it
 * moves to an organization with the other instance settings, when
 * organizations exist and the key becomes (organization, model,
 * effective_from). No row names another row: `price_as` names a model,
 * matched when calls are read.
 *
 * - provider, model: in lower case, as matching uses; the model is
 *   matched exactly, whatever provider sent the call.
 * - effective_from: from when the row prices the model's calls; null for
 *   all of them (a correction). A call takes the row with the latest
 *   effective_from at or before its time.
 * - input, output, cache_read, cache_write: US dollars per million
 *   tokens; a null cache price charges cached tokens as input.
 * - price_as_provider, price_as_model: instead of prices, the model whose
 *   price this one takes (a dated snapshot priced as its model), for all
 *   calls; one level only.
 * - created_by, updated_by: who added and last changed the row; null once
 *   that user is deleted.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table ai_model_prices (
      id                uuid           primary key default gen_random_uuid(),
      provider          text           not null
                        constraint ai_model_prices_provider_check
                        check (provider = lower(provider) and char_length(provider) between 1 and 100),
      model             text           not null
                        constraint ai_model_prices_model_check
                        check (model = lower(model) and char_length(model) between 1 and 100),
      effective_from    timestamptz,
      input             numeric(16, 6),
      output            numeric(16, 6),
      cache_read        numeric(16, 6),
      cache_write       numeric(16, 6),
      price_as_provider text
                        constraint ai_model_prices_price_as_provider_check
                        check (price_as_provider = lower(price_as_provider)
                               and char_length(price_as_provider) between 1 and 100),
      price_as_model    text
                        constraint ai_model_prices_price_as_model_check
                        check (price_as_model = lower(price_as_model)
                               and char_length(price_as_model) between 1 and 100
                               and price_as_model <> model),
      created_by        uuid           references dashboard_users (id) on delete set null,
      updated_by        uuid           references dashboard_users (id) on delete set null,
      created_at        timestamptz    not null default now(),
      updated_at        timestamptz    not null default now(),
      constraint ai_model_prices_model_from_key unique nulls not distinct (model, effective_from),
      constraint ai_model_prices_prices_check check (
        (input is null or input between 0 and 10000)
        and (output is null or output between 0 and 10000)
        and (cache_read is null or cache_read between 0 and 10000)
        and (cache_write is null or cache_write between 0 and 10000)
      ),
      -- Prices, or the model it is priced as, never both; price_as for all calls only.
      constraint ai_model_prices_kind_check check (
        (price_as_model is null and price_as_provider is null
          and input is not null and output is not null)
        or (price_as_model is not null and price_as_provider is not null
          and input is null and output is null and cache_read is null and cache_write is null
          and effective_from is null)
      )
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table ai_model_prices`.execute(db);
}
