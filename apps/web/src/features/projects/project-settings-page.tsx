import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckIcon,
  CopyIcon,
  LoaderCircleIcon,
  OctagonAlertIcon,
  TriangleAlertIcon,
} from "lucide-react";
import * as React from "react";

import { CopyableCode } from "@/components/copyable-code";
import { NoAccess } from "@/components/no-access";
import { SettingsSection } from "@/components/settings-section";
import { SettingsTabs } from "@/components/settings-tabs";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import { ignoreOrder, useDirtyForm } from "@/hooks/use-dirty-form";
import { ApiError } from "@/lib/api";
import { goalsQuery } from "@/lib/goals-api";
import { isFullProject, type Project, projectQuery, updateProject } from "@/lib/projects-api";

import { DangerZone } from "./danger-zone";
import { hostnamesFromText, installSnippet, setupPrompt, timeAgo } from "./format";
import { HeatmapsSettings } from "./heatmaps-card";
import { NoSuchProject } from "./no-such-project";
import { ReplaysSettings } from "./replays-card";
import { ServerSettings } from "./server-card";
import { SourceMapsCard } from "./source-maps-card";
import { SpamTab } from "./spam-tab";

/** While waiting for the first event, check every few seconds. */
const STATUS_REFRESH_MS = 10_000;

type CopyState = "idle" | "copied" | "failed";

/**
 * Copies the prompt a coding agent needs to add Ottertrail to the app: this
 * instance's address and the public key, never the secret key.
 */
