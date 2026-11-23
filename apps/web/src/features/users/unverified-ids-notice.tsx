import { Link } from "@tanstack/react-router";
import { ShieldAlertIcon } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { WhenAllowed } from "@/components/when-allowed";

/**
 * Says that the project accepts unsigned user IDs (docs/web-analytics.md,
 * "Signed user IDs"): anyone with the public key can send events as any
 * user. Those who manage projects get a link to the setting that requires
 * signatures; members cannot change it.
 */
export function UnverifiedIdsNotice({ projectId }: { projectId: string }) {
  return (
    <Alert role="note">
      <ShieldAlertIcon aria-hidden="true" />
      <AlertDescription className="text-pretty">
        User IDs on this project aren&apos;t verified, so anyone with the project&apos;s public key
        could send any ID.{" "}
        <WhenAllowed permission="projects">
          <Link
            to="/projects/$projectId/settings"
            params={{ projectId }}
            search={{ tab: "server" }}
            className="text-link"
          >
            Require signed IDs
          </Link>
        </WhenAllowed>
      </AlertDescription>
    </Alert>
  );
}
