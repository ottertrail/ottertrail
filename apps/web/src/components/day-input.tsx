import type * as React from "react";

import { Input } from "@/components/ui/input";
import { DAY_PLACEHOLDER, maskDay } from "@/features/analytics/day-text";

/**
 * One typed day: digits only, the slashes come by themselves (maskDay). The
 * field's text and cursor are set within the same event that changed them,
 * so no keystroke is lost however fast they come. The custom range dialog
 * and `DateField` both use it.
 */
export function DayInput({
  text,
  onTextChange,
  invalid = false,
  ...input
}: {
  text: string;
  onTextChange: (text: string) => void;
  invalid?: boolean;
} & Omit<React.ComponentProps<typeof Input>, "value" | "onChange" | "aria-invalid">) {
  return (
    <Input
      {...input}
      value={text}
      onChange={(event) => {
        const field = event.currentTarget;
        const masked = maskDay(field.value, field.selectionStart ?? field.value.length);
        // Before React renders: the text then already matches, so React
        // leaves the field, and its cursor, alone.
        field.value = masked.text;
        field.setSelectionRange(masked.cursor, masked.cursor);
        onTextChange(masked.text);
      }}
      onKeyDown={(event) => {
        // Backspace right after a slash deletes the digit before it, and
        // Delete right before one the digit after it: the slash alone would
        // only come back.
        const field = event.currentTarget;
        const at = field.selectionStart ?? 0;
        if (at === field.selectionEnd) {
          if (event.key === "Backspace" && field.value[at - 1] === "/") {
            field.setSelectionRange(at - 1, at - 1);
          } else if (event.key === "Delete" && field.value[at] === "/") {
            field.setSelectionRange(at + 1, at + 1);
          }
        }
        input.onKeyDown?.(event);
      }}
      placeholder={DAY_PLACEHOLDER}
      inputMode="numeric"
      autoComplete="off"
      aria-invalid={invalid || undefined}
    />
  );
}
