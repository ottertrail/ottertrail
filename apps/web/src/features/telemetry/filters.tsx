import * as React from "react";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** The select's value for "no filter": Base UI's select needs a value for each item. */
const ANY = "\u0000any";

/**
 * A select with "Any …" first, then the choices; `value` undefined is any.
 * The value shown stays a choice even when the API no longer lists it, so
 * the filter can be seen and undone.
 */
export function ChoiceFilter({
  label,
  anyLabel,
  choices,
  value,
  onChange,
  className = "w-44",
}: {
  label: string;
  anyLabel: string;
  choices: readonly { value: string; label: string }[];
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  className?: string;
}) {
  const items = [
    { value: ANY, label: anyLabel },
    ...choices,
    ...(value !== undefined && !choices.some((choice) => choice.value === value)
      ? [{ value, label: value }]
      : []),
  ];
  return (
    <Select
      items={items}
      value={value ?? ANY}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next === ANY ? undefined : next);
      }}
    >
      <SelectTrigger aria-label={label} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Text that filters when Enter is pressed or the field is left, and at
 * once when it is emptied: not on every key, which would send a request
 * per letter.
 */
export function TextFilter({
  label,
  placeholder,
  value,
  onChange,
  maxLength = 200,
  pattern,
  invalidMessage,
  className = "w-56",
}: {
  label: string;
  placeholder: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  maxLength?: number;
  /** What the text must match, whole; anything else is not applied, and the field says why. */
  pattern?: RegExp;
  invalidMessage?: string;
  className?: string;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [text, setText] = React.useState(value ?? "");
  // A new address (Back, a link) shows its own filter.
  const [shown, setShown] = React.useState(value);
  if (shown !== value) {
    setShown(value);
    setText(value ?? "");
  }
  const apply = (next: string, report: boolean) => {
    const trimmed = next.trim();
    const wanted = trimmed === "" ? undefined : trimmed;
    const valid = wanted === undefined || pattern === undefined || pattern.test(wanted);
    inputRef.current?.setCustomValidity(valid ? "" : (invalidMessage ?? "Not a valid value."));
    if (!valid) {
      if (report) inputRef.current?.reportValidity();
      return;
    }
    if (wanted !== value) onChange(wanted);
  };
  return (
    <search aria-label={label}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          apply(text, true);
        }}
      >
        <Input
          ref={inputRef}
          type="search"
          value={text}
          maxLength={maxLength}
          onChange={(event) => {
            setText(event.target.value);
            inputRef.current?.setCustomValidity("");
            if (event.target.value === "") apply("", false);
          }}
          onBlur={() => apply(text, false)}
          placeholder={placeholder}
          aria-label={label}
          autoComplete="off"
          className={className}
        />
      </form>
    </search>
  );
}
