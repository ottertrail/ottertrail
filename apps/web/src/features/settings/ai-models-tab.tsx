import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import {
  ArrowUpRightIcon,
  LoaderCircleIcon,
  OctagonAlertIcon,
  PlusIcon,
  SearchXIcon,
  SparklesIcon,
} from "lucide-react";
import * as React from "react";

import { clickableRow, ROW_LINK } from "@/components/clickable-row";
import { Missing } from "@/components/missing";
import { PINNED } from "@/components/pinned-column";
import { ScrollHint } from "@/components/scroll-hint";
import { SettingsSection } from "@/components/settings-section";
import { StatusBadge } from "@/components/status-badge";
import { TruncatedText } from "@/components/truncated-text";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { type Normalizers, useDirtyForm } from "@/hooks/use-dirty-form";
import { useSearchParam } from "@/hooks/use-search-param";
import {
  type AiModel,
  type AiModelList,
  aiModelsQuery,
  coversText,
  type Rates,
  resetModel,
  setModelPrice,
  setPriceAs,
  upcoming,
} from "@/lib/ai-models-api";

import { formatWhole } from "../analytics/format";
import type { InstanceTabProps } from "./section-states";

/** In the address: `?show=no-price` lists only the models without a price. */
export const NO_PRICE = "no-price";

/** Rows shown at first, and added by each Show more. */
export const MODELS_PAGE = 50;

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

