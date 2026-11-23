import * as React from "react";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Base UI requires a value for the no-filter item. */
const ANY = "\u0000any";

/** Keep a selected value available even if the API stops listing it, so the filter can be removed. */
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

/** Apply on Enter, blur, or clear to avoid a request per keystroke. */
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
  pattern?: RegExp;
  invalidMessage?: string;
  className?: string;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [text, setText] = React.useState(value ?? "");
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
