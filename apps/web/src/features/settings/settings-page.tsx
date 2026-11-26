import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRightIcon } from "lucide-react";
import * as React from "react";

import { AvatarField } from "@/components/avatar-field";
import { NoAccess } from "@/components/no-access";
import { SettingsSection } from "@/components/settings-section";
import { type SettingsTab, SettingsTabs } from "@/components/settings-tabs";
import { TimezoneCombobox } from "@/components/timezone-combobox";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useDirtyForm } from "@/hooks/use-dirty-form";
import { meQuery, type Permission } from "@/lib/access";
import { saveAvatarFirst } from "@/lib/avatars";
import { initialOf } from "@/lib/initials";
import { type Settings, settingsQuery, updateSettings } from "@/lib/settings-api";

import { AiModelsTab } from "./ai-models-tab";
import { BackupsTab } from "./backups-tab";
import { LocationDataTab } from "./location-data-card";
import { NotificationChannels } from "./notification-channels";
import { type InstanceTabProps, SectionFailed, SectionSkeleton } from "./section-states";
import { SERVER_LOG_TAB, ServerLogTab } from "./server-log-tab";
import { StorageTab } from "./storage-tab";

interface InstanceTab {
  /** Default to the first permitted tab when ?tab is absent. */
  value: string;
  label: string;
  /** Gate tabs by permission (docs/access.md). */
  permission: Permission;
  render: (props: InstanceTabProps) => React.ReactNode;
}

/** Define tabs here so navigation, permissions, dirty state, and leave guards stay in sync. */
const INSTANCE_TABS: readonly InstanceTab[] = [
  {
    value: "general",
    label: "General",
    permission: "settings",
    render: (props) => <GeneralTab {...props} />,
  },
  {
    value: "location-data",
    label: "Location data",
    permission: "settings",
    render: (props) => <LocationDataTab {...props} />,
  },
  {
    value: "storage",
    label: "Storage",
    permission: "projects",
    render: (props) => <StorageTab {...props} />,
  },
  {
    value: "ai-models",
    label: "AI models",
    permission: "projects",
    render: (props) => <AiModelsTab {...props} />,
  },
  {
    value: "backups",
    label: "Backups",
    permission: "settings",
    render: (props) => <BackupsTab {...props} />,
  },
  {
    value: "channels",
    label: "Notification channels",
    permission: "channels",
    render: ({ timeZone }) => <NotificationChannels timeZone={timeZone} />,
  },
  {
    value: SERVER_LOG_TAB,
    label: "Server log",
    permission: "settings",
    render: (props) => <ServerLogTab {...props} />,
  },
];

interface GeneralValues {
  name: string;
  timeZone: string;
  avatar: string | null;
}

/** Save the icon first; preserve it and other edits if the rest fails. A timezone change invalidates reports (docs/design-system.md, "The save rule"). */
function GeneralForm({
  settings,
  uploads,
  onDirty,
}: {
  settings: Settings;
  uploads: boolean;
  onDirty: (dirty: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const form = useDirtyForm<GeneralValues>(
    { name: settings.name, timeZone: settings.timeZone, avatar: settings.avatarUrl },
    { normalize: { name: (name) => name.trim(), timeZone: (zone) => zone.trim() } },
  );
  React.useEffect(() => onDirty(form.dirty), [onDirty, form.dirty]);
  const chosen = form.values.timeZone.trim();
  const movesDays = chosen !== "" && chosen !== form.initial.timeZone;
  const save = useMutation({
    mutationFn: async (values: GeneralValues) => {
      const before = form.initial;
      // Show the saved icon immediately, even if later fields fail.
      const submitted = await saveAvatarFirst(form, values, "/api/settings/avatar");
      if (submitted.avatar !== before.avatar) {
        void queryClient.invalidateQueries({ queryKey: meQuery().queryKey });
      }
      const timeZone = values.timeZone.trim();
      if (values.name.trim() === before.name.trim() && timeZone === before.timeZone) {
        return { submitted, updated: null };
      }
      return { submitted, updated: await updateSettings({ name: values.name, timeZone }) };
    },
    onSuccess: ({ submitted, updated }) => {
      form.saved(submitted);
      if (updated === null) {
        void queryClient.invalidateQueries({ queryKey: settingsQuery().queryKey });
        return;
      }
      queryClient.setQueryData(settingsQuery().queryKey, updated);
      // Timezone changes affect every report's day boundaries; keep only settings cached.
      void queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] !== settingsQuery().queryKey[0],
      });
    },
  });

  return (
    <SettingsSection
      title="Instance"
      description="Applies to all projects."
      form={form}
      onSave={(values) => save.mutate(values)}
      saving={save.isPending}
      error={save.error?.message}
      saveLabel="Save instance settings"
    >
      <FieldGroup>
        <AvatarField
          label="Icon"
          value={form.values.avatar}
          onChange={(avatar) => form.set("avatar", avatar)}
          text={initialOf(form.values.name)}
          uploads={uploads}
        />
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
          <FieldLabel htmlFor="settings-time-zone">Timezone</FieldLabel>
          <TimezoneCombobox
            id="settings-time-zone"
            name="timeZone"
            value={form.values.timeZone}
            onValueChange={(zone) => form.set("timeZone", zone)}
            required
            className="w-72 max-w-full"
            aria-describedby="settings-time-zone-hint"
          />
          <FieldDescription id="settings-time-zone-hint">
            {movesDays
              ? "Changes day boundaries in past reports too. Visitors seen before this change count again until midnight."
              : "Reports use this timezone for day boundaries."}
          </FieldDescription>
        </Field>
      </FieldGroup>
    </SettingsSection>
  );
}

