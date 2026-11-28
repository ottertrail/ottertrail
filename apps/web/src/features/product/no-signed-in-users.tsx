import { ArrowUpRightIcon, UserRoundCheckIcon } from "lucide-react";

import { ButtonAnchor } from "@/components/button-anchor";
import { CopyableCode } from "@/components/copyable-code";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { DOCS_URL } from "@/lib/docs";

const IDENTIFY_EXAMPLE = `<script defer src="…/tracker.js" data-key="pk_…" data-user-id="42"></script>

// A single-page app, when someone signs in without a page load:
window.ottertrail?.identify("42");`;

const NAMING_USERS_URL = `${DOCS_URL}/users/naming-users/`;

/** For a project that has never sent a user ID: how to name signed-in users. */
export function NoSignedInUsers({ lead }: { lead: string }) {
  return (
    <Empty className="border border-dashed p-10">
      <EmptyHeader className="max-w-xl">
        <EmptyMedia variant="icon">
          <UserRoundCheckIcon />
        </EmptyMedia>
        <EmptyTitle>No signed-in users yet</EmptyTitle>
        <EmptyDescription>
          {lead} Add <code className="font-mono whitespace-nowrap">data-user-id</code> to the
          tracking snippet, and call{" "}
          <code className="font-mono">window.ottertrail.identify(id)</code> when someone signs in
          without a page load.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="max-w-2xl">
        <div className="w-full text-left">
          <CopyableCode text={IDENTIFY_EXAMPLE} copyLabel="Copy the example" />
        </div>
        <ButtonAnchor
          variant="outline"
          href={NAMING_USERS_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          How to name signed-in users
          <ArrowUpRightIcon aria-hidden="true" />
          <span className="sr-only">(opens in a new tab)</span>
        </ButtonAnchor>
      </EmptyContent>
    </Empty>
  );
}
