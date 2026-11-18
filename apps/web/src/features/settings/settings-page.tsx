import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircleIcon, OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { formText } from "@/lib/form";
import { type Settings, settingsQuery, updateSettings } from "@/lib/settings-api";

/**
 * Timezone names to suggest while typing. The browser's list leaves out
 * "UTC", which most installs start with, so it is added. The API
 * checks whatever is typed and stores its official name.
 */
const TIME_ZONES = ["UTC", ...Intl.supportedValuesOf("timeZone")];

function SettingsCard({ settings }: { settings: Settings }) {
  const queryClient = useQueryClient();
  const isOwner = settings.canEdit;
  const [timeZone, setTimeZone] = React.useState(settings.timeZone);
  const movesDays = timeZone.trim() !== "" && timeZone.trim() !== settings.timeZone;
  const save = useMutation({
    mutationFn: (changes: { name: string; timeZone: string }) => updateSettings(changes),
    onSuccess: (updated) => {
      queryClient.setQueryData(settingsQuery().queryKey, updated);
      setTimeZone(updated.timeZone);
      // Every page counts days in the timezone: everything shown but the
      // settings themselves may change.
      void queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] !== settingsQuery().queryKey[0],
      });
    },
  });

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    save.mutate({ name: formText(form, "name"), timeZone: timeZone.trim() });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>Workspace</h3>
        </CardTitle>
        <CardDescription>
          {isOwner
            ? "The name and timezone of this install, for all its projects."
            : "Only the owner can change these."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* Remounts with the saved values, so the form shows what the API stored. */}
        <form key={JSON.stringify([settings.name, settings.timeZone])} onSubmit={submit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="settings-name">Name</FieldLabel>
              <Input
                id="settings-name"
                name="name"
                defaultValue={settings.name}
                required
                maxLength={100}
                autoComplete="off"
                disabled={!isOwner}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="settings-time-zone">Timezone</FieldLabel>
              <Input
                id="settings-time-zone"
                name="timeZone"
                value={timeZone}
                onChange={(event) => setTimeZone(event.target.value)}
                list="settings-time-zones"
                required
                maxLength={100}
                autoComplete="off"
                spellCheck={false}
                disabled={!isOwner}
                className="w-72"
                aria-describedby="settings-time-zone-hint"
              />
              <datalist id="settings-time-zones">
                {TIME_ZONES.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </datalist>
              <FieldDescription id="settings-time-zone-hint">
                {movesDays
                  ? "Changing it moves where days start in every report, past days included. Visitors seen before the change count again after it, until midnight."
                  : "Reports count days in this timezone. A name such as Europe/Berlin or Asia/Singapore."}
              </FieldDescription>
            </Field>
            {save.error !== null && (
              <Alert variant="destructive" role="alert">
                <OctagonAlertIcon />
                <AlertDescription>{save.error.message}</AlertDescription>
              </Alert>
            )}
            {isOwner && (
              <div className="flex items-center gap-3">
                <Button type="submit" disabled={save.isPending}>
                  {save.isPending && (
                    <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
                  )}
                  Save changes
                </Button>
                {save.isSuccess && (
                  <output className="text-sm text-ink-muted" aria-live="polite">
                    Saved.
                  </output>
                )}
              </div>
            )}
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}

/** The instance's settings: /settings. Everyone signed in sees them; the owner changes them. */
export function SettingsPage() {
  const settings = useQuery(settingsQuery());

  if (settings.isPending) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6" aria-busy="true">
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (settings.isError) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Alert variant="destructive">
          <OctagonAlertIcon />
          <AlertTitle>The settings could not load</AlertTitle>
          <AlertDescription>{settings.error.message}</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={() => void settings.refetch()}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      </div>
    );
  }
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <SettingsCard settings={settings.data} />
    </div>
  );
}
