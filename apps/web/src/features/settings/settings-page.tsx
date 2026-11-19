import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { NoAccess } from "@/components/no-access";
import { SettingsSection } from "@/components/settings-section";
import { type SettingsTab, SettingsTabs } from "@/components/settings-tabs";
import { TimezoneCombobox } from "@/components/timezone-combobox";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useDirtyForm } from "@/hooks/use-dirty-form";
import { meQuery, type Permission } from "@/lib/access";
import { type Settings, settingsQuery, updateSettings } from "@/lib/settings-api";

import { LocationDataTab } from "./location-data-card";
import { NotificationChannels } from "./notification-channels";
import { type InstanceTabProps, SectionFailed, SectionSkeleton } from "./section-states";
import { StorageTab } from "./storage-tab";

interface InstanceTab {
  /** In the address: `?tab=<value>`. The first tab the user may see is the default. */
  value: string;
  label: string;
  /** Shown only to users with this permission (docs/access.md). */
  permission: Permission;
  render: (props: InstanceTabProps) => React.ReactNode;
}

/**
 * The instance's settings tabs, in order. Adding a tab is one entry here:
 * the tab row, the address, the "Unsaved" mark, the leave guard and who
 * sees it follow from it.
 */
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
    value: "channels",
    label: "Notification channels",
    permission: "channels",
    render: ({ timeZone }) => <NotificationChannels timeZone={timeZone} />,
  },
];

interface GeneralValues {
  name: string;
  timeZone: string;
}

/**
 * The instance's name and timezone: one form with its Save bar
 * (docs/design-system.md, "The save rule"). Saving a new timezone moves
 * where days start in every report, so every query but the settings'
 * own is read again.
 */
function GeneralForm({
  settings,
  onDirty,
}: {
  settings: Settings;
  onDirty: (dirty: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const form = useDirtyForm<GeneralValues>(
    { name: settings.name, timeZone: settings.timeZone },
    { normalize: { name: (name) => name.trim(), timeZone: (zone) => zone.trim() } },
  );
  React.useEffect(() => onDirty(form.dirty), [onDirty, form.dirty]);
  const chosen = form.values.timeZone.trim();
  const movesDays = chosen !== "" && chosen !== form.initial.timeZone;
  const save = useMutation({
    mutationFn: (values: GeneralValues) =>
      updateSettings({ name: values.name, timeZone: values.timeZone.trim() }),
    onSuccess: (updated, values) => {
      form.saved(values);
      queryClient.setQueryData(settingsQuery().queryKey, updated);
      // Every page counts days in the timezone: everything shown but the
      // settings themselves may change.
      void queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] !== settingsQuery().queryKey[0],
      });
    },
  });

  return (
    <SettingsSection
      title="Instance"
      description="The instance name and timezone apply to all projects. Only the owner can view and change them."
      form={form}
      onSave={(values) => save.mutate(values)}
      saving={save.isPending}
      error={save.error?.message}
      saveLabel="Save instance settings"
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
              ? "Changing the timezone changes day boundaries in all reports, including past reports. Visitors seen before the change count again after it until midnight."
              : "Reports count days in this timezone. Use a name such as Europe/Berlin or Asia/Singapore."}
          </FieldDescription>
        </Field>
      </FieldGroup>
    </SettingsSection>
  );
}

/** The General tab, for the owner: the settings load here, as the location data's do. */
function GeneralTab({ onDirty }: InstanceTabProps) {
  const settings = useQuery(settingsQuery());
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
  return <GeneralForm settings={settings.data} onDirty={onDirty} />;
}

/** The tab row and a section, while who the user is still loads. */
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

/**
 * The instance's settings: /settings (docs/access.md), as tabs, the chosen
 * one in `?tab=`. The owner has General (the name and timezone) and
 * Location data; the owner and admins have Storage (what fills the disk)
 * and the notification channels.
 * Members do not see the page.
 */
export function SettingsPage() {
  const me = useQuery(meQuery());
  const [dirty, setDirty] = React.useState<Record<string, boolean>>({});
  // One stable callback per tab, so a form's effect does not run on every render.
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
