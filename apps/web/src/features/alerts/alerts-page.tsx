import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  BellIcon,
  BellOffIcon,
  ExternalLinkIcon,
  OctagonAlertIcon,
  PlusIcon,
  TriangleAlertIcon,
} from "lucide-react";
import * as React from "react";

import { ButtonLink } from "@/components/button-link";
import { FilterBar } from "@/components/filter-bar";
import { type Stat, StatStrip } from "@/components/stat-strip";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Workbench,
  WorkbenchKeyHints,
  type WorkbenchListProps,
  WorkbenchStartHint,
} from "@/components/workbench";
import {
  GUTTER_END,
  GUTTER_START,
  LIST_HEAD,
  ROW_LINK,
  selectOnPlainClick,
  workbenchRow,
} from "@/components/workbench-rows";
import { PHONE, useMediaQuery } from "@/hooks/use-media-query";
import { useSearchParam } from "@/hooks/use-search-param";
import { useAccess } from "@/lib/access";
import {
  alertChannelsQuery,
  type ChannelName,
  kindArea,
  type Rule,
  type RuleList,
  rulesQuery,
} from "@/lib/alerts-api";
import { ApiError } from "@/lib/api";
import { checksQuery } from "@/lib/uptime-api";

import { NoSuchProject } from "../projects/no-such-project";
import { formatMoment } from "../uptime/format";
import { FiringSection, HistorySection } from "./alert-history";
import { RuleActions, RuleSwitch, type SavedWarning } from "./rule-actions";
import { type RulePrefill, RuleFormDialog } from "./rule-form-dialog";
import { RuleStateBadge } from "./rule-state-badge";
import { watchesText } from "./rule-text";
import { RuleView, SavedNotice } from "./rule-view";

/**
 * The rules, in the API's order: each one's name (a link to its own page;
 * in the workbench a plain click selects the row instead) and what it
 * watches, its state (with why it is off or not evaluated), its on or off
 * switch, and edit and delete. The switch acts at once.
 */
