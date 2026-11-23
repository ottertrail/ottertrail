import { Link } from "@tanstack/react-router";
import { ShieldAlertIcon } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { WhenAllowed } from "@/components/when-allowed";

/** Unsigned IDs let anyone with the public key impersonate users (docs/web-analytics.md, "Signed user IDs"). Only project managers get the settings link. */
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
