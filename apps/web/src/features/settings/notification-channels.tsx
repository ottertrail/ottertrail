import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import {
  BellIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  LoaderCircleIcon,
  OctagonAlertIcon,
  PencilIcon,
  PlusIcon,
  SendIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import * as React from "react";

import { CopyableCode } from "@/components/copyable-code";
import { PINNED } from "@/components/pinned-column";
import { ScrollHint } from "@/components/scroll-hint";
import { SettingsSection } from "@/components/settings-section";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ApiError } from "@/lib/api";
import {
  type Channel,
  channelsQuery,
  type Delivery,
  deleteChannel,
  deliveriesQuery,
  fetchSecret,
  rotateSecret,
  sendTest,
  sendTestEmail,
} from "@/lib/channels-api";
import { storageQuery } from "@/lib/storage-api";

import { formatMoment } from "../uptime/format";
import { ChannelFormDialog } from "./channel-form-dialog";

/** What each event type is called in the list. */
const EVENT_TEXT: Record<string, string> = {
  "check.down": "Check down",
  "check.up": "Check up",
  "certificate.expiring": "Certificate expiring",
  "certificate.renewed": "Certificate renewed",
  "error.new": "New error",
  "error.regressed": "Regressed error",
  "error.spike": "Error spike",
  "error.spike_resolved": "Error spike over",
  "route.latency": "Route latency",
  "route.latency_resolved": "Route latency over",
  "route.failures": "Route failures",
  "route.failures_resolved": "Route failures over",
  "metric.threshold": "Metric",
  "metric.threshold_resolved": "Metric back",
  "ai.cost": "AI cost",
  "ai.cost_resolved": "AI cost back under",
  "ai.failures": "AI failures",
  "ai.failures_resolved": "AI failures over",
  "ai.latency": "AI latency",
  "ai.latency_resolved": "AI latency over",
  "alert.held_back": "Alerts held back",
  "storage.low": "Storage low",
  "storage.recovered": "Storage recovered",
  "backups.changed": "Backup settings changed",
  test: "Test",
};

