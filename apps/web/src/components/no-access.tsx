import { LockIcon } from "lucide-react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

/** A page the signed-in user may not open (docs/access.md). The API refuses it regardless. */
export function NoAccess() {
  return (
    <Empty className="m-6 border border-dashed p-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <LockIcon />
        </EmptyMedia>
        <EmptyTitle>You don't have access</EmptyTitle>
        <EmptyDescription>Ask an admin of this instance if you need access.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
