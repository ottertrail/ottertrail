import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircleIcon, OctagonAlertIcon, TriangleAlertIcon } from "lucide-react";
import * as React from "react";

import { CopyableCode } from "@/components/copyable-code";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api";
import { formText } from "@/lib/form";
import { type Project, projectQuery, updateProject } from "@/lib/projects-api";

import { DangerZone } from "./danger-zone";
import { hostnamesFromText, installSnippet, timeAgo } from "./format";
import { NoSuchProject } from "./no-such-project";

/** While waiting for the first event, check every few seconds. */
const STATUS_REFRESH_MS = 10_000;

function InstallCard({ project }: { project: Project }) {
  const snippet = installSnippet(window.location.origin, project.publicKey);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>Install</h3>
        </CardTitle>
        <CardDescription>
          Add this tag to every page of your site, in the{" "}
          <code className="font-mono">&lt;head&gt;</code>. It records pageviews and how long each
          page is visible, without cookies.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {project.allowedHostnames.length === 0 && (
          <Alert>
            <TriangleAlertIcon />
            <AlertTitle>No allowed sites yet</AlertTitle>
            <AlertDescription>
              Add your site&apos;s hostname under Settings first: events from sites that are not
              listed are refused.
            </AlertDescription>
          </Alert>
        )}
        <CopyableCode text={snippet} copyLabel="Copy the snippet" />
        <output aria-live="polite" className="flex flex-wrap items-center gap-2 text-sm">
          {project.lastEventAt === null ? (
            <>
              <StatusBadge
                tone="neutral"
                icon={<LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
              >
                Waiting for the first event
              </StatusBadge>
              <span className="text-ink-muted">
                Open your site in a browser after installing; this updates on its own.
              </span>
            </>
          ) : (
            <>
              <StatusBadge tone="good">Receiving events</StatusBadge>
              <span className="text-ink-muted">
                Last event {timeAgo(new Date(project.lastEventAt))}.
              </span>
            </>
          )}
        </output>
        <div className="flex flex-col gap-2 border-t pt-4">
          <h4 className="text-sm font-medium text-ink">Public key</h4>
          <CopyableCode text={project.publicKey} copyLabel="Copy the public key" />
          <p className="text-sm text-muted-foreground">
            Already part of the snippet. It only lets pages on the allowed sites send events; it
            cannot read anything.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/** How long a project keeps its events; "forever" is null, the default. */
const RETENTION_CHOICES = [
  { value: "forever", label: "Forever" },
  { value: "180", label: "6 months" },
  { value: "365", label: "1 year" },
  { value: "730", label: "2 years" },
  { value: "1825", label: "5 years" },
];

const retentionValue = (days: number | null) => (days === null ? "forever" : String(days));
const retentionDays = (value: string) => (value === "forever" ? null : Number(value));

function SettingsCard({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const saved = retentionValue(project.retentionDays);
  const choices = RETENTION_CHOICES.some((choice) => choice.value === saved)
    ? RETENTION_CHOICES
    : [...RETENTION_CHOICES, { value: saved, label: `${saved} days` }];
  const [retention, setRetention] = React.useState(saved);
  const chosenDays = retentionDays(retention);
  // A stricter limit than now deletes events: say so before saving.
  const deletes =
    chosenDays !== null && (project.retentionDays === null || chosenDays < project.retentionDays);
  const save = useMutation({
    mutationFn: (changes: {
      name: string;
      allowedHostnames: string[];
      retentionDays: number | null;
    }) => updateProject(project.id, changes),
    onSuccess: (updated) => {
      queryClient.setQueryData(projectQuery(project.id).queryKey, updated);
      void queryClient.invalidateQueries({ queryKey: ["projects"], exact: true });
    },
  });

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    save.mutate({
      name: formText(form, "name"),
      allowedHostnames: hostnamesFromText(formText(form, "hostnames")),
      retentionDays: retentionDays(retention),
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>Settings</h3>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {/* Remounts with the saved values, so the form shows what the API stored. */}
        <form
          key={JSON.stringify([project.name, project.allowedHostnames, project.retentionDays])}
          onSubmit={submit}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="settings-name">Name</FieldLabel>
              <Input
                id="settings-name"
                name="name"
                defaultValue={project.name}
                required
                maxLength={100}
                autoComplete="off"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="settings-hostnames">Allowed sites</FieldLabel>
              <Textarea
                id="settings-hostnames"
                name="hostnames"
                rows={4}
                defaultValue={project.allowedHostnames.join("\n")}
                placeholder={"example.com\nwww.example.com"}
                aria-describedby="settings-hostnames-hint"
              />
              <FieldDescription id="settings-hostnames-hint">
                One hostname per line. Each subdomain is separate: list www.example.com as well as
                example.com if both serve pages. Changes apply within a minute.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="settings-retention">Keep events</FieldLabel>
              <Select
                items={choices}
                value={retention}
                onValueChange={(value) => {
                  if (typeof value === "string") setRetention(value);
                }}
              >
                <SelectTrigger
                  id="settings-retention"
                  className="w-48"
                  aria-describedby="settings-retention-hint"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {choices.map((choice) => (
                    <SelectItem key={choice.value} value={choice.value}>
                      {choice.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription id="settings-retention-hint">
                {deletes
                  ? `Events older than ${choices.find((choice) => choice.value === retention)?.label.toLowerCase()} will be deleted for good within a few hours of saving, a whole day at a time.`
                  : "Older events are deleted for good, a whole day at a time. Forever keeps everything."}
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

/** A project's install snippet and settings: /projects/<id>/settings. */
export function ProjectSettingsPage({ projectId }: { projectId: string }) {
  const project = useQuery({
    ...projectQuery(projectId),
    refetchInterval: (query) =>
      query.state.data?.lastEventAt === null ? STATUS_REFRESH_MS : STATUS_REFRESH_MS * 6,
  });

  if (project.isPending) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6" aria-busy="true">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (project.isError) {
    if (project.error instanceof ApiError && project.error.status === 404) {
      return <NoSuchProject />;
    }
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Alert variant="destructive">
          <OctagonAlertIcon />
          <AlertTitle>The project could not load</AlertTitle>
          <AlertDescription>{project.error.message}</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={() => void project.refetch()}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <InstallCard project={project.data} />
      <SettingsCard project={project.data} />
      <DangerZone project={project.data} />
    </div>
  );
}