function RuleTable({
  rules,
  projectId,
  checks,
  channels,
  timeZone,
  canManage,
  onWarning,
  onDeleted,
  selected,
  select,
}: {
  rules: readonly Rule[];
  projectId: string;
  checks: readonly { id: string; name: string }[];
  channels: readonly ChannelName[];
  /** The instance's, for when a rule stopped being evaluated. */
  timeZone: string;
  canManage: boolean;
  onWarning: (saved: SavedWarning) => void;
  onDeleted: (ruleId: string) => void;
} & WorkbenchListProps) {
  // On a phone, edit and delete are on the rule's page.
  const phone = useMediaQuery(PHONE);
  const actions = canManage && !phone;
  return (
    <Table className="table-fixed">
      <caption className="sr-only">Alert rules</caption>
      <colgroup>
        <col />
        <col className="w-28" />
        <col className="w-14" />
        {/* On a phone, edit and delete are on the rule's page: the name keeps the room. */}
        {actions && <col className="w-20" />}
      </colgroup>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead scope="col" className={`${LIST_HEAD} ${GUTTER_START}`}>
            Rule
          </TableHead>
          <TableHead scope="col" className={LIST_HEAD}>
            State
          </TableHead>
          <TableHead scope="col" className={`${LIST_HEAD} ${actions ? "" : GUTTER_END}`}>
            On
          </TableHead>
          {actions && (
            <TableHead scope="col" className={GUTTER_END}>
              <span className="sr-only">Actions</span>
            </TableHead>
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rules.map((rule) => {
          const chosen = rule.id === selected;
          return (
            <TableRow key={rule.id} {...workbenchRow(rule.id, chosen)}>
              <TableCell className={`${GUTTER_START} py-2.5 align-top whitespace-normal`}>
                <Link
                  to="/projects/$projectId/alerts/$ruleId"
                  params={{ projectId, ruleId: rule.id }}
                  aria-current={chosen ? "true" : undefined}
                  {...ROW_LINK}
                  onClick={selectOnPlainClick(select, rule.id)}
                  className="block truncate rounded-sm font-medium text-link hover:underline"
                  title={rule.name}
                >
                  {rule.name}
                </Link>
                <span className="line-clamp-2 text-xs break-words text-ink-subtle">
                  {watchesText(rule, checks)}
                </span>
              </TableCell>
              <TableCell className="py-2.5 align-top whitespace-normal">
                <div className="flex flex-col gap-1">
                  <RuleStateBadge rule={rule} />
                  {!rule.enabled && rule.disabledReason !== null && (
                    <span
                      className="line-clamp-3 text-xs text-ink-subtle"
                      title={rule.disabledReason}
                    >
                      {rule.disabledReason}
                    </span>
                  )}
                  {rule.enabled && rule.evaluationError !== null && (
                    <span
                      className="flex items-start gap-1 text-xs text-destructive"
                      title={rule.evaluationError.message}
                    >
                      <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
                      <span>
                        Not evaluated since{" "}
                        <time dateTime={rule.evaluationError.since}>
                          {formatMoment(rule.evaluationError.since, timeZone)}
                        </time>
                      </span>
                    </span>
                  )}
                </div>
              </TableCell>
              <TableCell className={`py-2.5 align-top ${actions ? "" : GUTTER_END}`}>
                <RuleSwitch projectId={projectId} rule={rule} canManage={canManage} />
              </TableCell>
              {actions && (
                <TableCell className={`py-2 align-top ${GUTTER_END}`}>
                  <RuleActions
                    projectId={projectId}
                    rule={rule}
                    checks={checks}
                    channels={channels}
                    onWarning={onWarning}
                    onDeleted={() => onDeleted(rule.id)}
                    canManage={canManage}
                    compact
                  />
                </TableCell>
              )}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/**
 * With nothing selected, the detail pane sums up the rules (the API lists
 * every one the user may see) by state: firing, quiet, or off, with a note
 * on any that cannot be evaluated; then the alerts firing now and the
 * recent ones. On a narrow screen it follows the list.
 */
function Summary({
  data,
  projectId,
  underList = false,
}: {
  data: RuleList;
  projectId: string;
  /** Under the list on a narrow screen, where no item is chosen beside it. */
  underList?: boolean;
}) {
  const { can } = useAccess();
  const count = (test: (rule: Rule) => boolean) => String(data.rules.filter(test).length);
  const failing = data.rules.filter((rule) => rule.enabled && rule.evaluationError !== null);
  const stats: Stat[] = [
    { label: "Rules", value: `${data.rules.length} of ${data.maxRules}` },
    { label: "Firing", value: count((rule) => rule.enabled && rule.firing > 0) },
    { label: "Quiet", value: count((rule) => rule.enabled && rule.firing === 0) },
    { label: "Off", value: count((rule) => !rule.enabled) },
  ];
  return (
    <div className="flex flex-col gap-6 px-gutter py-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold text-ink">Alerts now</h2>
        <p className="text-sm text-ink-subtle">Times in {data.timeZone}.</p>
      </div>
      <section aria-label="Every rule" className="flex flex-col gap-3 border-t pt-5">
        <StatStrip label="Rules by state" stats={stats} />
        {failing.length > 0 && (
          // Firing and quiet rules both may fail to evaluate: a note, not a fourth state.
          <p className="flex items-start gap-1.5 text-sm text-destructive">
            <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {failing.length === 1
              ? "1 of the rules on is not evaluated now. Its detail says why."
              : `${failing.length} of the rules on are not evaluated now. Their details say why.`}
          </p>
        )}
        <p className="text-xs text-pretty text-ink-subtle">
          Each rule sends at most {data.hourlyCap} notifications an hour. After that limit, one
          message reports how many notifications were suppressed.
          {can("channels") && (
            <>
              {" "}
              <Link
                to="/settings"
                search={{ tab: "channels" }}
                className="text-link hover:underline"
              >
                Channels are in Settings
              </Link>
              .
            </>
          )}
        </p>
      </section>
      <FiringSection projectId={projectId} />
      <HistorySection projectId={projectId} />
      {!underList && <WorkbenchStartHint noun="a rule" />}
    </div>
  );
}

/**
 * The project's alert rules as a workbench (docs/design-system.md,
 * "Workbench"): each with what it watches, its state, and its on or off
 * switch, with edit and delete; beside the selected rule's detail (where
 * it sends, what it fires for now, its alerts) or, with none selected, a
 * summary with the alerts firing now and the recent ones. Firing alerts
 * belong to their rules, so they are not a second list: the summary shows
 * them all, a rule's detail its own. Rules are added and edited through
 * forms; a link from a check's or an error's page opens the form with what
 * it knows (`prefill`). Under 64rem a row opens the rule's own page.
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
  const [selected, setSelected] = useSearchParam("rule");

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
  // A deleted rule that was selected gives way to the one after it (or before, at the end).
  const afterDelete = (ruleId: string) => {
    if (ruleId !== selected) return;
    const ids = (data?.rules ?? []).map((rule) => rule.id);
    const at = ids.indexOf(ruleId);
    setSelected(ids[at + 1] ?? (at > 0 ? ids[at - 1] : undefined), { replace: true });
  };
  // The Workbench keeps the latest of this, so it may be a new function each render.
  const openPage = (ruleId: string) =>
    void navigate({ to: "/projects/$projectId/alerts/$ruleId", params: { projectId, ruleId } });
  const addButton = canManage && (
    <Button onClick={() => setAdding(true)} disabled={!ready || noChannels || full}>
      <PlusIcon aria-hidden="true" />
      Add rule
    </Button>
  );
  const loadError = list.error ?? channels.error;

  const notices = (
    <>
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
      <SavedNotice notice={notice} onDismiss={() => setNotice(null)} />
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
              <ButtonLink variant="outline" size="sm" to="/settings" search={{ tab: "channels" }}>
                Go to Settings
              </ButtonLink>
            </AlertAction>
          )}
        </Alert>
      )}
    </>
  );
  const dialog = open && (
    <RuleFormDialog
      open
      onOpenChange={setOpen}
      projectId={projectId}
      prefill={prefill}
      checks={checkList}
      channels={channelList}
      onWarning={setNotice}
    />
  );

  if (data === undefined || data.rules.length === 0) {
    return (
      <div className="flex flex-col gap-6 px-gutter py-5">
        {notices}
        {data === undefined ? (
          loadError === null && (
            <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          )
        ) : (
          <Empty className="border border-dashed p-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BellIcon />
              </EmptyMedia>
              <EmptyTitle>No alert rules yet</EmptyTitle>
              <EmptyDescription>
                A rule monitors a project's checks, certificates, errors, routes, or metrics. It
                notifies your team when a check goes down or a certificate nears expiry. It can
                report new, regressed, or spiking errors, slow or failing routes, and metrics above
                or below a value. It sends notifications through your selected email or webhook
                channels. It sends another notification when the alert ends.
              </EmptyDescription>
            </EmptyHeader>
            {canManage && <EmptyContent>{addButton}</EmptyContent>}
          </Empty>
        )}
        {dialog}
      </div>
    );
  }

  return (
    <div className="flex flex-col min-[64rem]:h-full min-[64rem]:min-h-0">
      <FilterBar
        label="Rules"
        filters={
          <p className="text-sm text-ink-subtle">
            {data.rules.length} of at most {data.maxRules} rules
          </p>
        }
        actions={
          <>
            <WorkbenchKeyHints />
            {addButton}
          </>
        }
      />
      <Workbench
        label="Alerts"
        className="min-[64rem]:min-h-0 min-[64rem]:flex-1"
        ids={data.rules.map((rule) => rule.id)}
        param="rule"
        onOpenPage={openPage}
        renderList={(props) => (
          <div className="flex flex-col">
            <div className="flex flex-col gap-3 px-gutter empty:hidden [&:not(:empty)]:pt-4">
              {notices}
            </div>
            <RuleTable
              rules={data.rules}
              projectId={projectId}
              checks={checkList}
              channels={channelList}
              timeZone={data.timeZone}
              canManage={canManage}
              onWarning={setNotice}
              onDeleted={afterDelete}
              {...props}
            />
            {full && (
              <p className="px-gutter py-4 text-sm text-ink-subtle">
                The project reached its alert rule limit. Delete a rule to add another.
              </p>
            )}
          </div>
        )}
        summary={<Summary data={data} projectId={projectId} />}
        narrowFooter={<Summary data={data} projectId={projectId} underList />}
        renderDetail={(ruleId) => (
          <div className="px-gutter py-5">
            <RuleView
              key={ruleId}
              projectId={projectId}
              ruleId={ruleId}
              onWarning={setNotice}
              onDeleted={() => afterDelete(ruleId)}
              inWorkbench
              actions={
                <ButtonLink
                  variant="ghost"
                  size="sm"
                  to="/projects/$projectId/alerts/$ruleId"
                  params={{ projectId, ruleId }}
                >
                  <ExternalLinkIcon aria-hidden="true" />
                  Open the rule&apos;s page
                </ButtonLink>
              }
            />
          </div>
        )}
      />
      {dialog}
    </div>
  );
}
