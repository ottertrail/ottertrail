import { OctagonAlertIcon } from "lucide-react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/** What every tab is given: whether its form holds unsaved edits goes back to the tab row. */
export interface InstanceTabProps {
  onDirty: (dirty: boolean) => void;
  /** The instance's timezone, which the tabs' times are shown in. */
  timeZone: string;
}

/** A tab's section while its data loads: the heading, a line, and the fields' shape. */
export function SectionSkeleton() {
  return (
    <div className="flex max-w-2xl flex-col gap-4 py-6" aria-busy="true">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-4 w-full max-w-md" />
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-9 w-72 max-w-full" />
    </div>
  );
}

/** A tab whose data failed to load: what failed, and Retry. */
export function SectionFailed({
  title,
  message,
  retry,
}: {
  title: string;
  message: string;
  retry: () => void;
}) {
  return (
    <div className="max-w-2xl py-6">
      <Alert variant="destructive">
        <OctagonAlertIcon />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{message}</AlertDescription>
        <AlertAction>
          <Button variant="outline" size="sm" onClick={retry}>
            Retry
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
}