function GeneralTab({ onDirty }: InstanceTabProps) {
  const settings = useQuery(settingsQuery());
  const uploads = useQuery(meQuery()).data?.avatarUploads ?? false;
  if (settings.isPending) return <SectionSkeleton />;
  if (settings.isError) {
    return (
      <SectionFailed
        title="The settings could not load"
        message={settings.error.message}
        retry={() => void settings.refetch()}
      />
    );
  }
  return (
    <>
      <GeneralForm settings={settings.data} uploads={uploads} onDirty={onDirty} />
      <RunningVersion settings={settings.data} />
    </>
  );
}

/** Read-only, so outside the form: its Save bar would not store it. */
function RunningVersion({ settings }: { settings: Settings }) {
  return (
    <dl className="flex max-w-2xl flex-wrap items-baseline gap-x-4 gap-y-1 py-6 text-sm">
      <dt className="text-ink-subtle">Version</dt>
      <dd className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-ink">
        <span className="tabular-nums">{settings.version}</span>
        {settings.releaseNotesUrl !== null && (
          <a
            href={settings.releaseNotesUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-link hover:underline"
          >
            Release notes
            <ArrowUpRightIcon aria-hidden="true" className="size-3.5" />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
      </dd>
    </dl>
  );
}

function PageSkeleton() {
  return (
    <div className="flex flex-col" aria-busy="true">
      <div className="flex h-10 items-center gap-6 border-b px-gutter">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-36" />
      </div>
      <div className="px-gutter">
        <SectionSkeleton />
      </div>
    </div>
  );
}

/** Gate each settings tab by role (docs/access.md). */
export function SettingsPage() {
  const me = useQuery(meQuery());
  const [dirty, setDirty] = React.useState<Record<string, boolean>>({});
  // Stable callbacks prevent form effects from rerunning every render.
  const onDirty = React.useMemo(
    () =>
      Object.fromEntries(
        INSTANCE_TABS.map((tab) => [
          tab.value,
          (next: boolean) =>
            setDirty((previous) =>
              previous[tab.value] === next ? previous : { ...previous, [tab.value]: next },
            ),
        ]),
      ),
    [],
  );

  if (me.isPending) return <PageSkeleton />;
  if (me.isError) {
    return (
      <div className="px-gutter">
        <SectionFailed
          title="The settings could not load"
          message={me.error.message}
          retry={() => void me.refetch()}
        />
      </div>
    );
  }
  const { permissions, instance } = me.data;
  const tabs: SettingsTab[] = INSTANCE_TABS.filter((tab) => permissions[tab.permission]).map(
    (tab) => ({
      value: tab.value,
      label: tab.label,
      dirty: dirty[tab.value],
      content: tab.render({
        onDirty: onDirty[tab.value] ?? (() => undefined),
        timeZone: instance.timeZone,
      }),
    }),
  );
  if (tabs.length === 0) {
    return <NoAccess />;
  }
  return <SettingsTabs label="Instance settings" tabs={tabs} />;
}
