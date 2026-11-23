import * as React from "react";

import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";

/** Add UTC because the browser list omits it. The API validates and canonicalizes names. */
const TIME_ZONES = [...new Set(["UTC", ...Intl.supportedValuesOf("timeZone")])];

/** Lowercase, with underscores as spaces, so "new york" finds America/New_York. */
function normalize(text: string) {
  return text.toLowerCase().replaceAll("_", " ").replace(/\s+/g, " ").trim();
}

/** Whether a timezone's name contains the query anywhere. */
function timeZoneMatches(zone: string, query: string) {
  return normalize(zone).includes(normalize(query));
}

/**
 * The timezone's offset from UTC at a time, such as "UTC+8" or "UTC-3:30";
 * null for a name the browser does not know.
 */
function utcOffset(zone: string, at: Date) {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" })
      .formatToParts(at)
      .find((item) => item.type === "timeZoneName");
    return part === undefined ? null : part.value.replace(/^GMT/, "UTC");
  } catch {
    return null;
  }
}

export function TimezoneCombobox({
  id,
  name,
  value,
  onValueChange,
  required,
  className,
  "aria-describedby": describedBy,
}: {
  id: string;
  name: string;
  /** The chosen name; "" for none. */
  value: string;
  onValueChange: (value: string) => void;
  required?: boolean;
  className?: string;
  "aria-describedby"?: string;
}) {
  // A saved or browser timezone missing from the list (an older alias) is still shown.
  const items = React.useMemo(
    () => (value === "" || TIME_ZONES.includes(value) ? TIME_ZONES : [value, ...TIME_ZONES]),
    [value],
  );
  // Offsets as of when the field appeared: a switch to or from summer time
  // while the page is open is not worth re-rendering for.
  const [now] = React.useState(() => new Date());
  const offsets = React.useMemo(
    () => new Map(items.map((zone) => [zone, utcOffset(zone, now)])),
    [items, now],
  );

  return (
    <Combobox
      items={items}
      value={value === "" ? null : value}
      onValueChange={(next) => onValueChange(next ?? "")}
      filter={timeZoneMatches}
      name={name}
      required={required}
      autoHighlight
    >
      <ComboboxInput
        id={id}
        className={className}
        triggerLabel="Show timezones"
        placeholder="Search timezones"
        autoComplete="off"
        spellCheck={false}
        aria-describedby={describedBy}
      />
      <ComboboxContent>
        <ComboboxEmpty>No matching timezone</ComboboxEmpty>
        <ComboboxList>
          {(zone: string) => {
            const offset = offsets.get(zone);
            return (
              <ComboboxItem key={zone} value={zone}>
                {/* Wrapped, not cut off: a tooltip would not show on a highlighted option. */}
                <span className="min-w-0 break-words">
                  {zone}
                  {offset !== null && offset !== undefined && (
                    <span className="text-muted-foreground"> ({offset})</span>
                  )}
                </span>
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
