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

/**
 * The environment variables every OpenTelemetry SDK reads. The secret key
 * stays a placeholder: the page never prints the real one.
 */
function exporterSettings(origin: string): string {
  return `OTEL_EXPORTER_OTLP_ENDPOINT=${origin}
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20sk_…
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_SERVICE_NAME=checkout
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production,service.version=1.4.2`;
}

const TITLES = { traces: "No traces yet", logs: "No logs yet", metrics: "No metrics yet" };

/**
 * Shown while a project has sent no spans (or no log records, or no
 * metrics) at all:
 * how a server sends them, over OTLP/HTTP with the project's secret key.
 */
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
          Your servers send {signal} with OpenTelemetry: any of its SDKs, or a Collector, over
          OTLP/HTTP to this instance. Requests need the project&apos;s secret key, under &ldquo;Your
          server&rdquo; in the project&apos;s settings; keep it on your server. They are kept{" "}
          {retentionDays} days.
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
          >
            Project settings
          </ButtonLink>
        </WhenAllowed>
      </EmptyContent>
    </Empty>
  );
}
