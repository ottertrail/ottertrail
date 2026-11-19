import { useMutation, useQueryClient } from "@tanstack/react-query";
import { EyeIcon, EyeOffIcon, OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { CopyableCode } from "@/components/copyable-code";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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

/**
 * The project's secret key and what it is for: events from the site's own
 * server, and signed user IDs. Hidden until asked for: it must never go in
 * a page.
 */
export function ServerCard({ project }: { project: Project }) {
  const [shown, setShown] = React.useState(false);
  const queryClient = useQueryClient();
  const setSigning = useMutation({
    mutationFn: (requireSignedUserIds: boolean) =>
      updateProject(project.id, { requireSignedUserIds }),
    onSuccess: (updated) => {
      queryClient.setQueryData(projectQuery(project.id).queryKey, updated);
      void queryClient.invalidateQueries({ queryKey: projectsQuery().queryKey, exact: true });
    },
  });
  const switchId = React.useId();
  const descriptionId = React.useId();

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>Your server</h3>
        </CardTitle>
        <CardDescription>
          A browser cannot block or fake events from your server, such as payments. These events
          need the secret key. Keep it on your server. Never put it in a page.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-sm font-medium text-ink">Secret key</h4>
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
            <p className="rounded-lg bg-muted px-3 py-2 font-mono text-sm text-ink-subtle">
              sk_••••••••••••••••••••••••••••••••
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2 border-t pt-4">
          <h4 className="text-sm font-medium text-ink">Send events from your server</h4>
          <p className="text-sm text-muted-foreground">
            Each event belongs to a user and appears in their activity under Users. Send up to 50
            events per request. Give each event a new ID. Retries with the same ID are stored once.
          </p>
          <CopyableCode
            text={serverEventExample(window.location.origin, shown ? project.secretKey : "sk_…")}
            copyLabel="Copy the example"
          />
        </div>

        <div className="flex flex-col gap-3 border-t pt-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <Label htmlFor={switchId}>Only accept user IDs signed by your server</Label>
              <p id={descriptionId} className="text-sm text-muted-foreground">
                Anyone can copy the snippet and send events with any user ID. When enabled, browser
                events need your server's signature for the user ID to count. Events without a
                signature are retained without the user ID.
              </p>
            </div>
            <Switch
              id={switchId}
              aria-describedby={descriptionId}
              checked={project.requireSignedUserIds}
              disabled={setSigning.isPending}
              onCheckedChange={(checked) => setSigning.mutate(checked)}
            />
          </div>
          {setSigning.error !== null && (
            <Alert variant="destructive" role="alert">
              <OctagonAlertIcon />
              <AlertDescription>{setSigning.error.message}</AlertDescription>
            </Alert>
          )}
          <CopyableCode text={SIGNING_EXAMPLE} copyLabel="Copy the signing example" />
        </div>
      </CardContent>
    </Card>
  );
}
