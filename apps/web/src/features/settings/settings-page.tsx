import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircleIcon, OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { NoAccess } from "@/components/no-access";
import { TimezoneCombobox } from "@/components/timezone-combobox";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { meQuery } from "@/lib/access";
import { formText } from "@/lib/form";
import { type Settings, settingsQuery, updateSettings } from "@/lib/settings-api";

import { NotificationChannelsCard } from "./notification-channels";

function SettingsCard({ settings }: { settings: Settings }) {
  const queryClient = useQueryClient();
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
          <h3>Instance</h3>
        </CardTitle>
        <CardDescription>
          The instance name and timezone apply to all projects. Only the owner can view and change
          them.
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
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="settings-time-zone">Timezone</FieldLabel>
              <TimezoneCombobox
                id="settings-time-zone"
                name="timeZone"
                value={timeZone}
                onValueChange={setTimeZone}
                required
                className="w-72"
                aria-describedby="settings-time-zone-hint"
              />
              <FieldDescription id="settings-time-zone-hint">
                {movesDays
                  ? "Changing the timezone changes day boundaries in all reports, including past reports. Visitors seen before the change count again after it until midnight."
                  : "Reports count days in this timezone. Use a name such as Europe/Berlin or Asia/Singapore."}
              </FieldDescription>
            </Field>
            {save.error !== null && (
              <Alert variant="destructive" role="alert">
                <OctagonAlertIcon />
                <AlertDescription>{save.error.message}</AlertDescription>
              </Alert>
            )}
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={save.isPending}>
                {save.isPending && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
                Save changes
              </Button>
              {save.isSuccess && (
                <output className="text-sm text-ink-muted" aria-live="polite">
                  Saved.
                </output>
              )}
            </div>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}

/** The instance's name and timezone, for the owner. */
function InstanceSettings() {
  const settings = useQuery(settingsQuery());

  if (settings.isPending) {
    return <Skeleton className="h-64 w-full" />;
  }
  if (settings.isError) {
    return (
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
    );
  }
  return <SettingsCard settings={settings.data} />;
}

/**
 * The instance's settings: /settings (docs/access.md). The owner changes
 * the name and timezone; the owner and admins manage the notification
 * channels. Members do not see the page.
 */
export function SettingsPage() {
  const me = useQuery(meQuery());

  if (me.isPending) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6" aria-busy="true">
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (me.isError) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Alert variant="destructive">
          <OctagonAlertIcon />
          <AlertTitle>The settings could not load</AlertTitle>
          <AlertDescription>{me.error.message}</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={() => void me.refetch()}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      </div>
    );
  }
  const { permissions, instance } = me.data;
  if (!permissions.settings && !permissions.channels) {
    return <NoAccess />;
  }
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      {permissions.settings && <InstanceSettings />}
      {permissions.channels && <NotificationChannelsCard timeZone={instance.timeZone} />}
    </div>
  );
}
