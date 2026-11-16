import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ChartLineIcon,
  CheckIcon,
  CopyIcon,
  FolderXIcon,
  LoaderCircleIcon,
  OctagonAlertIcon,
  TriangleAlertIcon,
} from "lucide-react";
import * as React from "react";

import { ButtonLink } from "@/components/button-link";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api";
import { formText } from "@/lib/form";
import { type Project, projectQuery, updateProject } from "@/lib/projects-api";

import { hostnamesFromText, installSnippet, timeAgo } from "./format";

/** While waiting for the first event, check every few seconds. */
const STATUS_REFRESH_MS = 10_000;

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = React.useState(false);
  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }
  return (
    <Button variant="outline" size="sm" onClick={() => void copy()} aria-label={label}>
      {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

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
        <div className="flex items-start gap-2">
          <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed text-ink">
            <code>{snippet}</code>
          </pre>
          <CopyButton text={snippet} label="Copy the snippet" />
        </div>
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
      </CardContent>
    </Card>
  );
}

function SettingsCard({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (changes: { name: string; allowedHostnames: string[] }) =>
      updateProject(project.id, changes),
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
        <form key={JSON.stringify([project.name, project.allowedHostnames])} onSubmit={submit}>
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
              <FieldLabel htmlFor="settings-key">Public key</FieldLabel>
              <Input id="settings-key" value={project.publicKey} readOnly className="font-mono" />
              <FieldDescription>
                Part of the snippet. It only lets pages on the allowed sites send events; it cannot
                read anything.
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

export function ProjectPage({ projectId }: { projectId: string }) {
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
      return (
        <Empty className="m-6 border border-dashed p-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderXIcon />
            </EmptyMedia>
            <EmptyTitle>No such project</EmptyTitle>
            <EmptyDescription>It may have been removed, or the link is wrong.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <ButtonLink variant="outline" to="/projects">
              All projects
            </ButtonLink>
          </EmptyContent>
        </Empty>
      );
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
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link to="/projects" className="text-sm text-link hover:underline">
            All projects
          </Link>
          <h2 className="mt-1 text-lg font-semibold text-ink">{project.data.name}</h2>
        </div>
        <ButtonLink variant="outline" size="sm" to="/analytics/$projectId" params={{ projectId }}>
          <ChartLineIcon aria-hidden="true" />
          Web analytics
        </ButtonLink>
      </div>
      <InstallCard project={project.data} />
      <SettingsCard project={project.data} />
    </div>
  );
}
