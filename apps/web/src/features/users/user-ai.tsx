import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { OctagonAlertIcon } from "lucide-react";

import { BreakdownTable } from "@/components/breakdown-table";
import { StatStrip } from "@/components/stat-strip";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { type AiFeatureRow, type AiModelRow, aiReportQuery } from "@/lib/ai-api";
import type { PageRange } from "@/lib/analytics-api";
import { MISSING } from "@/lib/missing";

import { aiCallsSearchOf } from "../ai/calls-search";
import { featureLabel, formatMs, formatTokens, formatUsd, modelLabel } from "../ai/format";
import { formatConversion, formatCount, formatWhole } from "../analytics/format";
import { aiSearchOf } from "../telemetry/search";

/** The user page has no period picker. */
const RANGE: PageRange = { period: "30d" };

const LISTED = 3;

const share = (value: number | null) => (value === null ? MISSING : formatConversion(value));

const rowOf = (key: string, label: string, row: AiModelRow | AiFeatureRow) => ({
  key,
  label,
  title: label,
  bar: row.costUsd,
  figures: [formatUsd(row.costUsd), formatWhole(row.calls)],
});

/** Requires AI and users access. Show 30 days of metadata, never prompts or answers (docs/ai-usage.md, "A user's AI usage"). */
export function UserAi({
  projectId,
  userId,
  environment,
}: {
  projectId: string;
  userId: string;
  environment: string;
}) {
  const report = useQuery(aiReportQuery(projectId, RANGE, environment, { user: userId }));
  const data = report.data;
  if (data !== undefined && !data.received) return null;

  const heading = (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h3 id="user-ai" className="text-sm font-medium text-ink-subtle">
        AI in the last 30 days
      </h3>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <Link
          to="/projects/$projectId/ai/calls"
          params={{ projectId }}
          search={aiCallsSearchOf({ range: RANGE, environment, filters: { user: userId } })}
          className="text-sm whitespace-nowrap text-link hover:underline"
        >
          AI calls
        </Link>
        <Link
          to="/projects/$projectId/ai"
          params={{ projectId }}
          search={aiSearchOf({ range: RANGE, environment, filters: {} })}
          className="text-sm whitespace-nowrap text-link hover:underline"
        >
          AI page
        </Link>
      </div>
    </div>
  );

  const failure = report.isError && (
    <Alert variant="destructive">
      <OctagonAlertIcon />
      <AlertTitle>
        {data === undefined ? "The AI usage could not load" : "The AI usage could not refresh"}
      </AlertTitle>
      <AlertDescription>
        {report.error.message}
        {data !== undefined && " The figures below are from the last successful load."}
      </AlertDescription>
      <AlertAction>
        <Button variant="outline" size="sm" onClick={() => void report.refetch()}>
          Retry
        </Button>
      </AlertAction>
    </Alert>
  );

  if (data === undefined) {
    if (report.isError) {
      return (
        <section className="flex flex-col gap-2" aria-labelledby="user-ai">
          {heading}
          {failure}
        </section>
      );
    }
    // Avoid layout shifts for projects that have no AI calls.
    return null;
  }

  const { totals } = data;
  const unpriced = totals.noPriceCalls;
  return (
    <section className="flex flex-col gap-3" aria-labelledby="user-ai">
      {heading}
      {failure}
      {totals.calls === 0 ? (
        <p className="text-sm text-ink-subtle">No AI calls from this user in the last 30 days.</p>
      ) : (
        <>
          <StatStrip
            label="The user's AI usage"
            stats={[
              { label: "Calls", value: formatCount(totals.calls) },
              { label: "Estimated cost (USD)", value: formatUsd(totals.costUsd) },
              { label: "Input tokens", value: formatTokens(totals.inputTokens) },
              { label: "Output tokens", value: formatTokens(totals.outputTokens) },
              { label: "Failed", value: share(totals.failedShare) },
              { label: "95th percentile", value: formatMs(totals.p95Ms) },
            ]}
          />
          {/* Use content width because the workbench pane is narrower than the page. */}
          <div className="@container">
            <div className="grid gap-6 @2xl:grid-cols-2">
              <BreakdownTable
                title="Models"
                headingLevel={4}
                caption="The models that cost this user the most, the costliest first"
                nameHeading="Model"
                figureHeadings={["Est. cost", "Calls"]}
                rows={data.models
                  .slice(0, LISTED)
                  .map((row) =>
                    rowOf(
                      row.other ? "\u0000other" : row.model,
                      row.other ? "Other models" : modelLabel(row.model),
                      row,
                    ),
                  )}
                empty=""
                layout="stack"
              />
              <BreakdownTable
                title="Features"
                headingLevel={4}
                caption="The features that cost this user the most, the costliest first"
                nameHeading="Feature"
                figureHeadings={["Est. cost", "Calls"]}
                rows={data.features
                  .slice(0, LISTED)
                  .map((row) =>
                    rowOf(
                      row.other ? "\u0000other" : row.feature,
                      row.other ? "Other features" : featureLabel(row.feature),
                      row,
                    ),
                  )}
                empty=""
                layout="stack"
              />
            </div>
          </div>
          <p className="text-xs text-pretty text-ink-subtle">
            Cost is an estimate from token counts and model prices.
            {unpriced > 0 &&
              ` ${formatWhole(unpriced)} ${unpriced === 1 ? "call" : "calls"} had no price and ${unpriced === 1 ? "is" : "are"} not in it.`}
          </p>
        </>
      )}
    </section>
  );
}
