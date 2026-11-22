import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import {
  EllipsisIcon,
  LoaderCircleIcon,
  OctagonAlertIcon,
  PlusIcon,
  SparklesIcon,
} from "lucide-react";
import * as React from "react";

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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

type Dialogs =
  | { kind: "edit"; model: AiModel }
  | { kind: "add" }
  | { kind: "price-as"; model: AiModel }
  | { kind: "reset"; model: AiModel }
  | null;

/** A model's row of actions, named for the model. */
function RowMenu({
  model,
  onAction,
}: {
  model: AiModel;
  onAction: (dialog: NonNullable<Dialogs>) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Actions for ${model.model}`}
            className="relative after:absolute after:-inset-1.5"
          />
        }
      >
        <EllipsisIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-44">
        <DropdownMenuItem onClick={() => onAction({ kind: "edit", model })}>
          Edit price
        </DropdownMenuItem>
        {model.builtIn === null && (
          <DropdownMenuItem onClick={() => onAction({ kind: "price-as", model })}>
            Price as another model
          </DropdownMenuItem>
        )}
        {hasCustom(model) && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => onAction({ kind: "reset", model })}
            >
              Reset to built-in
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
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

/**
 * Edit price, or Add model: the four prices, and whether they apply to
 * every call (a correction) or from a day on (a price change: calls
 * before it keep the earlier price).
 */
function PriceForm({
  model,
  list,
  timeZone,
  onDone,
}: {
  /** The model to edit; none to add one. */
  model: AiModel | undefined;
  list: AiModelList;
  timeZone: string;
  onDone: () => void;
}) {
  const afterChange = useAfterChange();
  const rates = model?.price ?? model?.builtIn?.rates;
  const [draft, setDraft] = React.useState<Draft>(() => ({
    provider: model?.provider ?? "",
    model: model?.model ?? "",
    applies: model?.price === null || model === undefined ? "all" : "from",
    from: todayIn(timeZone),
    input: textOf(rates?.input),
    output: textOf(rates?.output),
    cacheRead: textOf(rates?.cacheRead),
    cacheWrite: textOf(rates?.cacheWrite),
  }));
  const [checked, setChecked] = React.useState(false);
  const id = React.useId();
  const known = React.useMemo(() => new Set(list.models.map((item) => item.model)), [list]);
  const save = useMutation({
    mutationFn: () =>
      setModelPrice({
        provider: draft.provider.trim(),
        model: draft.model.trim(),
        effectiveFrom: draft.applies === "from" ? draft.from : null,
        rates: ratesOf(draft),
      }),
    onSuccess: () => {
      afterChange();
      onDone();
    },
  });
  const problems = problemsOf(draft, list.limits, model === undefined, known);
  const valid = Object.keys(problems).length === 0;
  const errorOf = (field: FieldName) => (checked ? (problems[field] ?? null) : null);
  const change = (next: Partial<Draft>) => {
    setDraft((previous) => ({ ...previous, ...next }));
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

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setChecked(true);
        if (valid && !save.isPending) save.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle className="min-w-0 [overflow-wrap:anywhere]">
          {model === undefined ? "Add a model" : `Edit the price of ${model.model}`}
        </DialogTitle>
        <DialogDescription>
          USD per million tokens.{model === undefined ? "" : ` Covers ${coversText(model)}.`}
        </DialogDescription>
      </DialogHeader>
      {model === undefined && (
        <div className="grid gap-4 sm:grid-cols-2">
          {textField("provider", "Provider", "openai")}
          {textField("model", "Model ID", "llama-3.3-70b")}
        </div>
      )}
      <div className="grid grid-cols-2 gap-4">
        {RATE_FIELDS.map(({ field, label, optional }) => (
          <Field key={field} data-invalid={errorOf(field) !== null || undefined}>
            <FieldLabel htmlFor={fieldId(field)}>{label}</FieldLabel>
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
              <FieldDescription>A price change: earlier calls keep their price.</FieldDescription>
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
              className="w-44"
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
          {model === undefined ? "Add model" : "Save price"}
        </Button>
      </DialogFooter>
    </form>
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
  onDone: () => void;
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
      onDone();
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
function ResetForm({ model, onDone }: { model: AiModel; onDone: () => void }) {
  const afterChange = useAfterChange();
  const reset = useMutation({
    mutationFn: () => resetModel(model.model),
    onSuccess: () => {
      afterChange();
      onDone();
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

/** The open dialog, mounted only while open, so each opening starts from the model. */
function ModelDialog({
  dialog,
  list,
  timeZone,
  onClose,
}: {
  dialog: Dialogs;
  list: AiModelList;
  timeZone: string;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={dialog !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        {dialog?.kind === "edit" && (
          <PriceForm model={dialog.model} list={list} timeZone={timeZone} onDone={onClose} />
        )}
        {dialog?.kind === "add" && (
          <PriceForm model={undefined} list={list} timeZone={timeZone} onDone={onClose} />
        )}
        {dialog?.kind === "price-as" && (
          <PriceAsForm model={dialog.model} list={list} onDone={onClose} />
        )}
        {dialog?.kind === "reset" && <ResetForm model={dialog.model} onDone={onClose} />}
      </DialogContent>
    </Dialog>
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
  onAction,
}: {
  list: AiModelList;
  models: AiModel[];
  timeZone: string;
  onAction: (dialog: NonNullable<Dialogs>) => void;
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
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {models.map((model) => {
            const later = upcoming(model, list.now);
            return (
              <TableRow key={model.model}>
                <TableCell className={cn("max-w-64 min-w-40", PINNED)}>
                  <TruncatedText text={model.model} className="font-mono text-sm" />
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
                <TableCell className="min-w-56 text-sm whitespace-normal">
                  {sourceText(model, timeZone)}
                  {(model.covers?.ids.length ?? 0) > 1 && (
                    <span className="block text-ink-subtle">Covers {coversText(model)}</span>
                  )}
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
                <TableCell className="w-10">
                  <RowMenu model={model} onAction={onAction} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </ScrollHint>
  );
}

/**
 * The AI models tab of the instance's Settings, for the owner and admins
 * (docs/dashboard.md, "AI models"): every model the instance's apps
 * called in the last 30 days and every built-in one, each with its price
 * and where it comes from; Edit price, Price as another model, Reset to
 * built-in, and Add model, each a dialog. `?show=no-price` lists only the
 * models without a price, as the AI page's link opens it.
 */
export function AiModelsTab({ timeZone }: InstanceTabProps) {
  const list = useQuery(aiModelsQuery());
  const [show, setShow] = useSearchParam("show");
  const [dialog, setDialog] = React.useState<Dialogs>(null);
  const noPriceOnly = show === NO_PRICE;

  return (
    <SettingsSection
      title="AI models"
      description="Prices are USD per million tokens. Changes apply to the AI page and AI cost alerts."
      wide
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
          onAction={setDialog}
        />
      )}
      {list.isSuccess && (
        <ModelDialog
          dialog={dialog}
          list={list.data}
          timeZone={timeZone}
          onClose={() => setDialog(null)}
        />
      )}
    </SettingsSection>
  );
}

function ModelsList({
  list,
  noPriceOnly,
  onShow,
  timeZone,
  onAction,
}: {
  list: AiModelList;
  noPriceOnly: boolean;
  onShow: (noPriceOnly: boolean) => void;
  timeZone: string;
  onAction: (dialog: NonNullable<Dialogs>) => void;
}) {
  const unpriced = list.models.filter((model) => model.price === null);
  const models = noPriceOnly ? unpriced : list.models;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
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
        <Button size="sm" onClick={() => onAction({ kind: "add" })}>
          <PlusIcon aria-hidden="true" />
          Add model
        </Button>
      </div>
      {!list.callsCounted && (
        <p className="text-sm text-ink-subtle">
          Calls could not be counted right now. Prices can still be changed.
        </p>
      )}
      {models.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SparklesIcon />
            </EmptyMedia>
            <EmptyTitle>Every model has a price</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <ModelsTable list={list} models={models} timeZone={timeZone} onAction={onAction} />
      )}
    </div>
  );
}
