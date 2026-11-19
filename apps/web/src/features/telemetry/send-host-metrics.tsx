import { ServerIcon } from "lucide-react";

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
 * A minimal OpenTelemetry Collector configuration for host metrics: the
 * host metrics receiver's six scrapers with the utilization metrics on (so
 * the shares are exact), snap packages' read-only images, loopback and
 * container interfaces, and partitions and virtual disks left out (so
 * nothing counts twice); host.name from the operating system, batches,
 * and OTLP/HTTP to this instance. The secret key stays a placeholder: the
 * page never prints the real one.
 */
function collectorConfig(origin: string): string {
  return `receivers:
  host_metrics:
    collection_interval: 1m
    scrapers:
      cpu:
        metrics:
          system.cpu.utilization:
            enabled: true
      memory:
        metrics:
          system.memory.utilization:
            enabled: true
      filesystem:
        exclude_fs_types:
          fs_types: [squashfs]
          match_type: strict
        exclude_mount_points:
          mount_points: ['^/snap/.*$']
          match_type: regexp
        metrics:
          system.filesystem.utilization:
            enabled: true
      network:
        exclude:
          interfaces: ['^(lo|veth.*|docker.*|br-.*)$']
          match_type: regexp
      disk:
        exclude:
          devices:
            - '^(loop|ram|sr|dm-)[0-9]*$'
            - '^(sd|vd|xvd|hd)[a-z]+[0-9]+$'
            - '^(nvme[0-9]+n[0-9]+|mmcblk[0-9]+)p[0-9]+$'
          match_type: regexp
      load:

processors:
  resource_detection:
    detectors: [system]
    system:
      hostname_sources: [os]
  batch:
    send_batch_max_size: 8192

exporters:
  otlp_http:
    endpoint: ${origin}
    headers:
      Authorization: Bearer sk_…

service:
  pipelines:
    metrics:
      receivers: [host_metrics]
      processors: [resource_detection, batch]
      exporters: [otlp_http]`;
}

/**
 * Shown while a project has sent no host metrics at all: how a server's
 * OpenTelemetry Collector sends them, with the project's secret key.
 */
export function SendHostMetrics({
  projectId,
  retentionDays,
}: {
  projectId: string;
  retentionDays: number;
}) {
  return (
    <Empty className="border border-dashed p-10">
      <EmptyHeader className="max-w-xl">
        <EmptyMedia variant="icon">
          <ServerIcon />
        </EmptyMedia>
        <EmptyTitle>No hosts yet</EmptyTitle>
        <EmptyDescription>
          Run an OpenTelemetry Collector with a host metrics receiver on each server. Send its
          measurements to this instance over OTLP/HTTP. Servers are listed by host name. Requests
          need the project's secret key from “Your server” in the project's settings. Keep it on
          your server. Metrics are kept for {retentionDays} days.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="max-w-2xl text-left">
        <CopyableCode
          text={collectorConfig(window.location.origin)}
          copyLabel="Copy the configuration"
        />
        <p className="text-sm text-ink-subtle">
          Replace <code className="font-mono">sk_…</code> with the secret key. The exclusions remove
          read-only snap images, loopback and container interfaces, disk partitions, and virtual
          devices from the measurements. This excludes filesystems that are full by design and
          prevents duplicate counts. The exporter adds{" "}
          <code className="font-mono">/v1/metrics</code> to the endpoint. Collector releases from
          before the components were renamed call them{" "}
          <code className="font-mono">hostmetrics</code>,{" "}
          <code className="font-mono">resourcedetection</code>, and{" "}
          <code className="font-mono">otlphttp</code>.
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