/** A delivery's state in words, with an icon: never color alone. */
function DeliveryStatusBadge({ delivery }: { delivery: Delivery }) {
  if (delivery.status === "sent") return <StatusBadge tone="good">Sent</StatusBadge>;
  if (delivery.status === "failed") return <StatusBadge tone="critical">Failed</StatusBadge>;
  if (delivery.lastError !== null) return <StatusBadge tone="warning">Retrying</StatusBadge>;
  // Taken by the worker, its first attempt not finished yet.
  if (delivery.attempts > 0) {
    return (
      <StatusBadge
        tone="neutral"
        icon={<LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
      >
        Sending
      </StatusBadge>
    );
  }
  return <StatusBadge tone="neutral">Queued</StatusBadge>;
}

/** A channel's deliveries of the last 30 days, newest first, 20 at a time. */
function DeliveryList({ channel, timeZone }: { channel: Channel; timeZone: string }) {
  const query = useInfiniteQuery(deliveriesQuery(channel.id));
  if (query.isPending) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <Alert variant="destructive">
        <OctagonAlertIcon />
        <AlertTitle>The deliveries could not load</AlertTitle>
        <AlertDescription>{query.error.message}</AlertDescription>
        <AlertAction>
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </AlertAction>
      </Alert>
    );
  }
  const deliveries = query.data.pages.flatMap((page) => page.deliveries);
  const retentionDays = query.data.pages[0]?.retentionDays ?? 30;
  if (deliveries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No deliveries in the last {retentionDays} days. Send a test to try the channel.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <ScrollHint>
        <Table>
          <caption className="sr-only">
            Deliveries to {channel.name} in the last {retentionDays} days, newest first
          </caption>
          <TableHeader>
            <TableRow>
              <TableHead className={PINNED}>When</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Attempts</TableHead>
              <TableHead>What happened</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {deliveries.map((delivery) => (
              <TableRow key={delivery.id}>
                <TableCell className={cn("whitespace-nowrap tabular-nums", PINNED)}>
                  {formatMoment(delivery.createdAt, timeZone)}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {EVENT_TEXT[delivery.type] ?? delivery.type}
                </TableCell>
                <TableCell>
                  <DeliveryStatusBadge delivery={delivery} />
                </TableCell>
                <TableCell className="text-right tabular-nums">{delivery.attempts}</TableCell>
                <TableCell className="max-w-md min-w-56 text-sm whitespace-normal">
                  {delivery.status === "sent" && delivery.sentAt !== null ? (
                    <span className="text-muted-foreground">
                      Sent {formatMoment(delivery.sentAt, timeZone)}.
                    </span>
                  ) : (
                    <span>
                      {delivery.lastError ?? "Waiting to be sent."}
                      {delivery.status === "pending" && delivery.nextAttemptAt !== null && (
                        <span className="text-muted-foreground">
                          {" "}
                          Next try {formatMoment(delivery.nextAttemptAt, timeZone)}.
                        </span>
                      )}
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ScrollHint>
      {query.hasNextPage && (
        <Button
          variant="outline"
          size="sm"
          className="self-center"
          onClick={() => void query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
        >
          {query.isFetchingNextPage && (
            <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
          )}
          Load more
        </Button>
      )}
    </div>
  );
}

/** Asks before giving a webhook a new secret, which stops the current one at once. */
function RotateSecretDialog({
  channel,
  onRotated,
}: {
  channel: Channel;
  onRotated: (secret: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const queryClient = useQueryClient();
  const rotate = useMutation({
    mutationFn: () => rotateSecret(channel.id),
    // The answer holds the new secret: not kept once the dialog is done with it.
    gcTime: 0,
    onSuccess: ({ secret }) => {
      void queryClient.invalidateQueries({ queryKey: channelsQuery().queryKey, exact: true });
      onRotated(secret);
      setOpen(false);
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) rotate.reset();
      }}
    >
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Replace secret of ${channel.name}`}
        onClick={() => setOpen(true)}
      >
        Replace secret
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Replace the secret of “{channel.name}”?</DialogTitle>
          <DialogDescription>
            Update your receiver with the new secret, or signature checks will fail.
          </DialogDescription>
        </DialogHeader>
        {rotate.error !== null && (
          <Alert variant="destructive" role="alert">
            <OctagonAlertIcon />
            <AlertDescription>{rotate.error.message}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
          <Button onClick={() => rotate.mutate()} disabled={rotate.isPending}>
            {rotate.isPending && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
            Replace secret
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Asks before deleting a channel, with its deliveries. */
function DeleteChannelDialog({
  channel,
  open,
  onOpenChange,
}: {
  channel: Channel;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: async () => {
      try {
        await deleteChannel(channel.id);
      } catch (error) {
        // Already deleted, such as in another tab: what was asked for.
        if (!(error instanceof ApiError && error.code === "channel_not_found")) throw error;
      }
    },
    onSuccess: () => {
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: channelsQuery().queryKey, exact: true });
      // The Storage tab lists the channels too (storage-tab.tsx).
      void queryClient.invalidateQueries({ queryKey: storageQuery().queryKey, exact: true });
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) remove.reset();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete the channel “{channel.name}”?</DialogTitle>
          <DialogDescription>
            This stops notifications to the channel and deletes its deliveries.
          </DialogDescription>
        </DialogHeader>
        {remove.error !== null && (
          <Alert variant="destructive" role="alert">
            <OctagonAlertIcon />
            <AlertDescription>{remove.error.message}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
          <Button variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>
            {remove.isPending && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
            Delete channel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A webhook's signing secret: fetched only when Show is pressed, kept in
 * this component while shown, and forgotten on Hide; copied or replaced.
 */
function WebhookSecret({ channel }: { channel: Channel }) {
  const [secret, setSecret] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  if (!channel.hasSecret) return null;
  const shown = secret !== null;

  async function show() {
    setLoading(true);
    setError(null);
    try {
      setSecret(await fetchSecret(channel.id));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The secret could not load.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-medium text-ink">Signing secret</h4>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label={`${shown ? "Hide" : "Show"} secret of ${channel.name}`}
            disabled={loading}
            onClick={() => (shown ? setSecret(null) : void show())}
          >
            {loading ? (
              <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
            ) : shown ? (
              <EyeOffIcon aria-hidden="true" />
            ) : (
              <EyeIcon aria-hidden="true" />
            )}
            {shown ? "Hide" : "Show"}
          </Button>
          <RotateSecretDialog channel={channel} onRotated={setSecret} />
        </div>
      </div>
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {shown ? (
        <CopyableCode text={secret} copyLabel={`Copy the secret of ${channel.name}`} />
      ) : (
        <p className="rounded-lg bg-muted px-3 py-2 font-mono text-sm text-ink-subtle">
          ••••••••••••••••••••••••••••••••
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Each request carries <code className="font-mono">Ottertrail-Signature</code>, an HMAC-SHA256
        of its timestamp and body with this secret, so the receiver can check it came from this
        instance.
      </p>
    </div>
  );
}

/** One channel: what it is, its actions, its secret, and its deliveries on demand. */
function ChannelItem({
  channel,
  timeZone,
  emailConfigured,
}: {
  channel: Channel;
  timeZone: string;
  emailConfigured: boolean;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [showDeliveries, setShowDeliveries] = React.useState(false);
  const deliveriesId = React.useId();
  const test = useMutation({
    mutationFn: () => sendTest(channel.id),
    onSuccess: () => {
      setShowDeliveries(true);
      void queryClient.invalidateQueries({ queryKey: deliveriesQuery(channel.id).queryKey });
    },
  });
  return (
    <li className="flex flex-col gap-4 rounded-lg p-4 ring-1 ring-border">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <h3 className="font-medium text-ink">{channel.name}</h3>
            <Badge variant="secondary">{channel.kind === "email" ? "Email" : "Webhook"}</Badge>
          </div>
          <p className="font-mono text-xs [overflow-wrap:anywhere] text-muted-foreground">
            {channel.kind === "email" ? (channel.addresses ?? []).join(", ") : channel.url}
          </p>
          {channel.kind === "email" && !emailConfigured && (
            <p className="flex items-center gap-1 text-xs text-warning">
              <TriangleAlertIcon aria-hidden="true" className="size-3" />
              Not sent yet: SMTP_URL and EMAIL_FROM aren&apos;t set on this server.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            aria-label={`Send test to ${channel.name}`}
            disabled={test.isPending}
            onClick={() => test.mutate()}
          >
            {test.isPending ? (
              <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
            ) : (
              <SendIcon aria-hidden="true" />
            )}
            Send test
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Edit ${channel.name}`}
            onClick={() => setEditing(true)}
          >
            <PencilIcon aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Delete ${channel.name}`}
            onClick={() => setDeleting(true)}
          >
            <Trash2Icon aria-hidden="true" />
          </Button>
        </div>
      </div>
      {test.isSuccess && (
        <output className="text-sm text-ink-muted" aria-live="polite">
          Test queued. Check Deliveries for the result.
        </output>
      )}
      {test.error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {test.error.message}
        </p>
      )}
      <WebhookSecret channel={channel} />
      <div className="flex flex-col gap-2 border-t pt-3">
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          aria-expanded={showDeliveries}
          aria-controls={deliveriesId}
          aria-label={`Deliveries to ${channel.name}`}
          onClick={() => setShowDeliveries((value) => !value)}
        >
          {showDeliveries ? (
            <ChevronDownIcon aria-hidden="true" />
          ) : (
            <ChevronRightIcon aria-hidden="true" />
          )}
          Deliveries
        </Button>
        <div id={deliveriesId}>
          {showDeliveries && <DeliveryList channel={channel} timeZone={timeZone} />}
        </div>
      </div>
      <ChannelFormDialog
        open={editing}
        onOpenChange={setEditing}
        channel={channel}
        emailConfigured={emailConfigured}
      />
      <DeleteChannelDialog channel={channel} open={deleting} onOpenChange={setDeleting} />
    </li>
  );
}

/**
 * Email is set up: what it sends, and a test email to the signed-in user's
 * own address, sent while they wait, with the mail server's answer as a
 * status in words (never color alone).
 */
function EmailSetUp() {
  const test = useMutation({ mutationFn: sendTestEmail });
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <StatusBadge tone="good">Email set up</StatusBadge>
        </p>
        <Button size="sm" variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>
          {test.isPending ? (
            <LoaderCircleIcon
              aria-hidden="true"
              className="animate-spin motion-reduce:animate-none"
            />
          ) : (
            <SendIcon aria-hidden="true" />
          )}
          Send a test email
        </Button>
      </div>
      <output aria-live="polite" className="block empty:hidden">
        {test.isSuccess && (
          <p className="flex items-start gap-2 text-sm text-pretty text-ink">
            <StatusBadge tone="good">Accepted</StatusBadge>
            <span>{test.data.message}</span>
          </p>
        )}
        {test.isError && (
          <p className="flex items-start gap-2 text-sm text-pretty text-ink">
            <StatusBadge tone="critical">Not sent</StatusBadge>
            <span>{test.error.message}</span>
          </p>
        )}
      </output>
    </div>
  );
}

/**
 * The Notification channels tab of the instance's Settings, for the owner
 * and admins: email lists and webhooks, with whether email is set up, a
 * test send, a webhook's secret, and each channel's recent deliveries.
 * Adding, editing, deleting and sending a test are dialogs and actions on
 * the list, not a form with a Save bar.
 */
export function NotificationChannels({ timeZone }: { timeZone: string }) {
  const list = useQuery(channelsQuery());
  const [adding, setAdding] = React.useState(false);

  return (
    <SettingsSection title="Notification channels" wide>
      {list.isPending && (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}
      {list.isError && (
        <Alert variant="destructive">
          <OctagonAlertIcon />
          <AlertTitle>The channels could not load</AlertTitle>
          <AlertDescription>{list.error.message}</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={() => void list.refetch()}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      )}
      {list.isSuccess && (
        <>
          {list.data.email.configured ? (
            <EmailSetUp />
          ) : (
            <Alert>
              <TriangleAlertIcon />
              <AlertTitle>Email is not set up on this instance</AlertTitle>
              <AlertDescription>
                To enable email, set SMTP_URL and EMAIL_FROM on the server and restart it. You can
                save email channels now. Webhooks already work.
              </AlertDescription>
            </Alert>
          )}
          {list.data.channels.length === 0 ? (
            <Empty className="border border-dashed">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <BellIcon />
                </EmptyMedia>
                <EmptyTitle>No channels yet</EmptyTitle>
              </EmptyHeader>
              <EmptyContent>
                <Button onClick={() => setAdding(true)}>
                  <PlusIcon aria-hidden="true" />
                  Add channel
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground">
                  {list.data.channels.length} of {list.data.maxChannels} channels
                  {list.data.channels.length >= list.data.maxChannels &&
                    ": delete one to add another"}
                </p>
                <Button
                  size="sm"
                  onClick={() => setAdding(true)}
                  disabled={list.data.channels.length >= list.data.maxChannels}
                >
                  <PlusIcon aria-hidden="true" />
                  Add channel
                </Button>
              </div>
              <ul className="flex flex-col gap-3" aria-label="Notification channels">
                {list.data.channels.map((channel) => (
                  <ChannelItem
                    key={channel.id}
                    channel={channel}
                    timeZone={timeZone}
                    emailConfigured={list.data.email.configured}
                  />
                ))}
              </ul>
            </>
          )}
          <ChannelFormDialog
            open={adding}
            onOpenChange={setAdding}
            emailConfigured={list.data.email.configured}
          />
        </>
      )}
    </SettingsSection>
  );
}
