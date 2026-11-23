import * as React from "react";

import { SettingsSection } from "@/components/settings-section";
import { Field, FieldContent, FieldLabel } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { isThemeChoice, setThemeChoice, type ThemeChoice, useTheme } from "@/lib/theme";

const THEME_OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** Apply the theme immediately and save it only in localStorage (docs/design-system.md, "The save rule"). */
export function AppearanceTab() {
  const { choice } = useTheme();
  const id = React.useId();
  return (
    <SettingsSection title="Theme" description="Applies immediately to this browser only.">
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
            <RadioGroupItem value={option.value} id={`${id}-${option.value}`} className="mt-0.5" />
            <FieldContent>
              <FieldLabel htmlFor={`${id}-${option.value}`}>{option.label}</FieldLabel>
            </FieldContent>
          </Field>
        ))}
      </RadioGroup>
    </SettingsSection>
  );
}
