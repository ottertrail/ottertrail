import { useMutation, useQueryClient } from "@tanstack/react-query";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import * as React from "react";

import { CopyableCode } from "@/components/copyable-code";
import { SettingsSection } from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useDirtyForm } from "@/hooks/use-dirty-form";
import { type Project, projectQuery, projectsQuery, updateProject } from "@/lib/projects-api";

/** A server-side event, as a site's server sends it. */
function serverEventExample(origin: string, secretKey: string): string {
  return `curl ${origin}/api/server-events \\
  -H "Authorization: Bearer ${secretKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"v": 1, "events": [{"id": "<a new UUID>", "name": "subscription_started",
       "occurredAt": <milliseconds since 1970>, "userId": "42",
       "properties": {"plan": "team"}}]}'`;
}

/** How a site's server signs a user ID: HMAC-SHA256 of the ID with the secret key, in hex. */
const SIGNING_EXAMPLE = `// Node.js, on your server: the signature for the signed-in user's ID
import { createHmac } from "node:crypto";
const signature = createHmac("sha256", process.env.OTTERTRAIL_SECRET_KEY)
  .update(userId).digest("hex");
// In the page: <script … data-user-id="42" data-user-signature="<signature>"></script>`;

/** The Your server tab's form: whether browser events need a signed user ID. */
interface SigningValues {
  requireSignedUserIds: boolean;
}

const signingValues = (project: Project): SigningValues => ({
  requireSignedUserIds: project.requireSignedUserIds,
});

/**
 * The project's secret key and what it is for: events from the site's own
 * server, and signed user IDs. The key is hidden until asked for: it must
 * never go in a page. The signed-IDs switch saves with its form's Save.
 */
export function ServerSettings({
  project,
  onDirty,
}: {
  project: Project;
  /** Says whether the form holds unsaved changes, for the tab's mark. */
  onDirty: (dirty: boolean) => void;
}) {
  const form = useDirtyForm(signingValues(project), { key: project.id });
  React.useEffect(() => onDirty(form.dirty), [onDirty, form.dirty]);
  const [shown, setShown] = React.useState(false);
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (values: SigningValues) => updateProject(project.id, values),
    onSuccess: (updated, values) => {
      form.saved(values);
      queryClient.setQueryData(projectQuery(project.id).queryKey, updated);
      void queryClient.invalidateQueries({ queryKey: projectsQuery().queryKey, exact: true });
      // The Users pages say whether IDs are signed.
      void queryClient.invalidateQueries({ queryKey: ["users", project.id] });
      void queryClient.invalidateQueries({ queryKey: ["user", project.id] });
    },
  });
  const switchId = React.useId();
  const descriptionId = React.useId();

  return (
    <>
      <SettingsSection
        title="Your server"
        description="Keep the secret key on your server. Never put it in a page."
      >
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-ink">Secret key</h3>
            <Button variant="ghost" size="sm" onClick={() => setShown((value) => !value)}>
              {shown ? (
                <EyeOffIcon aria-hidden="true" className="size-4" />
              ) : (
                <EyeIcon aria-hidden="true" className="size-4" />
              )}
              {shown ? "Hide" : "Show"}
            </Button>
          </div>
          {shown ? (
            <CopyableCode text={project.secretKey} copyLabel="Copy the secret key" />
          ) : (
            <p className="rounded-lg bg-muted px-3 py-2 text-sm text-ink-subtle">
              sk_••••••••••••••••••••••••••••••••
            </p>
          )}
        </div>
        <div className="flex flex-col gap-2 border-t pt-4">
          <h3 className="text-sm font-medium text-ink">Send events from your server</h3>
          <p className="text-sm text-muted-foreground">
            Each event belongs to a user and appears in their activity under Users. Send up to 50
            events per request. Give each event a new ID. Retries with the same ID are stored once.
          </p>
          <CopyableCode
            text={serverEventExample(window.location.origin, shown ? project.secretKey : "sk_…")}
            copyLabel="Copy the example"
          />
        </div>
      </SettingsSection>

      <SettingsSection
        title="Signed user IDs"
        form={form}
        onSave={(values) => save.mutate(values)}
        saving={save.isPending}
        error={save.error?.message}
        className="border-t"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor={switchId}>Only accept user IDs signed by your server</Label>
            <p id={descriptionId} className="text-sm text-muted-foreground">
              Browser events without a valid signature are kept without their user ID.
            </p>
          </div>
          <Switch
            id={switchId}
            name="requireSignedUserIds"
            aria-describedby={descriptionId}
            checked={form.values.requireSignedUserIds}
            disabled={save.isPending}
            onCheckedChange={(checked) => form.set("requireSignedUserIds", checked)}
          />
        </div>
      </SettingsSection>

      <SettingsSection
        title="Sign a user ID"
        description="Your server signs the signed-in user's ID with the secret key, and the page passes the signature to the tracker."
        className="border-t"
      >
        <CopyableCode text={SIGNING_EXAMPLE} copyLabel="Copy the signing example" />
      </SettingsSection>
    </>
  );
}