function CopySetupPrompt({ project }: { project: Project }) {
  const [state, setState] = React.useState<CopyState>("idle");
  // After a refused copy, the prompt stays on screen to copy by hand.
  const [showText, setShowText] = React.useState(false);
  const timer = React.useRef<number | undefined>(undefined);
  React.useEffect(() => () => window.clearTimeout(timer.current), []);
  const hintId = React.useId();
  const prompt = setupPrompt(window.location.origin, project.publicKey, {
    heatmaps: project.heatmaps,
  });
  async function copy() {
    window.clearTimeout(timer.current);
    try {
      // Missing outside a secure context, as on a self-hosted instance over plain HTTP.
      const clipboard = (navigator as Partial<Navigator>).clipboard;
      if (clipboard === undefined) throw new Error("No clipboard");
      await clipboard.writeText(prompt);
      setState("copied");
    } catch {
      setState("failed");
      setShowText(true);
    }
    timer.current = window.setTimeout(() => setState("idle"), 2000);
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button variant="outline" size="sm" aria-describedby={hintId} onClick={() => void copy()}>
          {state === "copied" ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
          {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy setup prompt"}
        </Button>
        <span id={hintId} className="text-sm text-ink-muted">
          For a coding agent: the instructions, this instance, and the public key. Never the secret
          key.
        </span>
        <span aria-live="polite" className="sr-only">
          {state === "copied" ? "Setup prompt copied" : state === "failed" ? "Copy failed" : ""}
        </span>
      </div>
      {showText && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-ink-muted">
            The browser did not allow copying. Select the prompt and copy it yourself:
          </p>
          <CopyableCode text={prompt} copyLabel="Copy the setup prompt" />
        </div>
      )}
    </div>
  );
}

function InstallSection({ project }: { project: Project }) {
  // The saved setting, not the form's: the snippet shows what the site should have now.
  const snippet = installSnippet(window.location.origin, project.publicKey, {
    heatmaps: project.heatmaps,
  });
  return (
    <SettingsSection
      title="Install"
      description={
        <>
          Add this tag to every page of your site, in the{" "}
          <code className="font-mono">&lt;head&gt;</code>. It records pageviews and how long each
          page is visible, without cookies.
        </>
      }
    >
      {project.allowedHostnames.length === 0 && (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>No allowed sites yet</AlertTitle>
          <AlertDescription>
            First, add your site's hostname on the General tab. Events from unlisted sites are
            rejected.
          </AlertDescription>
        </Alert>
      )}
      <div className="flex flex-col gap-3">
        <CopyableCode text={snippet} copyLabel="Copy the snippet" />
        <CopySetupPrompt project={project} />
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
              Open your site in a browser after installation. This status updates automatically.
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
        <h3 className="text-sm font-medium text-ink">Environment, release, and user (optional)</h3>
        <p className="text-sm text-muted-foreground">
          On a test or staging site, add{" "}
          <code className="font-mono">data-environment=&quot;staging&quot;</code> to the tag: its
          events then never mix with the live site&apos;s, and the analytics page can show either.
          Without it, events count as <code className="font-mono">production</code>. Add{" "}
          <code className="font-mono">data-release=&quot;1.4.2&quot;</code>, your app&apos;s
          version, to see which versions visitors use. While someone is signed in, add{" "}
          <code className="font-mono">data-user-id=&quot;42&quot;</code>, your own ID for them, to
          see them under Users.
        </p>
      </div>
      <div className="flex flex-col gap-2 border-t pt-4">
        <h3 className="text-sm font-medium text-ink">Public key</h3>
        <CopyableCode text={project.publicKey} copyLabel="Copy the public key" />
        <p className="text-sm text-muted-foreground">
          The snippet already includes this key. Anyone can see it in your pages, so by design it
          only lets pages on allowed sites send events, and it cannot read data.
        </p>
      </div>
    </SettingsSection>
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

/** The main goal's choice for none. */
const NO_GOAL = "none";

const retentionValue = (days: number | null) => (days === null ? "forever" : String(days));
const retentionDays = (value: string) => (value === "forever" ? null : Number(value));

/** The General tab's form, as the fields hold it. */
interface GeneralValues {
  name: string;
  /** The allowed sites, one per line, as typed. */
  hostnames: string;
  retention: string;
  mainGoal: string;
}

const generalValues = (project: Project): GeneralValues => ({
  name: project.name,
  hostnames: project.allowedHostnames.join("\n"),
  retention: retentionValue(project.retentionDays),
  mainGoal: project.mainGoalId ?? NO_GOAL,
});

/**
 * The project's name, allowed sites, how long it keeps events, and main
 * goal: one form, saved with its Save bar. Sites compare as a set,
 * so reordering them is no change.
 */
function GeneralSettings({
  project,
  onDirty,
}: {
  project: Project;
  onDirty: (dirty: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const form = useDirtyForm(generalValues(project), {
    key: project.id,
    normalize: {
      hostnames: (text) => ignoreOrder(hostnamesFromText(text)),
      name: (name) => name.trim(),
    },
  });
  React.useEffect(() => onDirty(form.dirty), [onDirty, form.dirty]);
  const saved = retentionValue(project.retentionDays);
  const choices = RETENTION_CHOICES.some((choice) => choice.value === saved)
    ? RETENTION_CHOICES
    : [...RETENTION_CHOICES, { value: saved, label: `${saved} days` }];
  const goals = useQuery(goalsQuery(project.id));
  const goalChoices = [
    { value: NO_GOAL, label: "None: new signed-in users" },
    ...(goals.data ?? []).map((goal) => ({ value: goal.id, label: goal.name })),
  ];
  const chosenDays = retentionDays(form.values.retention);
  // A stricter limit than now deletes events: say so before saving.
  const deletes =
    chosenDays !== null && (project.retentionDays === null || chosenDays < project.retentionDays);
  const save = useMutation({
    mutationFn: (values: GeneralValues) =>
      updateProject(project.id, {
        name: values.name,
        allowedHostnames: hostnamesFromText(values.hostnames),
        retentionDays: retentionDays(values.retention),
        // Sent only once the goals have loaded, so a choice is never made blind.
        ...(goals.isSuccess
          ? { mainGoalId: values.mainGoal === NO_GOAL ? null : values.mainGoal }
          : {}),
      }),
    onSuccess: (updated, values) => {
      form.saved(values);
      queryClient.setQueryData(projectQuery(project.id).queryKey, updated);
      void queryClient.invalidateQueries({ queryKey: ["projects"], exact: true });
      // The overview's business figures start with the main goal.
      void queryClient.invalidateQueries({ queryKey: ["overview", project.id] });
    },
  });

  return (
    <SettingsSection
      title="General"
      form={form}
      onSave={(values) => save.mutate(values)}
      saving={save.isPending}
      error={save.error?.message}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="settings-name">Name</FieldLabel>
          <Input
            id="settings-name"
            name="name"
            value={form.values.name}
            onChange={(event) => form.set("name", event.target.value)}
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
            value={form.values.hostnames}
            onChange={(event) => form.set("hostnames", event.target.value)}
            placeholder={"example.com\nwww.example.com"}
            aria-describedby="settings-hostnames-hint"
          />
          <FieldDescription id="settings-hostnames-hint">
            Enter one hostname per line. Each subdomain is separate. List both www.example.com and
            example.com if both serve pages. Changes apply within a minute.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="settings-retention">Keep events</FieldLabel>
          <Select
            items={choices}
            value={form.values.retention}
            onValueChange={(value) => {
              if (typeof value === "string") form.set("retention", value);
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
              ? `Events older than ${choices.find((choice) => choice.value === form.values.retention)?.label.toLowerCase()} will be permanently deleted within a few hours of saving, one whole day at a time.`
              : "Older events are permanently deleted, one whole day at a time. Forever keeps all events."}
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="settings-main-goal">Main goal</FieldLabel>
          {goals.isError ? (
            <p className="text-sm text-ink-muted">
              The goals could not load: {goals.error.message}
            </p>
          ) : (
            <Select
              items={goalChoices}
              value={form.values.mainGoal}
              disabled={!goals.isSuccess}
              onValueChange={(value) => {
                if (typeof value === "string") form.set("mainGoal", value);
              }}
            >
              <SelectTrigger
                id="settings-main-goal"
                className="w-64 max-w-full"
                aria-describedby="settings-main-goal-hint"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {goalChoices.map((choice) => (
                  <SelectItem key={choice.value} value={choice.value}>
                    {choice.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <FieldDescription id="settings-main-goal-hint">
            The overview's business figures start with this goal. Without one, they start with new
            signed-in users. Goals are added on the analytics page.
          </FieldDescription>
        </Field>
      </FieldGroup>
    </SettingsSection>
  );
}

/** The tabs, in the mockup's order: what a new project needs first. */
function SettingsTabsFor({ project }: { project: Project }) {
  const [generalDirty, setGeneralDirty] = React.useState(false);
  const [serverDirty, setServerDirty] = React.useState(false);
  const [replayDirty, setReplayDirty] = React.useState(false);
  const [spamDirty, setSpamDirty] = React.useState(false);
  const [heatmapsDirty, setHeatmapsDirty] = React.useState(false);
  return (
    <SettingsTabs
      label="Project settings"
      tabs={[
        {
          value: "install",
          label: "Install",
          dirty: heatmapsDirty,
          content: (
            <>
              <InstallSection project={project} />
              {/*
               * Heatmaps belong here: their visible effect is the snippet right
               * above (data-heatmaps="on"), and there is no Web analytics tab.
               */}
              <HeatmapsSettings project={project} onDirty={setHeatmapsDirty} />
            </>
          ),
        },
        {
          value: "general",
          label: "General",
          dirty: generalDirty,
          content: <GeneralSettings project={project} onDirty={setGeneralDirty} />,
        },
        {
          value: "server",
          label: "Your server",
          dirty: serverDirty,
          content: <ServerSettings project={project} onDirty={setServerDirty} />,
        },
        {
          value: "spam",
          label: "Spam and bots",
          dirty: spamDirty,
          content: <SpamTab project={project} onDirty={setSpamDirty} />,
        },
        {
          value: "source-maps",
          label: "Source maps",
          content: <SourceMapsCard projectId={project.id} />,
        },
        {
          value: "replay",
          label: "Session replay",
          dirty: replayDirty,
          content: <ReplaysSettings projectId={project.id} onDirty={setReplayDirty} />,
        },
        { value: "danger", label: "Danger zone", content: <DangerZone project={project} /> },
      ]}
    />
  );
}

/**
 * A project's settings: /projects/<id>/settings, as tabs (the chosen one in
 * `?tab=`). Source maps and Danger zone hold no fields; Install has the
 * Heatmaps form under its snippet, and General, Your server, Spam and bots,
 * and Session replay are forms, each with a Save bar.
 */
export function ProjectSettingsPage({ projectId }: { projectId: string }) {
  const project = useQuery({
    ...projectQuery(projectId),
    refetchInterval: (query) =>
      query.state.data?.lastEventAt === null ? STATUS_REFRESH_MS : STATUS_REFRESH_MS * 6,
  });

  if (project.isPending) {
    return (
      <div className="flex flex-col" aria-busy="true">
        <div className="flex h-10 items-center gap-6 border-b px-gutter">
          {Array.from({ length: 7 }, (_, index) => (
            // oxlint-disable-next-line react/no-array-index-key
            <Skeleton key={index} className="h-4 w-20" />
          ))}
        </div>
        <div className="flex max-w-2xl flex-col gap-4 px-gutter py-6">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    );
  }

  if (project.isError) {
    if (project.error instanceof ApiError && project.error.status === 404) {
      return <NoSuchProject />;
    }
    return (
      <div className="max-w-3xl px-gutter py-6">
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

  // Only those who manage projects get its keys and settings (docs/access.md).
  if (!isFullProject(project.data)) {
    return <NoAccess />;
  }
  return <SettingsTabsFor project={project.data} />;
}
