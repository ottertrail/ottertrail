import { useInfiniteQuery } from "@tanstack/react-query";
import { XIcon } from "lucide-react";
import * as React from "react";

import { TruncatedText } from "@/components/truncated-text";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTitle } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSettled } from "@/hooks/use-settled";
import {
  type Filter,
  FILTER_NAMES,
  FILTERS,
  type FilterName,
  isFilterName,
  isFilterValue,
  isTextOperator,
  MAX_FILTER_VALUES,
  OPERATOR_LABELS,
  type Operator,
  operatorsOf,
  withFilter,
} from "@/lib/analytics-api";
import { listQuery } from "@/lib/analytics-queries";

import { filterValueText, type PageSearch, valueText } from "./list-rows";
import { useAnalyticsScope } from "./scope";

/*
 * The filter editor (docs/dashboard.md, "Filters"): it changes a filter's
 * operator and values, and Apply puts them in the address. Its own chunk,
 * with the combobox and the selects, loads when Filter or a chip first
 * opens (filter-editor.tsx), so a first visit, on a shared link too, does
 * not download it.
 */

const isOperator = (value: unknown): value is Operator =>
  typeof value === "string" && Object.hasOwn(OPERATOR_LABELS, value);

/** The values a list offers for is and is not, searched in the API as Show all is. */
function ValuePicker({
  search,
  name,
  values,
  onValues,
}: {
  search: PageSearch;
  name: FilterName;
  values: readonly string[];
  onValues: (values: string[]) => void;
}) {
  const { source } = useAnalyticsScope();
  const [typed, setTyped] = React.useState("");
  const settled = useSettled(typed.trim(), 250);
  // The other filters apply, so a value that this one hides is still offered.
  const others = search.filters.filter((filter) => filter.name !== name);
  const list = useInfiniteQuery(
    listQuery(source, search.range, others, search.environment, FILTERS[name].list, settled),
  );
  const found = (list.data?.pages[0]?.rows ?? []).map((row) => row.name ?? "");
  const items = [...new Set([...values, ...found])];
  const full = values.length >= MAX_FILTER_VALUES;
  return (
    <Combobox<string, true>
      multiple
      items={items}
      value={[...values]}
      // The API searches; the text a row shows (a country's name) is matched there too.
      filter={null}
      itemToStringLabel={(value) => valueText(name, value)}
      inputValue={typed}
      onInputValueChange={(value, details) => {
        if (details.reason !== "item-press") setTyped(value);
      }}
      onValueChange={(next) => {
        onValues(next.slice(0, MAX_FILTER_VALUES));
        setTyped("");
      }}
      autoHighlight
    >
      <ComboboxInput
        aria-label={`Search ${FILTERS[name].label.toLowerCase()} values`}
        triggerLabel="Show values"
        placeholder="Search values"
        autoComplete="off"
        spellCheck={false}
      />
      <ComboboxContent>
        <ComboboxEmpty>{list.isFetching ? "Searching…" : "No value in this period"}</ComboboxEmpty>
        <ComboboxList>
          {(item: string) => (
            <ComboboxItem key={item} value={item} disabled={full && !values.includes(item)}>
              <span
                className={item === "" ? "min-w-0 break-all text-ink-subtle" : "min-w-0 break-all"}
              >
                {valueText(name, item)}
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

/** Typed text for contains and does not contain. Enter adds it, as the Add button does. */
function TextValue({
  values,
  onValues,
}: {
  values: readonly string[];
  onValues: (values: string[]) => void;
}) {
  const [typed, setTyped] = React.useState("");
  const text = typed.trim();
  const canAdd =
    text !== "" &&
    isFilterValue("contains", text) &&
    !values.includes(text) &&
    values.length < MAX_FILTER_VALUES;
  const add = () => {
    if (!canAdd) return;
    onValues([...values, text]);
    setTyped("");
  };
  return (
    <div className="flex gap-2">
      <Input
        aria-label="Text to look for"
        placeholder="Text to look for"
        value={typed}
        maxLength={200}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setTyped(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            add();
          }
        }}
      />
      <Button type="button" variant="outline" disabled={!canAdd} onClick={add}>
        Add
      </Button>
    </div>
  );
}

/**
 * Adds a filter, or edits `filter`: its name (when adding), its operator,
 * and its values. Values that the new operator cannot take are dropped,
 * such as Unknown under contains.
 */
export function FilterForm({
  search,
  filter,
  onDone,
}: {
  search: PageSearch;
  filter: Filter | undefined;
  onDone: () => void;
}) {
  const scope = useAnalyticsScope();
  const [name, setName] = React.useState<FilterName | undefined>(filter?.name);
  const [operator, setOperator] = React.useState<Operator>(filter?.operator ?? "is");
  const [values, setValues] = React.useState<readonly string[]>(filter?.values ?? []);
  const draft = name === undefined ? undefined : { name, operator, values };
  const apply = () => {
    if (draft === undefined || values.length === 0) return;
    // One filter per name and operator: an existing one takes these values too.
    const existing = search.filters.find(
      (item) => item !== filter && item.name === draft.name && item.operator === draft.operator,
    );
    const merged =
      existing === undefined
        ? draft
        : {
            ...draft,
            values: [...new Set([...existing.values, ...values])].slice(0, MAX_FILTER_VALUES),
          };
    scope.show({ ...search, filters: withFilter(search.filters, merged, filter) });
    onDone();
  };
  const changeOperator = (next: Operator) => {
    setOperator(next);
    setValues((current) => current.filter((value) => isFilterValue(next, value)));
  };
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
    >
      <PopoverTitle>{filter === undefined ? "Add a filter" : "Edit the filter"}</PopoverTitle>
      <div className="flex flex-wrap gap-2">
        {filter === undefined ? (
          <Select
            value={name ?? null}
            onValueChange={(next) => {
              if (typeof next !== "string" || !isFilterName(next)) return;
              setName(next);
              setValues([]);
              if (!operatorsOf(next).includes(operator)) setOperator("is");
            }}
            items={FILTER_NAMES.map((item) => ({ value: item, label: FILTERS[item].label }))}
          >
            <SelectTrigger aria-label="Filter by" className="min-w-0 flex-1">
              <SelectValue placeholder="Choose what to filter" />
            </SelectTrigger>
            <SelectContent>
              {FILTER_NAMES.map((item) => (
                <SelectItem key={item} value={item}>
                  {FILTERS[item].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <p className="flex h-8 items-center text-sm font-medium">{FILTERS[filter.name].label}</p>
        )}
        {name !== undefined && (
          <Select
            value={operator}
            onValueChange={(next) => {
              if (isOperator(next)) changeOperator(next);
            }}
            items={operatorsOf(name).map((item) => ({ value: item, label: OPERATOR_LABELS[item] }))}
          >
            <SelectTrigger aria-label="Operator">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {operatorsOf(name).map((item) => (
                <SelectItem key={item} value={item}>
                  {OPERATOR_LABELS[item]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {draft !== undefined && (
        <>
          {values.length > 0 && (
            <ul aria-label="Values" className="flex flex-wrap gap-1.5">
              {values.map((value) => {
                const text = filterValueText(draft, value);
                return (
                  <li
                    key={value}
                    className="inline-flex max-w-full items-center gap-0.5 rounded-md bg-muted py-0.5 pr-0.5 pl-2 text-sm"
                  >
                    <TruncatedText text={text} />
                    <button
                      type="button"
                      aria-label={`Remove ${text}`}
                      className="rounded p-1 text-ink-subtle hover:bg-background/60 hover:text-ink"
                      onClick={() => setValues(values.filter((item) => item !== value))}
                    >
                      <XIcon aria-hidden="true" className="size-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {isTextOperator(operator) ? (
            <TextValue values={values} onValues={setValues} />
          ) : (
            <ValuePicker search={search} name={draft.name} values={values} onValues={setValues} />
          )}
          <p className="text-xs text-ink-subtle">
            {values.length >= MAX_FILTER_VALUES
              ? `A filter holds at most ${MAX_FILTER_VALUES} values.`
              : isTextOperator(operator)
                ? "Matches any of these, ignoring case."
                : "Matches any of these."}
          </p>
        </>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={draft === undefined || values.length === 0}>
          Apply
        </Button>
      </div>
    </form>
  );
}

/**
 * The editor in its popover, under the button that opened it
 * (filter-editor.tsx), which takes the focus back when it closes.
 */
export function FilterPopover({
  open,
  onOpenChange,
  anchor,
  search,
  filter,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchor: React.RefObject<HTMLButtonElement | null>;
  search: PageSearch;
  filter: Filter | undefined;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverContent
        align="start"
        anchor={anchor}
        finalFocus={anchor}
        className="w-[min(24rem,calc(100vw-2rem))]"
      >
        {open && <FilterForm search={search} filter={filter} onDone={() => onOpenChange(false)} />}
      </PopoverContent>
    </Popover>
  );
}