/** "22 Nov 2026" for a calendar day ("YYYY-MM-DD"). */
const formatCalendarDay = (day: string) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00Z`));

/** "22 Nov 2026" for a moment, in the instance's timezone. */
const formatDate = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone,
  }).format(new Date(iso));

/** Today, "YYYY-MM-DD", in the instance's timezone. */
const todayIn = (timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

/** Who changed a price and when: " by Ada Owner on 22 Nov 2026". */
const changedText = (by: string | null, at: string, timeZone: string) =>
  `${by === null ? "" : ` by ${by}`} on ${formatDate(at, timeZone)}`;

/** Where the model's price comes from, in words. */
function sourceText(model: AiModel, timeZone: string): string {
  if (model.source === "built_in" && model.builtIn !== null) {
    return `Built-in, checked ${formatCalendarDay(model.builtIn.checked)}`;
  }
  const custom = model.current;
  if (model.source === "custom" && custom !== null) {
    const on = custom.model === model.model ? "" : ` on ${custom.model}`;
    const from =
      custom.effectiveFrom === null ? "" : ` from ${formatDate(custom.effectiveFrom, timeZone)}`;
    return `Custom${on}${from},${changedText(custom.updatedBy, custom.updatedAt, timeZone)}`;
  }
  if (model.source === "price_as" && model.priceAs !== null) {
    return `Price as ${model.priceAs.model},${changedText(model.priceAs.updatedBy, model.priceAs.updatedAt, timeZone)}`;
  }
  return "None";
}

/** The table's line on what a price covers: every ID while few, else how many. */
function coversLine(model: AiModel): string | null {
  const ids = model.covers?.ids.length ?? 0;
  if (ids <= 1) return null;
  return ids > 2 ? `Covers ${formatWhole(ids)} IDs` : `Covers ${coversText(model)}`;
}

/** "$3.00 input, $15.00 output, $0.30 cache read, cache write as input". */
const ratesText = (rates: Rates) =>
  [
    `${usd.format(rates.input)} input`,
    `${usd.format(rates.output)} output`,
    rates.cacheRead === null ? "cache read as input" : `${usd.format(rates.cacheRead)} cache read`,
    rates.cacheWrite === null
      ? "cache write as input"
      : `${usd.format(rates.cacheWrite)} cache write`,
  ].join(", ");

/** A price per million tokens; a cache price that is the input's says so. */
function PriceCell({
  value,
  cache = false,
}: {
  value: number | null | undefined;
  cache?: boolean;
}) {
  if (value === undefined) return <Missing label="No price" />;
  if (value === null) {
    return cache ? <span className="text-ink-subtle">As input</span> : <Missing label="No price" />;
  }
  return <>{usd.format(value)}</>;
}

/** Whether a model has any price of the instance's own. */
const hasCustom = (model: AiModel) => model.prices.length > 0 || model.priceAs !== null;

/** Whether the search's text is in the model's ID, provider, name, or the IDs its price covers. */
function matches(model: AiModel, search: string): boolean {
  if (search === "") return true;
  const needle = search.toLowerCase();
  return [
    model.model,
    model.provider,
    model.label ?? "",
    model.builtIn?.label ?? "",
    ...(model.covers?.ids ?? []),
  ].some((text) => text.toLowerCase().includes(needle));
}

/** Everything that changes a price shows on the AI page and in AI cost alerts: read again. */
function useAfterChange() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: aiModelsQuery().queryKey });
    void queryClient.invalidateQueries({ queryKey: ["ai"] });
  };
}

type RateField = "input" | "output" | "cacheRead" | "cacheWrite";
type FieldName = RateField | "provider" | "model" | "from";

const RATE_FIELDS: readonly { field: RateField; label: string; optional: boolean }[] = [
  { field: "input", label: "Input", optional: false },
  { field: "output", label: "Output", optional: false },
  { field: "cacheRead", label: "Cache read", optional: true },
  { field: "cacheWrite", label: "Cache write", optional: true },
];

interface Draft {
  provider: string;
  model: string;
  applies: "all" | "from";
  from: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
}

const textOf = (value: number | null | undefined) =>
  value === null || value === undefined ? "" : String(value);

/** A typed price as its number, so 3 and 3.0 are no change; other text as typed. */
function priceValue(text: string): unknown {
  const value = text.trim();
  return /^\d+(\.\d+)?$/.test(value) ? Number(value) : value;
}

const PRICE_NORMALIZERS: Normalizers<Draft> = {
  input: priceValue,
  output: priceValue,
  cacheRead: priceValue,
  cacheWrite: priceValue,
};

/**
 * The form's start: the model's price now, else its built-in one; a model
 * with a price changes it from `today` on, one without takes it for all calls.
 */
function draftOf(model: AiModel | undefined, today: string): Draft {
  const rates = model?.price ?? model?.builtIn?.rates;
  return {
    provider: model?.provider ?? "",
    model: model?.model ?? "",
    applies: model?.price === null || model === undefined ? "all" : "from",
    from: today,
    input: textOf(rates?.input),
    output: textOf(rates?.output),
    cacheRead: textOf(rates?.cacheRead),
    cacheWrite: textOf(rates?.cacheWrite),
  };
}

/** What is wrong with a typed price, or null. */
function priceProblem(
  text: string,
  optional: boolean,
  { maxPrice, decimals }: AiModelList["limits"],
): string | null {
  const value = text.trim();
  if (value === "") return optional ? null : "Enter a price.";
  if (!/^\d+(\.\d+)?$/.test(value)) return "Enter a number of 0 or more, such as 0.25.";
  if ((value.split(".")[1] ?? "").length > decimals) return `Use at most ${decimals} decimals.`;
  if (Number(value) > maxPrice) return `Enter at most ${usd.format(maxPrice)}.`;
  return null;
}

function problemsOf(
  draft: Draft,
  limits: AiModelList["limits"],
  adding: boolean,
  known: ReadonlySet<string>,
): Partial<Record<FieldName, string>> {
  const problems: Partial<Record<FieldName, string>> = {};
  for (const { field, optional } of RATE_FIELDS) {
    const problem = priceProblem(draft[field], optional, limits);
    if (problem !== null) problems[field] = problem;
  }
  if (draft.applies === "from" && !/^\d{4}-\d{2}-\d{2}$/.test(draft.from)) {
    problems.from = "Choose the first day the price applies.";
  }
  if (adding) {
    if (draft.provider.trim() === "") problems.provider = "Enter the provider, such as openai.";
    if (draft.model.trim() === "") problems.model = "Enter the model ID the calls send.";
    else if (known.has(draft.model.trim().toLowerCase())) {
      problems.model = "This model is already in the table. Edit its price there.";
    }
  }
  return problems;
}

/** A typed cache price: empty is charged as input. */
const optionalRate = (text: string) => (text.trim() === "" ? null : Number(text));

const ratesOf = (draft: Draft): Rates => ({
  input: Number(draft.input),
  output: Number(draft.output),
  cacheRead: optionalRate(draft.cacheRead),
  cacheWrite: optionalRate(draft.cacheWrite),
});

/**
 * What a price for all calls replaces: "its 2 dated prices (from 1 Jan
 * 2027 and 1 Mar 2027) and its price as gpt-4o"; null for nothing.
 */
function replacedText(model: AiModel, timeZone: string): string | null {
  const dated = model.prices.flatMap((price) =>
    price.effectiveFrom === null ? [] : [formatDate(price.effectiveFrom, timeZone)],
  );
  const days =
    dated.length === 1 ? dated[0] : `${dated.slice(0, -1).join(", ")} and ${dated.at(-1)}`;
  const parts = [
    ...(dated.length === 0
      ? []
      : [
          `its ${dated.length === 1 ? "dated price" : `${dated.length} dated prices`} (from ${days})`,
        ]),
    ...(model.priceAs === null ? [] : [`its price as ${model.priceAs.model}`]),
  ];
  return parts.length === 0 ? null : parts.join(" and ");
}

/** One term of the sheet's details and what it says. */
function Detail({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-ink-subtle">{term}</dt>
      <dd className="min-w-0 [overflow-wrap:anywhere] text-ink">{children}</dd>
    </>
  );
}

/** The host of a price page, for its link's text: "docs.anthropic.com". */
function hostOf(address: string): string {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
}

/**
 * What the sheet knows about a model past its price: where the price comes
 * from, the built-in one with its page and notes, the instance's own prices,
 * price as, and its calls. The IDs a price covers are in the Price line.
 */
function ModelDetails({
  model,
  list,
  timeZone,
}: {
  model: AiModel;
  list: AiModelList;
  timeZone: string;
}) {
  const id = React.useId();
  const later = new Set(upcoming(model, list.now).map((price) => price.effectiveFrom));
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 border-t pt-5">
      <h3 id={id} className="text-sm font-medium text-ink">
        Details
      </h3>
      <dl className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm">
        <Detail term="Source">{sourceText(model, timeZone)}</Detail>
        {model.builtIn !== null && (
          <Detail term="Built-in price">
            <span className="block">{ratesText(model.builtIn.rates)}</span>
            {model.builtIn.notes !== null && (
              <span className="block text-ink-subtle">{model.builtIn.notes}</span>
            )}
            <a
              href={model.builtIn.source}
              target="_blank"
              rel="noreferrer"
              className="mt-1 flex w-fit items-center gap-0.5 text-link hover:underline"
            >
              Price page on {hostOf(model.builtIn.source)}
              <ArrowUpRightIcon aria-hidden="true" className="size-3.5" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </Detail>
        )}
        {model.prices.length > 0 && (
          <Detail term="Custom prices">
            <ul className="flex flex-col gap-2">
              {model.prices.map((price) => (
                <li key={price.effectiveFrom ?? "all"}>
                  <span className="block">
                    <span className="font-medium">
                      {price.effectiveFrom === null
                        ? "All calls"
                        : `${later.has(price.effectiveFrom) ? "Starts" : "From"} ${formatDate(price.effectiveFrom, timeZone)}`}
                    </span>
                    : {ratesText(price.rates)}
                  </span>
                  <span className="block text-ink-subtle">
                    Set{changedText(price.updatedBy, price.updatedAt, timeZone)}
                  </span>
                </li>
              ))}
            </ul>
          </Detail>
        )}
        {model.priceAs !== null && (
          <Detail term="Price as">
            <span className="block">{model.priceAs.model}</span>
            <span className="block text-ink-subtle">
              Set{changedText(model.priceAs.updatedBy, model.priceAs.updatedAt, timeZone)}
            </span>
          </Detail>
        )}
        <Detail term={`Calls (${list.callsDays} days)`}>
          {model.calls === null ? <Missing label="Not counted" /> : formatWhole(model.calls)}
        </Detail>
      </dl>
    </section>
  );
}

/** Where focus goes when the sheet closes: a row's model button, or Add model. */
type FinalFocus = () => HTMLElement | true;

/** What the model sheet says once a change is made, and the model to focus after. */
type Done = (notice: string, model: string | null) => void;

/**
 * A model's sheet, opened by its row: its price as a form with the save
 * rule (Save waits for a change; closing with one asks first, and so does
 * leaving the page), as all calls (a correction) or from a day on (a price
 * change: calls before it keep the earlier price); its details; Price as
 * another model and Reset to built-in, each a dialog over it. Without a
 * model, it adds one: the provider and model ID, then the price.
 */
function ModelSheet({
  model,
  list,
  timeZone,
  open,
  onOpenChange,
  finalFocus,
  onDone,
}: {
  /** The model whose price it edits; undefined: Add model. */
  model: AiModel | undefined;
  list: AiModelList;
  timeZone: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  finalFocus: FinalFocus;
  onDone: Done;
}) {
  const afterChange = useAfterChange();
  const adding = model === undefined;
  // The day the sheet opened: a From date that midnight moved would read as the server's change.
  const [today] = React.useState(() => todayIn(timeZone));
  const form = useDirtyForm(draftOf(model, today), {
    key: model?.model ?? "",
    normalize: PRICE_NORMALIZERS,
  });
  const draft = form.values;
  const [checked, setChecked] = React.useState(false);
  // The dialog over the sheet, kept while it closes so its content stays for the animation.
  const [inner, setInner] = React.useState<"discard" | "price-as" | "reset">("discard");
  const [innerOpen, setInnerOpen] = React.useState(false);
  const ask = (kind: "discard" | "price-as" | "reset") => {
    setInner(kind);
    setInnerOpen(true);
  };
  const id = React.useId();
  const known = React.useMemo(() => new Set(list.models.map((item) => item.model)), [list]);
  const save = useMutation({
    mutationFn: (values: Draft) =>
      setModelPrice({
        provider: values.provider.trim(),
        model: values.model.trim(),
        effectiveFrom: values.applies === "from" ? values.from : null,
        rates: ratesOf(values),
      }),
    onSuccess: (_, values) => {
      form.saved(values);
      // The sheet closes: anything typed while the request ran goes with it.
      form.discard();
      afterChange();
      const name = values.model.trim();
      onDone(adding ? `Added ${name}.` : `Saved the price of ${name}.`, name.toLowerCase());
      onOpenChange(false);
    },
  });
  const problems = problemsOf(draft, list.limits, adding, known);
  const valid = Object.keys(problems).length === 0;
  const errorOf = (field: FieldName) => (checked ? (problems[field] ?? null) : null);
  const change = (next: Partial<Draft>) => {
    form.setValues((previous) => ({ ...previous, ...next }));
    if (save.isError) save.reset();
  };
  const fieldId = (field: FieldName) => `${id}-${field}`;
  const replaced = model === undefined ? null : replacedText(model, timeZone);
  const describedBy = (field: FieldName, hint: boolean) =>
    errorOf(field) === null
      ? hint
        ? `${fieldId(field)}-hint`
        : undefined
      : `${fieldId(field)}-error`;
  const errorText = (field: FieldName) => {
    const error = errorOf(field);
    return error === null ? null : <FieldError id={`${fieldId(field)}-error`}>{error}</FieldError>;
  };
  const textField = (field: "provider" | "model", label: string, placeholder: string) => (
    <Field data-invalid={errorOf(field) !== null || undefined}>
      <FieldLabel htmlFor={fieldId(field)}>{label}</FieldLabel>
      <Input
        id={fieldId(field)}
        value={draft[field]}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        maxLength={100}
        aria-invalid={errorOf(field) !== null || undefined}
        aria-describedby={describedBy(field, false)}
        onChange={(event) => change({ [field]: event.target.value })}
      />
      {errorText(field)}
    </Field>
  );
  const close = () => {
    if (save.isPending) return;
    if (form.dirty) ask("discard");
    else onOpenChange(false);
  };
  // Price as and Reset end the sheet's visit: what was typed in it goes.
  const doneElsewhere = (notice: string) => {
    form.discard();
    setInnerOpen(false);
    onDone(notice, model?.model ?? null);
    onOpenChange(false);
  };
  const status = save.isPending ? "Saving…" : form.dirty ? "Unsaved changes" : "No unsaved changes";
  const label = model?.label ?? model?.builtIn?.label ?? null;

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else close();
      }}
    >
      <SheetContent
        side="right"
        className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
        finalFocus={finalFocus}
      >
        <form
          noValidate
          aria-label={adding ? "New model" : "Price"}
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (!form.dirty || save.isPending) return;
            setChecked(true);
            if (valid) save.mutate(form.values);
          }}
        >
          <SheetHeader className="border-b pr-12">
            <SheetTitle className={cn("min-w-0 [overflow-wrap:anywhere]", !adding && "font-mono")}>
              {adding ? "Add a model" : model.model}
            </SheetTitle>
            {!adding && (
              <SheetDescription className="text-pretty text-ink-subtle">
                {[model.provider, label].filter((part) => part !== null).join(" · ")}
              </SheetDescription>
            )}
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
            {adding && (
              <div className="grid gap-4 sm:grid-cols-2">
                {textField("provider", "Provider", "openai")}
                {textField("model", "Model ID", "llama-3.3-70b")}
              </div>
            )}
            <section aria-labelledby={`${id}-price`} className="flex flex-col gap-4">
              <header className="flex flex-col gap-1">
                <h3 id={`${id}-price`} className="text-sm font-medium text-ink">
                  Price
                </h3>
                <p className="text-sm text-pretty text-ink-subtle">
                  USD per million tokens.{adding ? "" : ` Covers ${coversText(model)}.`}
                </p>
              </header>
              <div className="grid grid-cols-2 gap-4">
                {RATE_FIELDS.map(({ field, label: fieldLabel, optional }) => (
                  <Field key={field} data-invalid={errorOf(field) !== null || undefined}>
                    <FieldLabel htmlFor={fieldId(field)}>{fieldLabel}</FieldLabel>
                    <Input
                      id={fieldId(field)}
                      inputMode="decimal"
                      autoComplete="off"
                      value={draft[field]}
                      placeholder={optional ? "As input" : "0.00"}
                      aria-invalid={errorOf(field) !== null || undefined}
                      aria-describedby={describedBy(field, optional)}
                      onChange={(event) => change({ [field]: event.target.value })}
                    />
                    {errorText(field) ??
                      (optional && (
                        <FieldDescription id={`${fieldId(field)}-hint`}>
                          Empty: charged as input.
                        </FieldDescription>
                      ))}
                  </Field>
                ))}
              </div>
              <fieldset className="flex flex-col gap-3">
                <legend className="mb-3 text-sm font-medium text-ink" id={`${id}-applies`}>
                  Applies to
                </legend>
                <RadioGroup
                  aria-labelledby={`${id}-applies`}
                  value={draft.applies}
                  onValueChange={(value) => {
                    if (value === "all" || value === "from") change({ applies: value });
                  }}
                  className="gap-3"
                >
                  <Field orientation="horizontal" className="items-start">
                    <RadioGroupItem value="all" id={`${id}-all`} className="mt-0.5" />
                    <FieldContent>
                      <FieldLabel htmlFor={`${id}-all`}>All calls</FieldLabel>
                      <FieldDescription>
                        A correction: past calls take it too.
                        {replaced !== null && ` Replaces ${replaced}.`}
                      </FieldDescription>
                    </FieldContent>
                  </Field>
                  <Field orientation="horizontal" className="items-start">
                    <RadioGroupItem value="from" id={`${id}-from-choice`} className="mt-0.5" />
                    <FieldContent>
                      <FieldLabel htmlFor={`${id}-from-choice`}>Calls from a date on</FieldLabel>
                      <FieldDescription>
                        A price change: earlier calls keep their price.
                      </FieldDescription>
                    </FieldContent>
                  </Field>
                </RadioGroup>
                {draft.applies === "from" && (
                  <Field data-invalid={errorOf("from") !== null || undefined} className="ps-7">
                    <FieldLabel htmlFor={fieldId("from")}>From</FieldLabel>
                    <Input
                      id={fieldId("from")}
                      type="date"
                      value={draft.from}
                      className="max-w-44"
                      aria-invalid={errorOf("from") !== null || undefined}
                      aria-describedby={describedBy("from", true)}
                      onChange={(event) => change({ from: event.target.value })}
                    />
                    {errorText("from") ?? (
                      <FieldDescription id={`${fieldId("from")}-hint`}>
                        Midnight in {timeZone}.
                      </FieldDescription>
                    )}
                  </Field>
                )}
              </fieldset>
              {checked && !valid && (
                <p role="alert" className="text-sm text-destructive">
                  Correct the marked fields above.
                </p>
              )}
              {form.conflict && (
                <Alert role="alert">
                  <OctagonAlertIcon />
                  <AlertTitle>The price changed while you edited it</AlertTitle>
                  <AlertDescription>
                    Save to replace it with yours, or load the new values to discard your edits.
                  </AlertDescription>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-2 justify-self-start"
                    onClick={() => form.discard()}
                  >
                    Load the new values
                  </Button>
                </Alert>
              )}
              {save.error !== null && (
                <Alert variant="destructive" role="alert">
                  <OctagonAlertIcon />
                  <AlertTitle>The price was not saved</AlertTitle>
                  <AlertDescription>{save.error.message}</AlertDescription>
                </Alert>
              )}
            </section>
            {!adding && <ModelDetails model={model} list={list} timeZone={timeZone} />}
            {!adding && (model.builtIn === null || hasCustom(model)) && (
              <div className="flex flex-wrap gap-2 border-t pt-5">
                {model.builtIn === null && (
                  <Button type="button" variant="outline" onClick={() => ask("price-as")}>
                    Price as another model
                  </Button>
                )}
                {hasCustom(model) && (
                  <Button type="button" variant="outline" onClick={() => ask("reset")}>
                    Reset to built-in
                  </Button>
                )}
              </div>
            )}
          </div>
          <SheetFooter className="mt-0 flex-row flex-wrap items-center gap-2 border-t">
            <output aria-live="polite" className="mr-auto text-sm text-ink-subtle">
              {status}
            </output>
            <Button type="button" variant="outline" onClick={close} disabled={save.isPending}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!form.dirty || save.isPending}
              focusableWhenDisabled
              aria-busy={save.isPending || undefined}
              className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            >
              {save.isPending && (
                <LoaderCircleIcon
                  aria-hidden="true"
                  className="animate-spin motion-reduce:animate-none"
                />
              )}
              {save.isPending ? "Saving…" : adding ? "Add model" : "Save price"}
            </Button>
          </SheetFooter>
        </form>
        {/* Outside the form: a dialog's own form must not submit the price. */}
        <Dialog open={innerOpen} onOpenChange={setInnerOpen}>
          <DialogContent className="sm:max-w-lg" showCloseButton={inner !== "discard"}>
            {inner === "discard" && (
              <>
                <DialogHeader>
                  <DialogTitle>Discard your changes?</DialogTitle>
                  <DialogDescription className="text-pretty [overflow-wrap:anywhere]">
                    {adding
                      ? "The model will not be added."
                      : `Unsaved changes to the price of ${model.model} will be lost.`}
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose render={<Button variant="outline" type="button" />}>
                    Keep editing
                  </DialogClose>
                  <Button
                    variant="destructive"
                    onClick={() => {
                      form.discard();
                      setInnerOpen(false);
                      onOpenChange(false);
                    }}
                  >
                    Discard changes
                  </Button>
                </DialogFooter>
              </>
            )}
            {inner === "price-as" && model !== undefined && (
              <PriceAsForm model={model} list={list} onDone={doneElsewhere} />
            )}
            {inner === "reset" && model !== undefined && (
              <ResetForm model={model} onDone={doneElsewhere} />
            )}
          </DialogContent>
        </Dialog>
      </SheetContent>
    </Sheet>
  );
}

/** Price as: an unknown model (a dated snapshot) takes another model's price, for all its calls. */
function PriceAsForm({
  model,
  list,
  onDone,
}: {
  model: AiModel;
  list: AiModelList;
  onDone: (notice: string) => void;
}) {
  const afterChange = useAfterChange();
  // Models with a price of their own: one level only.
  const targets = React.useMemo(
    () =>
      list.models.filter(
        (item) => item.model !== model.model && item.priceAs === null && item.price !== null,
      ),
    [list, model],
  );
  const [target, setTarget] = React.useState<string | null>(model.priceAs?.model ?? null);
  const [checked, setChecked] = React.useState(false);
  const id = React.useId();
  const chosen = targets.find((item) => item.model === target);
  const save = useMutation({
    mutationFn: () => {
      if (chosen === undefined) throw new Error("Choose a model.");
      return setPriceAs({
        provider: model.provider,
        model: model.model,
        priceAs: { provider: chosen.provider, model: chosen.model },
      });
    },
    onSuccess: () => {
      afterChange();
      onDone(`${model.model} takes the price of ${chosen?.model ?? "the model chosen"}.`);
    },
  });
  const problem = checked && chosen === undefined ? "Choose the model whose price to use." : null;
  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setChecked(true);
        if (chosen !== undefined && !save.isPending) save.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle className="min-w-0 [overflow-wrap:anywhere]">
          Price {model.model} as another model
        </DialogTitle>
        <DialogDescription>
          Its calls take that model&apos;s price, including its price changes.
        </DialogDescription>
      </DialogHeader>
      <Field data-invalid={problem !== null || undefined}>
        <FieldLabel htmlFor={`${id}-target`}>Model</FieldLabel>
        <Combobox
          items={targets.map((item) => item.model)}
          value={target}
          onValueChange={(next) => {
            setTarget(next);
            if (save.isError) save.reset();
          }}
          autoHighlight
        >
          <ComboboxInput
            id={`${id}-target`}
            className="w-full"
            triggerLabel="Show models"
            placeholder="Search models"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={problem !== null || undefined}
            aria-describedby={problem === null ? undefined : `${id}-target-error`}
          />
          <ComboboxContent>
            <ComboboxEmpty>No matching model</ComboboxEmpty>
            <ComboboxList>
              {(item: string) => (
                <ComboboxItem key={item} value={item}>
                  {/* Wrapped, not cut off: a tooltip would not show on a highlighted option. */}
                  <span className="min-w-0 break-words">{item}</span>
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
        {problem !== null && <FieldError id={`${id}-target-error`}>{problem}</FieldError>}
      </Field>
      {save.error !== null && (
        <Alert variant="destructive" role="alert">
          <OctagonAlertIcon />
          <AlertDescription>{save.error.message}</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Asks before removing a model's own prices. */
function ResetForm({ model, onDone }: { model: AiModel; onDone: (notice: string) => void }) {
  const afterChange = useAfterChange();
  const reset = useMutation({
    mutationFn: () => resetModel(model.model),
    onSuccess: () => {
      afterChange();
      onDone(
        model.builtIn === null
          ? `Removed the custom prices of ${model.model}.`
          : `Reset ${model.model} to its built-in price.`,
      );
    },
  });
  return (
    <>
      <DialogHeader>
        <DialogTitle className="min-w-0 [overflow-wrap:anywhere]">
          Reset {model.model} to built-in?
        </DialogTitle>
        <DialogDescription>
          {model.builtIn === null
            ? "This removes its custom prices. It has no built-in price, so its calls will have no price."
            : "This removes its custom prices. All its calls take the built-in price."}
        </DialogDescription>
      </DialogHeader>
      {reset.error !== null && (
        <Alert variant="destructive" role="alert">
          <OctagonAlertIcon />
          <AlertDescription>{reset.error.message}</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
        <Button variant="destructive" onClick={() => reset.mutate()} disabled={reset.isPending}>
          {reset.isPending && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
          Reset to built-in
        </Button>
      </DialogFooter>
    </>
  );
}

/** The table's loading shape: its title and a few rows. */
function TableSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading the AI models">
      <Skeleton className="h-9 w-72 max-w-full" />
      {Array.from({ length: 6 }, (_, index) => (
        <Skeleton key={index} className="h-10 w-full" />
      ))}
    </div>
  );
}

function ModelsTable({
  list,
  models,
  timeZone,
  onOpen,
}: {
  list: AiModelList;
  models: AiModel[];
  timeZone: string;
  onOpen: (model: AiModel) => void;
}) {
  return (
    <ScrollHint>
      <Table>
        <caption className="sr-only">
          AI models, the most called in the last {list.callsDays} days first; prices in USD per
          million tokens
        </caption>
        <TableHeader>
          <TableRow>
            <TableHead className={PINNED}>Model</TableHead>
            <TableHead>Provider</TableHead>
            <TableHead className="text-right">Input</TableHead>
            <TableHead className="text-right">Output</TableHead>
            <TableHead className="text-right">Cache read</TableHead>
            <TableHead className="text-right">Cache write</TableHead>
            <TableHead>Source</TableHead>
            <TableHead className="text-right">Calls ({list.callsDays} days)</TableHead>
            <TableHead>Price</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {models.map((model) => {
            const later = upcoming(model, list.now);
            const covers = coversLine(model);
            return (
              <TableRow key={model.model} {...clickableRow()}>
                {/* Room for a whole Bedrock ID ("us.anthropic.…-v1:0") once the table has it. */}
                <TableCell className={cn("max-w-64 min-w-40 @min-[96rem]:max-w-100", PINNED)}>
                  <TruncatedText
                    text={model.model}
                    // A button is only as wide as its text: held to the cell, so it cuts off.
                    className="max-w-full text-left font-mono text-sm text-link hover:underline"
                    render={
                      <button
                        type="button"
                        {...ROW_LINK}
                        data-model={model.model}
                        aria-label={`${model.model}, edit price`}
                        onClick={() => onOpen(model)}
                      />
                    }
                  />
                </TableCell>
                <TableCell className="whitespace-nowrap">{model.provider}</TableCell>
                <TableCell className="text-right tabular-nums">
                  <PriceCell value={model.price?.input} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <PriceCell value={model.price?.output} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <PriceCell value={model.price?.cacheRead} cache />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <PriceCell value={model.price?.cacheWrite} cache />
                </TableCell>
                <TableCell className="min-w-48 text-sm whitespace-normal">
                  {sourceText(model, timeZone)}
                  {covers !== null && <span className="block text-ink-subtle">{covers}</span>}
                  {later.map((price) => (
                    <span key={price.effectiveFrom} className="block text-ink-subtle">
                      Changes on {formatDate(price.effectiveFrom ?? list.now, timeZone)}
                    </span>
                  ))}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {model.calls === null ? (
                    <Missing label="Not counted" />
                  ) : (
                    formatWhole(model.calls)
                  )}
                </TableCell>
                <TableCell>
                  {model.price === null ? (
                    <StatusBadge tone="warning">No price</StatusBadge>
                  ) : (
                    <StatusBadge tone="good">Priced</StatusBadge>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </ScrollHint>
  );
}

/** The models' buttons in the table, in its order. */
const modelButtons = (list: HTMLElement | null) => [
  ...(list?.querySelectorAll<HTMLElement>("[data-model]") ?? []),
];

/**
 * The AI models tab of the instance's Settings, for the owner and admins
 * (docs/dashboard.md, "AI models"): every model the instance's apps
 * called in the last 30 days and every built-in one, each with its price
 * and where it comes from, 50 rows at a time, with a search. A click on a
 * row opens the model's sheet; Add model opens the same sheet empty.
 * `?show=no-price` lists only the models without a price, as the AI page's
 * link opens it.
 */
export function AiModelsTab({ timeZone }: InstanceTabProps) {
  const list = useQuery(aiModelsQuery());
  const [show, setShow] = useSearchParam("show");
  const noPriceOnly = show === NO_PRICE;

  return (
    <SettingsSection
      title="AI models"
      description="Prices are USD per million tokens. Changes apply to the AI page and AI cost alerts."
      wide="full"
    >
      {list.isPending && <TableSkeleton />}
      {list.isError && (
        <Alert variant="destructive">
          <OctagonAlertIcon />
          <AlertTitle>The AI models could not load</AlertTitle>
          <AlertDescription>{list.error.message}</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={() => void list.refetch()}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      )}
      {list.isSuccess && (
        <ModelsList
          list={list.data}
          noPriceOnly={noPriceOnly}
          onShow={(next) => setShow(next ? NO_PRICE : undefined, { replace: true })}
          timeZone={timeZone}
        />
      )}
    </SettingsSection>
  );
}

/**
 * What the sheet is open for: a model, by its ID (with the row as it was,
 * for a model a reset takes out of the list while the sheet closes), or a
 * new one.
 */
type SheetFor = { model: string; snapshot: AiModel } | "add";

function ModelsList({
  list,
  noPriceOnly,
  onShow,
  timeZone,
}: {
  list: AiModelList;
  noPriceOnly: boolean;
  onShow: (noPriceOnly: boolean) => void;
  timeZone: string;
}) {
  const [search, setSearch] = React.useState("");
  const query = search.trim();
  // How many rows show, for this filter and search; a new one starts again at a page.
  const filterKey = `${noPriceOnly ? NO_PRICE : "all"}:${query}`;
  const [paging, setPaging] = React.useState({ key: filterKey, rows: MODELS_PAGE });
  const rows = paging.key === filterKey ? paging.rows : MODELS_PAGE;
  // What the sheet is for, and whether it is open: kept while it closes, for its animation.
  const [sheet, setSheet] = React.useState<SheetFor | null>(null);
  const [open, setOpen] = React.useState(false);
  // Opened again for the same model, the sheet starts afresh.
  const [opened, setOpened] = React.useState(0);
  const [notice, setNotice] = React.useState("");
  const listRef = React.useRef<HTMLDivElement>(null);
  const addButton = React.useRef<HTMLButtonElement>(null);
  // The model whose button focus goes back to, and its row's place, for the row after it
  // when a change takes it out of the list (a price set under No price, a reset).
  const focusTo = React.useRef<string | null>(null);
  const place = React.useRef(0);
  const focusTarget = React.useCallback(() => {
    const buttons = modelButtons(listRef.current);
    const own = buttons.find((button) => button.dataset.model === focusTo.current);
    return own ?? buttons[Math.min(place.current, buttons.length - 1)] ?? addButton.current;
  }, []);
  const finalFocus = React.useCallback<FinalFocus>(() => focusTarget() ?? true, [focusTarget]);
  // A change reads the list again: once the new list is in, focus that lost its button
  // (the row left the list after the sheet closed) goes to the row in its place.
  const changedFrom = React.useRef<AiModelList | null>(null);
  React.useEffect(() => {
    const before = changedFrom.current;
    if (before === null || before === list || open) return;
    changedFrom.current = null;
    const active = document.activeElement;
    if (active === null || active === document.body || !active.isConnected) focusTarget()?.focus();
  }, [list, open, focusTarget]);
  // Show more that shows the last rows goes away: focus moves to the first of them.
  const focusRow = React.useRef<number | null>(null);

  const unpriced = list.models.filter((model) => model.price === null);
  const filtered = (noPriceOnly ? unpriced : list.models).filter((model) => matches(model, query));
  const shown = filtered.slice(0, rows);
  // After the render that showed the rows (a check of a ref on every render).
  React.useEffect(() => {
    const index = focusRow.current;
    if (index === null) return;
    focusRow.current = null;
    modelButtons(listRef.current)[index]?.focus();
  });
  const sheetModel =
    sheet === null || sheet === "add"
      ? undefined
      : (list.models.find((model) => model.model === sheet.model) ?? sheet.snapshot);
  const openSheet = (next: SheetFor) => {
    focusTo.current = next === "add" ? null : next.model;
    place.current =
      next === "add"
        ? 0
        : Math.max(
            0,
            shown.findIndex((model) => model.model === next.model),
          );
    setNotice("");
    setSheet(next);
    setOpened((count) => count + 1);
    setOpen(true);
  };

  return (
    <div ref={listRef} className="@container flex flex-col gap-3">
      <output aria-live="polite" className="block text-sm text-ink empty:hidden">
        {notice}
      </output>
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          value={[noPriceOnly ? NO_PRICE : "all"]}
          onValueChange={(value) => {
            const [next] = value;
            if (next === NO_PRICE || next === "all") onShow(next === NO_PRICE);
          }}
          aria-label="Which models to list"
          variant="outline"
          size="sm"
          spacing={0}
        >
          <ToggleGroupItem value="all">All models</ToggleGroupItem>
          <ToggleGroupItem value={NO_PRICE}>
            No price ({formatWhole(unpriced.length)})
          </ToggleGroupItem>
        </ToggleGroup>
        <Input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search models"
          aria-label="Search models"
          autoComplete="off"
          spellCheck={false}
          className="h-8 w-64 max-w-full"
        />
        <Button ref={addButton} size="sm" className="ml-auto" onClick={() => openSheet("add")}>
          <PlusIcon aria-hidden="true" />
          Add model
        </Button>
      </div>
      {!list.callsCounted && (
        <p className="text-sm text-ink-subtle">
          Calls could not be counted right now. Prices can still be changed.
        </p>
      )}
      {filtered.length === 0 && query !== "" && (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchXIcon />
            </EmptyMedia>
            <EmptyTitle>No model matches “{query}”</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
      {filtered.length === 0 && query === "" && (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SparklesIcon />
            </EmptyMedia>
            <EmptyTitle>Every model has a price</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
      {filtered.length > 0 && (
        <ModelsTable
          list={list}
          models={shown}
          timeZone={timeZone}
          onOpen={(model) => openSheet({ model: model.model, snapshot: model })}
        />
      )}
      {shown.length < filtered.length && (
        <div className="flex flex-col items-center gap-2 py-2">
          <p className="text-sm text-ink-subtle">
            Showing {formatWhole(shown.length)} of {formatWhole(filtered.length)} models
          </p>
          <Button
            variant="outline"
            onClick={() => {
              if (rows + MODELS_PAGE >= filtered.length) focusRow.current = rows;
              setPaging({ key: filterKey, rows: rows + MODELS_PAGE });
            }}
          >
            Show more
          </Button>
        </div>
      )}
      {sheet !== null && (
        <ModelSheet
          key={opened}
          model={sheetModel}
          list={list}
          timeZone={timeZone}
          open={open}
          onOpenChange={setOpen}
          finalFocus={finalFocus}
          onDone={(next, model) => {
            setNotice(next);
            focusTo.current = model;
            changedFrom.current = list;
          }}
        />
      )}
    </div>
  );
}
