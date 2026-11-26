import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircleIcon, OctagonAlertIcon, RefreshCwIcon } from "lucide-react";
import * as React from "react";

import { CopyableCode } from "@/components/copyable-code";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { usePanePolling } from "@/components/workbench-pane";
import { useAccess } from "@/lib/access";
import { pingsQuery, pingUrlQuery, replacePingUrl } from "@/lib/heartbeat-api";
import type { Check } from "@/lib/uptime-api";

import { CAUSE_TEXT, formatMoment } from "./format";

/** When a heartbeat goes down without a ping: the expected time plus the grace. */
const deadlineOf = (check: Check) =>
  check.expectedAt === null
    ? null
    : new Date(Date.parse(check.expectedAt) + (check.graceSeconds ?? 0) * 1000).toISOString();

export function HeartbeatStateLine({ check, timeZone }: { check: Check; timeZone: string }) {
  const deadline = deadlineOf(check);
  if (check.paused) {
    return <span>Paused: pings are refused until it is resumed.</span>;
  }
  if (check.state === "down") {
    return (
      <span>
        Down
        {check.failingSince !== null && (
          <>
            {" "}
            since{" "}
            <time dateTime={check.failingSince}>{formatMoment(check.failingSince, timeZone)}</time>
          </>
        )}
        {check.failingCause === null ? "" : `: ${CAUSE_TEXT[check.failingCause]}`}. Up again on the
        next ping.
      </span>
    );
  }
  const by =
    deadline === null ? null : <time dateTime={deadline}>{formatMoment(deadline, timeZone)}</time>;
  if (check.state === "pending") {
    return <span>New: waiting for the first ping. Down if none comes by {by}.</span>;
  }
  return <span>Up. Down if no ping comes by {by}.</span>;
}

function NewUrlDialog({ projectId, checkId }: { projectId: string; checkId: string }) {
  const [open, setOpen] = React.useState(false);
  const queryClient = useQueryClient();
  const replace = useMutation({
    mutationFn: () => replacePingUrl(projectId, checkId),
    onSuccess: (url) => {
      queryClient.setQueryData(pingUrlQuery(projectId, checkId).queryKey, url);
      setOpen(false);
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) replace.reset();
      }}
    >
      <Button variant="outline" size="sm" className="self-start" onClick={() => setOpen(true)}>
        <RefreshCwIcon aria-hidden="true" />
        New URL
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Make a new ping URL?</DialogTitle>
          <DialogDescription>
            The current URL stops working at once. Update every job that calls it.
          </DialogDescription>
        </DialogHeader>
        {replace.error !== null && (
          <Alert variant="destructive" role="alert">
            <OctagonAlertIcon />
            <AlertDescription>{replace.error.message}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
          <Button onClick={() => replace.mutate()} disabled={replace.isPending}>
            {replace.isPending && (
              <LoaderCircleIcon
                aria-hidden="true"
                className="animate-spin motion-reduce:animate-none"
              />
            )}
            Make new URL
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const CURL = "curl -fsS -m 10 --retry 3 -o /dev/null";

function PingUrl({ projectId, checkId }: { projectId: string; checkId: string }) {
  const url = useQuery(pingUrlQuery(projectId, checkId));
  if (url.isError) {
    return (
      <Alert variant="destructive">
        <OctagonAlertIcon />
        <AlertDescription>{url.error.message}</AlertDescription>
        <AlertAction>
          <Button variant="outline" size="sm" onClick={() => void url.refetch()}>
            Retry
          </Button>
        </AlertAction>
      </Alert>
    );
  }
  if (url.data === undefined) return <Skeleton className="h-24 w-full" aria-label="Loading" />;
  return (
    <div className="flex flex-col gap-4">
      <CopyableCode text={url.data} copyLabel="Copy the ping URL" />
      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-medium text-ink">At the end of a cron line</h4>
        <CopyableCode
          text={`0 3 * * * /path/to/job.sh && ${CURL} ${url.data}`}
          copyLabel="Copy the cron example"
        />
      </div>
      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-medium text-ink">To report a failure too</h4>
        <CopyableCode
          text={`/path/to/job.sh && ${CURL} ${url.data} || ${CURL} ${url.data}/fail`}
          copyLabel="Copy the failure example"
        />
      </div>
      <NewUrlDialog projectId={projectId} checkId={checkId} />
    </div>
  );
}

export function PingUrlCard({ projectId, check }: { projectId: string; check: Check }) {
  const canManage = useAccess().canUse("uptime_alerts", "manage");
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>Ping URL</h3>
        </CardTitle>
        <CardDescription>
          Call it each time the job runs: GET, POST, or HEAD. Add /fail to report a failure.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {canManage ? (
          <PingUrl projectId={projectId} checkId={check.id} />
        ) : (
          <p className="text-sm text-ink-subtle">
            Only people who manage uptime checks can see the URL.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function PingsCard({ projectId, checkId }: { projectId: string; checkId: string }) {
  const pings = useQuery({ ...pingsQuery(projectId, checkId), ...usePanePolling() });
  const data = pings.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>Latest pings</h3>
        </CardTitle>
        <CardDescription>The latest 50, newest first.</CardDescription>
      </CardHeader>
      <CardContent>
        {pings.isError ? (
          <Alert variant="destructive">
            <OctagonAlertIcon />
            <AlertDescription>{pings.error.message}</AlertDescription>
            <AlertAction>
              <Button variant="outline" size="sm" onClick={() => void pings.refetch()}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        ) : data === undefined ? (
          <Skeleton className="h-20 w-full" aria-label="Loading" />
        ) : data.pings.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-subtle">No ping yet.</p>
        ) : (
          <Table>
            <caption className="sr-only">Latest pings, newest first</caption>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Reported</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.pings.map((ping, index) => (
                <TableRow key={`${ping.at}-${index}`}>
                  <TableCell className="whitespace-normal">
                    <time dateTime={ping.at}>{formatMoment(ping.at, data.timeZone)}</time>
                  </TableCell>
                  <TableCell>
                    {ping.failed ? (
                      <StatusBadge tone="critical">Failure</StatusBadge>
                    ) : (
                      <StatusBadge tone="good">Success</StatusBadge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
