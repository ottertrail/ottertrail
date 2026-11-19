import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  BellIcon,
  BellOffIcon,
  InfoIcon,
  LoaderCircleIcon,
  OctagonAlertIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import * as React from "react";

import { ButtonLink } from "@/components/button-link";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAccess } from "@/lib/access";
import {
  alertChannelsQuery,
  type ChannelName,
  deleteRule,
  firingQuery,
  kindArea,
  historyQuery,
  type Rule,
  rulesQuery,
  type SaveWarning,
  updateRule,
} from "@/lib/alerts-api";
import { ApiError } from "@/lib/api";
import { checksQuery } from "@/lib/uptime-api";

import { NoSuchProject } from "../projects/no-such-project";
import { formatMoment } from "../uptime/format";
import { type RulePrefill, RuleFormDialog } from "./rule-form-dialog";
import { RuleStateBadge } from "./rule-state-badge";
import { channelsText, watchesText } from "./rule-text";

/** Asks before deleting a rule, with its history. */
function DeleteRuleDialog({
  projectId,
  rule,
  open,
  onOpenChange,
}: {
  projectId: string;
  rule: Rule;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: async () => {
      try {
        await deleteRule(projectId, rule.id);
      } catch (error) {
        // Already deleted, such as in another tab: what was asked for.
        if (!(error instanceof ApiError && error.code === "rule_not_found")) throw error;
      }
    },
    onSuccess: () => {
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: ["alerts", projectId] });
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
          <DialogTitle>Delete the rule “{rule.name}”?</DialogTitle>
          <DialogDescription>
            This stops notifications and removes the rule's alerts from history. To stop the rule
            temporarily, disable it.
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
            Delete rule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What the page says after a rule is saved whose service or metric has not reported lately. */
type SavedWarning = { ruleName: string; warning: SaveWarning | null };

/** One rule's row: what it watches, its channels, its state, on or off, edit and delete. */
function RuleRow({
  projectId,
  rule,
  checks,
  channels,
  timeZone,
  onWarning,
  canManage,
}: {
  projectId: string;
  rule: Rule;
  checks: readonly { id: string; name: string }[];
  channels: readonly ChannelName[];
  /** The instance's, for when a rule stopped being evaluated. */
  timeZone: string;
  onWarning: (saved: SavedWarning) => void;
  /** Whether the user may change rules (uptime and alerts, manage). */
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => updateRule(projectId, rule.id, { enabled }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["alerts", projectId] }),
  });
  return (
    <TableRow>
      <TableCell className="max-w-sm">
        <span className="block font-medium text-ink">{rule.name}</span>
        <span className="block text-xs text-ink-subtle">{watchesText(rule, checks)}</span>
      </TableCell>
      <TableCell className="max-w-48 text-sm break-words">{channelsText(rule, channels)}</TableCell>
      <TableCell>
        <div className="flex flex-col gap-1">
          <RuleStateBadge rule={rule} />
          {!rule.enabled && rule.disabledReason !== null && (
            <span className="max-w-60 text-xs text-ink-subtle">{rule.disabledReason}</span>
          )}
          {rule.enabled && rule.evaluationError !== null && (
            <span className="flex max-w-60 items-start gap-1 text-xs text-destructive">
              <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
              <span>
                Not evaluated since{" "}
                <time dateTime={rule.evaluationError.since}>
                  {formatMoment(rule.evaluationError.since, timeZone)}
                </time>
                : {rule.evaluationError.message}
              </span>
            </span>
          )}
        </div>
      </TableCell>
      <TableCell>
        <Switch
          aria-label={rule.enabled ? `Turn off ${rule.name}` : `Turn on ${rule.name}`}
          checked={rule.enabled}
          disabled={!canManage || toggle.isPending}
          onCheckedChange={(checked) => toggle.mutate(checked)}
        />
        {toggle.error !== null && (
          <p role="alert" className="mt-1 max-w-60 text-xs text-destructive">
            {toggle.error.message}
          </p>
        )}
      </TableCell>
      <TableCell>
        {canManage && (
          <>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Edit ${rule.name}`}
                onClick={() => setEditing(true)}
              >
                <PencilIcon aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete ${rule.name}`}
                onClick={() => setDeleting(true)}
              >
                <Trash2Icon aria-hidden="true" />
              </Button>
            </div>
            <RuleFormDialog
              open={editing}
              onOpenChange={setEditing}
              projectId={projectId}
              rule={rule}
              checks={checks}
              channels={channels}
              onWarning={onWarning}
            />
            <DeleteRuleDialog
              projectId={projectId}
              rule={rule}
              open={deleting}
              onOpenChange={setDeleting}
            />
          </>
        )}
      </TableCell>
    </TableRow>
  );
}

