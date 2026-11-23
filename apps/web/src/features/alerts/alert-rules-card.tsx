import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BellPlusIcon, OctagonAlertIcon } from "lucide-react";

import { ButtonLink } from "@/components/button-link";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAccess } from "@/lib/access";
import { type Rule, type RuleKind, rulesQuery, watchesCheck, watchesError } from "@/lib/alerts-api";
import type { ErrorStatus } from "@/lib/errors-api";
import { checksQuery } from "@/lib/uptime-api";

import { RuleStateBadge } from "./rule-state-badge";
import { watchesText } from "./rule-text";

export type Watched =
  | { checkId: string }
  | { fingerprint: string; environment: string; status: ErrorStatus };

/** Viewing needs uptime and alerts access; adding needs manage access (docs/access.md). */
export function AlertRulesCard({
  projectId,
  watched,
  className,
}: {
  projectId: string;
  watched: Watched;
  className?: string;
}) {
  const rules = useQuery(rulesQuery(projectId));
  const checks = useQuery(checksQuery(projectId));
  const canAdd = useAccess().canUse("uptime_alerts", "manage");
  const watching = (rules.data?.rules ?? []).filter((rule: Rule) =>
    "checkId" in watched
      ? watchesCheck(rule, watched.checkId)
      : watchesError(rule, watched.fingerprint, watched.environment),
  );
  const add: RuleKind = "checkId" in watched ? "check_down" : "error_spike";
  const search =
    "checkId" in watched
      ? { add, check: watched.checkId }
      : { add, fingerprint: watched.fingerprint, env: watched.environment };
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>
          <h3>Alert rules</h3>
        </CardTitle>
        {canAdd && (
          <CardAction>
            <ButtonLink
              variant="outline"
              size="sm"
              to="/projects/$projectId/alerts"
              params={{ projectId }}
              search={search}
            >
              <BellPlusIcon aria-hidden="true" />
              Add an alert rule
            </ButtonLink>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {rules.isError ? (
          <Alert variant="destructive">
            <OctagonAlertIcon />
            <AlertDescription>{rules.error.message}</AlertDescription>
          </Alert>
        ) : rules.data === undefined ? (
          <Skeleton className="h-10 w-full" aria-label="Loading" />
        ) : watching.length === 0 ? (
          <p className="text-sm text-ink-subtle">No rule watches it yet.</p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Alert rules that watch it">
            {watching.map((rule) => (
              <li key={rule.id} className="flex flex-wrap items-center gap-2 text-sm">
                <RuleStateBadge rule={rule} />
                <Link
                  to="/projects/$projectId/alerts"
                  params={{ projectId }}
                  search={{ rule: rule.id }}
                  className="font-medium text-link hover:underline"
                >
                  {rule.name}
                </Link>
                <span className="text-ink-subtle">
                  {watchesText(rule, checks.data?.checks ?? [])}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
