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
import { type Organization, organizationsQuery, updateOrganization } from "@/lib/organizations-api";

/**
 * Timezone names to suggest while typing. The browser's list leaves out
 * "UTC", which most organizations start with, so it is added. The API
 * checks whatever is typed and stores its official name.
 */
const TIME_ZONES = ["UTC", ...Intl.supportedValuesOf("timeZone")];

function OrganizationCard({ organization }: { organization: Organization }) {
  const queryClient = useQueryClient();
  const isOwner = organization.role === "owner";
  const [timeZone, setTimeZone] = React.useState(organization.timeZone);
  const movesDays = timeZone.trim() !== "" && timeZone.trim() !== organization.timeZone;
  const save = useMutation({
    mutationFn: (changes: { name: string; timeZone: string }) =>
      updateOrganization(organization.id, changes),
    onSuccess: (updated) => {
      queryClient.setQueryData(organizationsQuery().queryKey, (previous) =>
        previous?.map((item) => (item.id === updated.id ? updated : item)),
      );
      setTimeZone(updated.timeZone);
      // Reports count days in the timezone: everything shown may change.
      void queryClient.invalidateQueries({ queryKey: ["analytics"] });
      void queryClient.invalidateQueries({ queryKey: ["analytics-list"] });
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
          <h3>Organization</h3>
        </CardTitle>
        <CardDescription>
          {isOwner
            ? "Your projects belong to this organization."
            : "Only the organization's owner can change these."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* Remounts with the saved values, so the form shows what the API stored. */}
        <form key={JSON.stringify([organization.name, organization.timeZone])} onSubmit={submit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="organization-name">Name</FieldLabel>
              <Input
                id="organization-name"
                name="name"
                defaultValue={organization.name}
                required
                maxLength={100}
                autoComplete="organization"
                disabled={!isOwner}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="organization-time-zone">Timezone</FieldLabel>
              <Input
                id="organization-time-zone"
                name="timeZone"
                value={timeZone}
                onChange={(event) => setTimeZone(event.target.value)}
                list="organization-time-zones"
                required
                maxLength={100}
                autoComplete="off"
                spellCheck={false}
                disabled={!isOwner}
                className="w-72"
                aria-describedby="organization-time-zone-hint"
              />
              <datalist id="organization-time-zones">
                {TIME_ZONES.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </datalist>
              <FieldDescription id="organization-time-zone-hint">
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

/**
 * The organization's settings: /settings. Users belong to one organization
 * until invitations exist, so this shows the first one.
 */
export function OrganizationSettingsPage() {
  const organizations = useQuery(organizationsQuery());

  if (organizations.isPending) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6" aria-busy="true">
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (organizations.isError) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Alert variant="destructive">
          <OctagonAlertIcon />
          <AlertTitle>The organization could not load</AlertTitle>
          <AlertDescription>{organizations.error.message}</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={() => void organizations.refetch()}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      </div>
    );
  }
  const [organization] = organizations.data;
  if (organization === undefined) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Alert>
          <OctagonAlertIcon />
          <AlertTitle>No organization</AlertTitle>
          <AlertDescription>
            Your account belongs to no organization yet, so there are no settings to show.
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <OrganizationCard organization={organization} />
    </div>
  );
}