/** The alerts firing now, longest first. */
function FiringCard({ projectId }: { projectId: string }) {
  const firing = useQuery(firingQuery(projectId));
  const data = firing.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>Firing now</h3>
        </CardTitle>
        <CardDescription>
          Unresolved alerts include checks still down and certificates still near expiry. They also
          include error spikes, routes, and metrics still beyond their thresholds.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {firing.isError ? (
          <Alert variant="destructive">
            <OctagonAlertIcon />
            <AlertDescription>{firing.error.message}</AlertDescription>
          </Alert>
        ) : data === undefined ? (
          <Skeleton className="h-12 w-full" aria-label="Loading" />
        ) : data.alerts.length === 0 ? (
          <p className="py-4 text-center text-sm text-ink-subtle">Nothing is firing.</p>
        ) : (
          <ul className="flex flex-col gap-3" aria-label="Firing now">
            {data.alerts.map((alert) => (
              <li key={`${alert.ruleId}:${alert.subject}`} className="flex flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2 text-sm">
                  <StatusBadge tone="critical">Firing</StatusBadge>
                  <span>
                    <span className="font-medium text-ink">{alert.subjectName}</span>
                    <span className="text-ink-subtle">
                      , rule {alert.ruleName}, since{" "}
                      <time dateTime={alert.since}>{formatMoment(alert.since, data.timeZone)}</time>
                    </span>
                  </span>
                </span>
                <span className="text-xs break-words text-ink-subtle">{alert.message}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** The project's alerts, newest first, with whether each went out. */
function HistoryCard({ projectId }: { projectId: string }) {
  const history = useInfiniteQuery(historyQuery(projectId));
  const pages = history.data?.pages;
  const alerts = pages?.flatMap((page) => page.alerts) ?? [];
  const first = pages?.[0];
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>Recent alerts</h3>
        </CardTitle>
        <CardDescription>
          All alerts triggered by the rules, newest first, kept for {first?.retentionDays ?? 90}{" "}
          days. Alerts suppressed by a rule's hourly limit are listed and marked. No notification is
          sent for them.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {history.isError ? (
          <Alert variant="destructive">
            <OctagonAlertIcon />
            <AlertDescription>{history.error.message}</AlertDescription>
          </Alert>
        ) : first === undefined ? (
          <Skeleton className="h-20 w-full" aria-label="Loading" />
        ) : alerts.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-subtle">No alert has fired yet.</p>
        ) : (
          <div className="flex flex-col gap-3">
            <Table>
              <caption className="sr-only">Recent alerts, newest first</caption>
              <TableHeader>
                <TableRow>
                  <TableHead>Fired</TableHead>
                  <TableHead>Rule</TableHead>
                  <TableHead>What happened</TableHead>
                  <TableHead>Resolved</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {alerts.map((alert) => (
                  <TableRow key={alert.id}>
                    <TableCell className="whitespace-nowrap">
                      <time dateTime={alert.firedAt}>
                        {formatMoment(alert.firedAt, first.timeZone)}
                      </time>
                    </TableCell>
                    <TableCell>{alert.ruleName}</TableCell>
                    <TableCell className="max-w-xl text-sm break-words">
                      {alert.message}
                      {!alert.notified && (
                        <StatusBadge
                          tone="warning"
                          className="ml-2"
                          icon={<BellOffIcon aria-hidden="true" />}
                        >
                          Held back
                        </StatusBadge>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {alert.resolvedAt === null ? (
                        <span className="text-ink-subtle">–</span>
                      ) : (
                        <time dateTime={alert.resolvedAt}>
                          {formatMoment(alert.resolvedAt, first.timeZone)}
                        </time>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {history.hasNextPage && (
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                disabled={history.isFetchingNextPage}
                onClick={() => void history.fetchNextPage()}
              >
                Show older alerts
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The project's alert rules: what each watches, its channels, whether it
 * fires now, on or off; add, edit, and delete through forms; the alerts
 * firing now and the recent ones. A link from a check's or an error's page
 * opens the form with what it knows (`prefill`).
 */
export function AlertsPage({ projectId, prefill }: { projectId: string; prefill: RulePrefill }) {
  const navigate = useNavigate();
  const list = useQuery(rulesQuery(projectId));
  const channels = useQuery(alertChannelsQuery(projectId));
  const { can, canUse } = useAccess();
  const canManage = canUse("uptime_alerts", "manage");
  const checks = useQuery(checksQuery(projectId));
  const [adding, setAdding] = React.useState(false);
  const [notice, setNotice] = React.useState<SavedWarning | null>(null);

  if (list.error instanceof ApiError && list.error.status === 404) {
    return <NoSuchProject />;
  }
  const data = list.data;
  const channelList = channels.data?.channels ?? [];
  const checkList = checks.data?.checks ?? [];
  const noChannels = channels.data !== undefined && channelList.length === 0;
  const full = data !== undefined && data.rules.length >= data.maxRules;
  const ready = data !== undefined && channels.data !== undefined;
  // A link from a check's or an error's page opens the form at once.
  // A link opens the form only for a kind the user may add.
  const prefillArea = prefill.add === undefined ? null : kindArea(prefill.add);
  const open =
    adding ||
    (prefill.add !== undefined &&
      canManage &&
      (prefillArea === null || canUse(prefillArea)) &&
      ready &&
      !noChannels &&
      !full);
  const setOpen = (next: boolean) => {
    setAdding(next);
    if (!next && prefill.add !== undefined) {
      void navigate({ to: "/projects/$projectId/alerts", params: { projectId }, search: {} });
    }
  };
  const addButton = canManage && (
    <Button onClick={() => setAdding(true)} disabled={!ready || noChannels || full}>
      <PlusIcon aria-hidden="true" />
      Add rule
    </Button>
  );
  const loadError = list.error ?? channels.error;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      {loadError !== null && (
        <Alert variant="destructive">
          <OctagonAlertIcon />
          <AlertTitle>
            {data === undefined ? "The rules could not load" : "The rules could not refresh"}
          </AlertTitle>
          <AlertDescription>{loadError.message}</AlertDescription>
          <AlertAction>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void list.refetch();
                void channels.refetch();
              }}
            >
              Retry
            </Button>
          </AlertAction>
        </Alert>
      )}
      {notice !== null && notice.warning !== null && (
        <Alert>
          <InfoIcon />
          <AlertTitle>
            {notice.warning.reason === "not_seen"
              ? `“${notice.ruleName}” is saved, and has nothing to watch yet`
              : `“${notice.ruleName}” is saved. Its monitored data could not be checked`}
          </AlertTitle>
          <AlertDescription>{notice.warning.message}</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={() => setNotice(null)}>
              Dismiss
            </Button>
          </AlertAction>
        </Alert>
      )}
      {noChannels && (
        <Alert>
          <BellOffIcon />
          <AlertTitle>No notification channels yet</AlertTitle>
          <AlertDescription>
            Alerts need an email channel or webhook channel. Channels belong to the instance. Every
            project can use them.
            {!can("channels") && " An admin adds them in Settings."}
          </AlertDescription>
          {can("channels") && (
            <AlertAction>
              <ButtonLink variant="outline" size="sm" to="/settings">
                Go to Settings
              </ButtonLink>
            </AlertAction>
          )}
        </Alert>
      )}
      {data === undefined ? (
        loadError === null && (
          <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        )
      ) : data.rules.length === 0 ? (
        <Empty className="border border-dashed p-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BellIcon />
            </EmptyMedia>
            <EmptyTitle>No alert rules yet</EmptyTitle>
            <EmptyDescription>
              A rule monitors a project's checks, certificates, errors, routes, or metrics. It
              notifies your team when a check goes down or a certificate nears expiry. It can report
              new, regressed, or spiking errors, slow or failing routes, and metrics above or below
              a value. It sends notifications through your selected email or webhook channels. It
              sends another notification when the alert ends.
            </EmptyDescription>
          </EmptyHeader>
          {canManage && <EmptyContent>{addButton}</EmptyContent>}
        </Empty>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-ink-subtle">
              {data.rules.length} of at most {data.maxRules} rules. Each sends at most{" "}
              {data.hourlyCap} notifications an hour. After that limit, one message reports how many
              notifications were suppressed.
              {can("channels") && (
                <>
                  {" "}
                  <Link to="/settings" className="text-link hover:underline">
                    Channels are in Settings
                  </Link>
                  .
                </>
              )}
            </p>
            {addButton}
          </div>
          <Table>
            <caption className="sr-only">Alert rules</caption>
            <TableHeader>
              <TableRow>
                <TableHead>Rule</TableHead>
                <TableHead>Sends to</TableHead>
                <TableHead>State</TableHead>
                <TableHead>On</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rules.map((rule) => (
                <RuleRow
                  key={rule.id}
                  projectId={projectId}
                  rule={rule}
                  checks={checkList}
                  channels={channelList}
                  timeZone={data.timeZone}
                  onWarning={setNotice}
                  canManage={canManage}
                />
              ))}
            </TableBody>
          </Table>
          {full && (
            <p className="text-sm text-ink-subtle">
              The project reached its alert rule limit. Delete a rule to add another.
            </p>
          )}
          <FiringCard projectId={projectId} />
          <HistoryCard projectId={projectId} />
        </>
      )}
      {open && (
        <RuleFormDialog
          open
          onOpenChange={setOpen}
          projectId={projectId}
          prefill={prefill}
          checks={checkList}
          channels={channelList}
          onWarning={setNotice}
        />
      )}
    </div>
  );
}
