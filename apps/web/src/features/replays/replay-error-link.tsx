import { Link } from "@tanstack/react-router";

import { TruncatedText } from "@/components/truncated-text";
import { WhenAllowed } from "@/components/when-allowed";
import { DEFAULT_ENVIRONMENT } from "@/lib/analytics-api";
import type { ReplaySummary } from "@/lib/replays-api";

import { dayKey } from "../users/format";

/** The error a replay shows, linked to its group's page, on days that include it. */
export function ReplayErrorLink({
  projectId,
  replay,
  timeZone,
}: {
  projectId: string;
  replay: ReplaySummary;
  timeZone: string;
}) {
  const { error } = replay;
  if (error === null) {
    return (
      <span className="text-ink-subtle">
        {replay.linked ? "Error not found" : "Looking for its error…"}
      </span>
    );
  }
  const text = `${error.type}${error.message === "" ? "" : `: ${error.message}`}`;
  const environment = replay.environment ?? DEFAULT_ENVIRONMENT;
  return (
    <WhenAllowed
      area="errors"
      fallback={
        <TruncatedText text={text}>
          <span className="font-medium">{error.type}</span>
          {error.message !== "" && `: ${error.message}`}
        </TruncatedText>
      }
    >
      <TruncatedText
        text={text}
        className="text-link hover:underline"
        render={
          <Link
            to="/projects/$projectId/errors/$fingerprint"
            params={{ projectId, fingerprint: error.fingerprint }}
            // The error's own day, where it surely has an occurrence.
            search={{
              from: dayKey(error.occurredAt, timeZone),
              to: dayKey(error.occurredAt, timeZone),
              ...(environment === DEFAULT_ENVIRONMENT ? {} : { env: environment }),
            }}
          />
        }
      >
        <span className="font-medium">{error.type}</span>
        {error.message !== "" && `: ${error.message}`}
      </TruncatedText>
    </WhenAllowed>
  );
}
