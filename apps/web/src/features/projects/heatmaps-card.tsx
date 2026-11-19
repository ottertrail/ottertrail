import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { SettingsSection } from "@/components/settings-section";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useDirtyForm } from "@/hooks/use-dirty-form";
import { type Project, projectQuery, projectsQuery, updateProject } from "@/lib/projects-api";

/** The Heatmaps form: whether the snippet asks the tracker for clicks and scroll depth. */
interface HeatmapValues {
  heatmaps: boolean;
}

/** An attribute to type, as code. */
const code = (text: string) => <code className="font-mono">{text}</code>;

/**
 * Heatmaps on or off, saved with its own Save bar. It sits on the Install
 * tab, under the snippet: what the setting changes on the site is that
 * snippet (`data-heatmaps="on"`), and the project has no Web analytics tab
 * of its own.
 */
export function HeatmapsSettings({
  project,
  onDirty,
}: {
  project: Project;
  /** Says whether the form holds unsaved changes, for the tab's mark. */
  onDirty: (dirty: boolean) => void;
}) {
  const form = useDirtyForm<HeatmapValues>({ heatmaps: project.heatmaps }, { key: project.id });
  React.useEffect(() => onDirty(form.dirty), [onDirty, form.dirty]);
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (values: HeatmapValues) => updateProject(project.id, values),
    onSuccess: (updated, values) => {
      form.saved(values);
      queryClient.setQueryData(projectQuery(project.id).queryKey, updated);
      void queryClient.invalidateQueries({ queryKey: projectsQuery().queryKey, exact: true });
      // The Heatmaps page says whether the setting is on.
      void queryClient.invalidateQueries({ queryKey: ["heatmaps", project.id] });
    },
  });
  const switchId = React.useId();
  const descriptionId = React.useId();

  return (
    <SettingsSection
      title="Heatmaps"
      form={form}
      onSave={(values) => save.mutate(values)}
      saving={save.isPending}
      error={save.error?.message}
      className="border-t"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor={switchId}>Record clicks and scroll depth</Label>
          <p id={descriptionId} className="text-sm text-muted-foreground">
            Pages send where visitors click and how far they scroll, for the Heatmaps page. Once on,
            the snippet above includes {code('data-heatmaps="on"')}: update it on your site.
          </p>
        </div>
        <Switch
          id={switchId}
          name="heatmaps"
          aria-describedby={descriptionId}
          checked={form.values.heatmaps}
          disabled={save.isPending}
          onCheckedChange={(checked) => form.set("heatmaps", checked)}
        />
      </div>
      <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
        <li>
          A click sends the element&apos;s place in the page and where in it the click fell. No
          text, typed values, IDs, class names, or link addresses are sent.
        </li>
        <li>No cookies and nothing stored in the visitor&apos;s browser.</li>
        <li>Heatmaps follow page analytics and have no consent switch of their own.</li>
        <li>Heatmap data is kept 90 days.</li>
        <li>
          To sample fewer pageviews, add {code('data-heatmaps-sample="0.25"')} to the snippet: about
          one pageview in four then sends heatmap data.
        </li>
        <li>
          Add {code('data-ottertrail-name="hero-cta"')} to an element on your site to see it under
          that name, instead of its place in the page.
        </li>
      </ul>
    </SettingsSection>
  );
}
