import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  InfoIcon,
  OctagonAlertIcon,
  SearchXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import * as React from "react";

import { ButtonLink } from "@/components/button-link";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { usePanePolling } from "@/components/workbench-pane";
import { useAccess } from "@/lib/access";
import { alertChannelsQuery, KIND_LABEL, rulesQuery } from "@/lib/alerts-api";
import { ApiError } from "@/lib/api";
import { checksQuery } from "@/lib/uptime-api";

import { NoSuchProject } from "../projects/no-such-project";
import { formatMoment } from "../uptime/format";
import { FiringSection, HistorySection } from "./alert-history";
import { RuleActions, RuleSwitch, type SavedWarning } from "./rule-actions";
import { RuleStateBadge } from "./rule-state-badge";
import { channelsText, watchesText } from "./rule-text";

/**
 * A notice that a rule was saved whose service or metric has not reported
 * lately, or could not be checked, with a way to dismiss it.
 */
export function SavedNotice({
  notice,
  onDismiss,
}: {
  notice: SavedWarning | null;
  onDismiss: () => void;
}) {
  if (notice === null || notice.warning === null) return null;
  return (
    <Alert>
      <InfoIcon />
      <AlertTitle>
        {notice.warning.reason === "not_seen"
          ? `“${notice.ruleName}” is saved, and has nothing to watch yet`
          : `“${notice.ruleName}” is saved. Its monitored data could not be checked`}
      </AlertTitle>
      <AlertDescription>{notice.warning.message}</AlertDescription>
      <AlertAction>
        <Button variant="outline" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </AlertAction>
    </Alert>
  );
}

/**
 * One alert rule with its loading, missing, and failed states: what it
 * watches, where it sends, whether it fires now (and why it is off or not
 * evaluated), its on or off switch, edit and delete, what it fires for
 * now, and the alerts it triggered. On the rule's own page, and in the
 * Alerts workbench beside the list, where `actions` links to the page and
 * a missing rule's link clears the selection instead.
 */
export function RuleView({
  projectId,
  ruleId,
  onWarning,
  onDeleted,
  actions,
  inWorkbench = false,
}: {
  projectId: string;
  ruleId: string;
  onWarning: (saved: SavedWarning) => void;
  onDeleted: () => void;
  /** Beside the rule's name, such as a link to its own page. */
  actions?: React.ReactNode;
  inWorkbench?: boolean;
}) {
  // Beside the list, polling stops while the pane is hidden.
  const polling = usePanePolling();
  const list = useQuery({ ...rulesQuery(projectId), ...polling });
  const channels = useQuery(alertChannelsQuery(projectId));
  const checks = useQuery({ ...checksQuery(projectId), ...polling });
  const canManage = useAccess().canUse("uptime_alerts", "manage");

  if (list.error instanceof ApiError && list.error.status === 404) {
    return <NoSuchProject />;
  }
  if (list.data === undefined) {
    return list.isError ? (
      <Alert variant="destructive">
        <OctagonAlertIcon />
        <AlertTitle>The rule could not load</AlertTitle>
        <AlertDescription>{list.error.message}</AlertDescription>
        <AlertAction>
          <Button variant="outline" size="sm" onClick={() => void list.refetch()}>
            Retry
          </Button>
        </AlertAction>
      </Alert>
    ) : (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading">
        <Skeleton className="h-12 w-2/3" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  const rule = list.data.rules.find((item) => item.id === ruleId);
  if (rule === undefined) {
    return (
      <Empty className="border border-dashed p-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SearchXIcon />
          </EmptyMedia>
          <EmptyTitle>No such rule</EmptyTitle>
          <EmptyDescription>
            The project has no alert rule with this ID that you may see. It may have been deleted.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          {inWorkbench ? (
            <ButtonLink
              variant="outline"
              to="/projects/$projectId/alerts"
              params={{ projectId }}
              search={(previous) => ({ ...previous, rule: undefined })}
            >
              All rules
            </ButtonLink>
          ) : (
            <ButtonLink variant="outline" to="/projects/$projectId/alerts" params={{ projectId }}>
              All rules
            </ButtonLink>
          )}
        </EmptyContent>
      </Empty>
    );
  }
  const checkList = checks.data?.checks ?? [];
  const channelList = channels.data?.channels ?? [];
  const facts = [
    { label: "Kind", value: KIND_LABEL[rule.kind] },
    { label: "Sends to", value: channelsText(rule, channelList) },
    {
      label: "Last fired",
      value:
        rule.lastFiredAt === null ? "Never" : formatMoment(rule.lastFiredAt, list.data.timeZone),
    },
  ];
  return (
    <div className="@container flex min-w-0 flex-col gap-6">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="text-xl font-semibold break-words text-ink">{rule.name}</h2>
            <p className="text-sm text-pretty text-ink-muted">{watchesText(rule, checkList)}</p>
          </div>
          {actions}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <RuleStateBadge rule={rule} />
          <span className="flex items-center gap-2 text-sm text-ink-muted">
            <RuleSwitch projectId={projectId} rule={rule} canManage={canManage} />
            {rule.enabled ? "On" : "Off"}
          </span>
          <RuleActions
            projectId={projectId}
            rule={rule}
            checks={checkList}
            channels={channelList}
            onWarning={onWarning}
            onDeleted={onDeleted}
            canManage={canManage}
          />
        </div>
        {!rule.enabled && rule.disabledReason !== null && (
          <p className="text-sm text-ink-subtle">{rule.disabledReason}</p>
        )}
        {rule.enabled && rule.evaluationError !== null && (
          <p className="flex items-start gap-1.5 text-sm text-destructive">
            <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>
              Not evaluated since{" "}
              <time dateTime={rule.evaluationError.since}>
                {formatMoment(rule.evaluationError.since, list.data.timeZone)}
              </time>
              : {rule.evaluationError.message}
            </span>
          </p>
        )}
      </div>
      <dl className="grid gap-x-6 gap-y-3 border-t pt-5 text-sm @lg:grid-cols-3">
        {facts.map((fact) => (
          <div key={fact.label} className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-xs text-ink-subtle">{fact.label}</dt>
            <dd className="break-words text-ink">{fact.value}</dd>
          </div>
        ))}
      </dl>
      <FiringSection projectId={projectId} ruleId={rule.id} />
      <HistorySection projectId={projectId} ruleId={rule.id} />
    </div>
  );
}

/** One alert rule on its own page, for deep links and narrow screens. */
export function RulePage({ projectId, ruleId }: { projectId: string; ruleId: string }) {
  const navigate = useNavigate();
  const [notice, setNotice] = React.useState<SavedWarning | null>(null);
  return (
    <div className="flex flex-col gap-4 px-gutter py-5">
      <Link
        to="/projects/$projectId/alerts"
        params={{ projectId }}
        className="inline-flex items-center gap-1 self-start text-sm text-link hover:underline"
      >
        <ArrowLeftIcon aria-hidden="true" className="size-4" />
        All rules
      </Link>
      <SavedNotice notice={notice} onDismiss={() => setNotice(null)} />
      <RuleView
        projectId={projectId}
        ruleId={ruleId}
        onWarning={setNotice}
        onDeleted={() =>
          void navigate({ to: "/projects/$projectId/alerts", params: { projectId } })
        }
      />
    </div>
  );
}
