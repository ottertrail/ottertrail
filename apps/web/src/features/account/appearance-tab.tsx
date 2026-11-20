import * as React from "react";

import { SettingsSection } from "@/components/settings-section";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { isThemeChoice, setThemeChoice, type ThemeChoice, useTheme } from "@/lib/theme";

const THEME_OPTIONS: { value: ThemeChoice; label: string; hint: string }[] = [
  {
    value: "system",
    label: "System",
    hint: "Light or dark as this device is set, and as it changes.",
  },
  { value: "light", label: "Light", hint: "Dark text on light surfaces." },
  { value: "dark", label: "Dark", hint: "Light text on a near-black canvas." },
];

/**
 * The Appearance tab: the theme, System, Light or Dark. A choice applies at
 * once and has no Save bar: it is kept on this device (localStorage), and
 * nothing goes to the server (docs/design-system.md, "The save rule").
 */
export function AppearanceTab() {
  const { choice } = useTheme();
  const id = React.useId();
  return (
    <SettingsSection
      title="Theme"
      description="Saved on this device only, at once. Other devices and browsers keep their own."
    >
      <RadioGroup
        name="theme"
        aria-label="Theme"
        value={choice}
        onValueChange={(value) => {
          if (isThemeChoice(value)) setThemeChoice(value);
        }}
        className="gap-3"
      >
        {THEME_OPTIONS.map((option) => (
          <Field key={option.value} orientation="horizontal" className="items-start">
            <RadioGroupItem
              value={option.value}
              id={`${id}-${option.value}`}
              aria-describedby={`${id}-${option.value}-hint`}
              className="mt-0.5"
            />
            <FieldContent>
              <FieldLabel htmlFor={`${id}-${option.value}`}>{option.label}</FieldLabel>
              <FieldDescription id={`${id}-${option.value}-hint`}>{option.hint}</FieldDescription>
            </FieldContent>
          </Field>
        ))}
      </RadioGroup>
    </SettingsSection>
  );
}
