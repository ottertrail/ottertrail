import { RadioTowerIcon } from "lucide-react";

import { ButtonLink } from "@/components/button-link";
import { CopyableCode } from "@/components/copyable-code";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { WhenAllowed } from "@/components/when-allowed";

/** Keep the secret key as a placeholder in SDK environment examples. */
function exporterSettings(origin: string): string {
  return `OTEL_EXPORTER_OTLP_ENDPOINT=${origin}
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20sk_…
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_SERVICE_NAME=checkout
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production,service.version=1.4.2`;
}

const TITLES = { traces: "No traces yet", logs: "No logs yet", metrics: "No metrics yet" };

export function SendTelemetry({
  projectId,
  signal,
  retentionDays,
}: {
  projectId: string;
  signal: "traces" | "logs" | "metrics";
  retentionDays: number;
}) {
  const origin = window.location.origin;
  return (
    <Empty className="border border-dashed p-10">
      <EmptyHeader className="max-w-xl">
        <EmptyMedia variant="icon">
          <RadioTowerIcon />
        </EmptyMedia>
        <EmptyTitle>{TITLES[signal]}</EmptyTitle>
        <EmptyDescription>
          Your servers send {signal} with any OpenTelemetry SDK or a Collector. Use OTLP/HTTP to
          send data to this instance. Requests need the project's secret key from “Your server” in
          the project's settings. Keep it on your server. Data is kept for {retentionDays} days.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="max-w-2xl text-left">
        <CopyableCode text={exporterSettings(origin)} copyLabel="Copy the settings" />
        <p className="text-sm text-ink-subtle">
          The SDK adds <code className="font-mono">/v1/traces</code>,{" "}
          <code className="font-mono">/v1/logs</code>, and{" "}
          <code className="font-mono">/v1/metrics</code> to the endpoint. Replace{" "}
          <code className="font-mono">sk_…</code> with the secret key, and name your service and
          environment.
        </p>
        <WhenAllowed permission="projects">
          <ButtonLink
            variant="outline"
            className="self-center"
            to="/projects/$projectId/settings"
            params={{ projectId }}
            search={{ tab: "server" }}
          >
            Project settings
          </ButtonLink>
        </WhenAllowed>
      </EmptyContent>
    </Empty>
  );
}
