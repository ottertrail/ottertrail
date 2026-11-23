import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { SettingsSection } from "@/components/settings-section";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useDirtyForm } from "@/hooks/use-dirty-form";
import {
  type LocationSource,
  type Project,
  projectQuery,
  projectsQuery,
  updateProject,
} from "@/lib/projects-api";

const SOURCES: { value: LocationSource; label: string; hint: string }[] = [
  {
    value: "database",
    label: "Location database",
    hint: "Looks up each visitor's address in DB-IP's database on this server.",
  },
  {
    value: "headers",
    label: "Proxy headers",
    hint: "Reads the country, region, and city from headers your proxy or CDN adds.",
  },
  { value: "off", label: "Off", hint: "Stores no location." },
];

const isSource = (value: unknown): value is LocationSource =>
  SOURCES.some((choice) => choice.value === value);

interface LocationValues {
  source: LocationSource;
  country: string;
  region: string;
  city: string;
}

const valuesOf = (project: Project): LocationValues => ({
  source: project.locationSource,
  country: project.locationHeaders.country ?? "",
  region: project.locationHeaders.region ?? "",
  city: project.locationHeaders.city ?? "",
});

/** As the API stores a header name: trimmed, lower case, null for none. */
const headerName = (text: string) => {
  const name = text.trim().toLowerCase();
  return name === "" ? null : name;
};

const HEADER_FIELDS = [
  { key: "country", label: "Country header", placeholder: "x-visitor-country" },
  { key: "region", label: "Region header (optional)", placeholder: "x-visitor-region" },
  { key: "city", label: "City header (optional)", placeholder: "x-visitor-city" },
] as const;

/** Where the project's visitor locations come from (docs/web-analytics.md, "Locations"). */
export function LocationSettings({
  project,
  onDirty,
}: {
  project: Project;
  onDirty: (dirty: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const form = useDirtyForm<LocationValues>(valuesOf(project), {
    key: project.id,
    normalize: {
      country: (text) => headerName(text) ?? "",
      region: (text) => headerName(text) ?? "",
      city: (text) => headerName(text) ?? "",
    },
  });
  React.useEffect(() => onDirty(form.dirty), [onDirty, form.dirty]);
  const save = useMutation({
    mutationFn: (values: LocationValues) =>
      updateProject(project.id, {
        locationSource: values.source,
        locationHeaders: {
          country: headerName(values.country),
          region: headerName(values.region),
          city: headerName(values.city),
        },
      }),
    onSuccess: (updated) => {
      form.saved(valuesOf(updated));
      queryClient.setQueryData(projectQuery(project.id).queryKey, updated);
      void queryClient.invalidateQueries({ queryKey: projectsQuery().queryKey, exact: true });
    },
  });
  const name = React.useId();
  const legendId = React.useId();
  const trustId = React.useId();

  return (
    <SettingsSection
      title="Location data"
      form={form}
      onSave={(values) => save.mutate(values)}
      saving={save.isPending}
      error={save.error?.message}
      saveLabel="Save location data"
      className="border-t"
    >
      <fieldset className="flex flex-col gap-3">
        <legend id={legendId} className="mb-3 text-sm font-medium text-ink">
          Where locations come from
        </legend>
        <RadioGroup
          name="locationSource"
          aria-labelledby={legendId}
          value={form.values.source}
          disabled={save.isPending}
          onValueChange={(value) => {
            if (isSource(value)) form.set("source", value);
          }}
          className="gap-3"
        >
          {SOURCES.map((choice) => (
            <Field key={choice.value} orientation="horizontal" className="items-start">
              <RadioGroupItem
                value={choice.value}
                id={`${name}-${choice.value}`}
                aria-describedby={`${name}-${choice.value}-hint`}
                className="mt-0.5"
              />
              <FieldContent>
                <FieldLabel htmlFor={`${name}-${choice.value}`}>{choice.label}</FieldLabel>
                <FieldDescription id={`${name}-${choice.value}-hint`}>
                  {choice.hint}
                </FieldDescription>
              </FieldContent>
            </Field>
          ))}
        </RadioGroup>
      </fieldset>
      {form.values.source === "headers" && (
        <FieldGroup>
          <p id={trustId} className="text-sm text-muted-foreground">
            The headers are read only from requests that come through a proxy listed in{" "}
            <code className="font-mono">OTTERTRAIL_TRUSTED_PROXIES</code>.
          </p>
          {HEADER_FIELDS.map((field) => (
            <Field key={field.key}>
              <FieldLabel htmlFor={`${name}-${field.key}`}>{field.label}</FieldLabel>
              <Input
                id={`${name}-${field.key}`}
                name={`${field.key}Header`}
                value={form.values[field.key]}
                onChange={(event) => form.set(field.key, event.target.value)}
                placeholder={field.placeholder}
                required={field.key === "country"}
                maxLength={64}
                pattern="[A-Za-z0-9\-]+"
                autoComplete="off"
                spellCheck={false}
                aria-describedby={field.key === "country" ? trustId : undefined}
                className="max-w-xs font-mono"
              />
            </Field>
          ))}
        </FieldGroup>
      )}
    </SettingsSection>
  );
}
