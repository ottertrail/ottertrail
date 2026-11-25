import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import { TruncatedText } from "@/components/truncated-text";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DEFAULT_ENVIRONMENT, type PageRange } from "@/lib/analytics-api";
import {
  type FunnelStep,
  type FunnelWindow,
  funnelPeopleQuery,
  type PeopleOutcome,
} from "@/lib/product-api";

import { formatWhole } from "../analytics/format";
import { formatMoment } from "../uptime/format";
import { stepText } from "./funnel-steps";
import { LoadFailed, LoadingRows } from "./report-state";

/** Which list is open: the step (from 1), and whether its people dropped off or converted. */
export interface PeopleList {
  step: number;
  outcome: PeopleOutcome;
}

const peopleTitle = ({ step, outcome }: PeopleList) =>
  outcome === "converted" ? "Converted" : `Dropped off after step ${step}`;

/**
 * The signed-in users who dropped off after a step, or converted at the
 * last: up to 100, most recent first, each a link to their page in Users.
 */
export function FunnelPeopleDialog({
  list,
  onClose,
  projectId,
  range,
  environment,
  steps,
  window,
  timeZone,
}: {
  list: PeopleList | null;
  onClose: () => void;
  projectId: string;
  range: PageRange;
  environment: string;
  steps: FunnelStep[];
  window: FunnelWindow;
  timeZone: string;
}) {
  // The last list opened, so the dialog keeps its content while it closes.
  const [shown, setShown] = React.useState(list);
  if (list !== null && list !== shown) setShown(list);
  const people = useQuery({
    ...funnelPeopleQuery(
      projectId,
      range,
      environment,
      steps,
      window,
      shown?.step ?? 1,
      shown?.outcome ?? "dropped",
    ),
    enabled: shown !== null,
  });
  const step = shown === null ? undefined : steps[shown.step - 1];
  const next = shown === null ? undefined : steps[shown.step];
  const data = people.data;

  return (
    <Dialog
      open={list !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{shown === null ? "" : peopleTitle(shown)}</DialogTitle>
          {shown !== null && step !== undefined && (
            <DialogDescription>
              {shown.outcome === "converted" || next === undefined
                ? `Users who reached step ${shown.step}, ${stepText(step)}.`
                : `Users who reached step ${shown.step}, ${stepText(step)}, and not step ${shown.step + 1}, ${stepText(next)}.`}{" "}
              Most recent first.
            </DialogDescription>
          )}
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={people.isFetching}>
          {people.isError ? (
            <LoadFailed
              what="The list"
              message={people.error.message}
              hasData={false}
              onRetry={() => void people.refetch()}
            />
          ) : data === undefined ? (
            <LoadingRows rows={4} />
          ) : data.users.length === 0 ? (
            <p className="text-sm text-ink-subtle">No users.</p>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-ink-subtle">
                {data.total > data.users.length
                  ? `The ${formatWhole(data.users.length)} most recent of ${formatWhole(data.total)} users.`
                  : `${formatWhole(data.total)} ${data.total === 1 ? "user" : "users"}.`}
              </p>
              <ul aria-label="Users" className="flex flex-col">
                {data.users.map((user) => (
                  <li
                    key={user.userId}
                    className="flex items-baseline justify-between gap-4 border-b py-2 last:border-b-0"
                  >
                    <TruncatedText
                      text={user.userId}
                      className="rounded-sm font-mono text-sm text-link hover:underline"
                      render={
                        <Link
                          to="/projects/$projectId/users/$userId"
                          params={{ projectId, userId: user.userId }}
                          search={environment === DEFAULT_ENVIRONMENT ? {} : { env: environment }}
                        />
                      }
                    />
                    <span className="shrink-0 text-xs text-ink-subtle tabular-nums">
                      {formatMoment(user.reachedAt, timeZone)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
