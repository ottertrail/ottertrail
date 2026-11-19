import { ExternalLinkIcon } from "lucide-react";
import * as React from "react";

import { ButtonLink } from "@/components/button-link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAccess } from "@/lib/access";
import { ApiError } from "@/lib/api";
import { type HeatmapDevice, mintOverlayLink } from "@/lib/heatmaps-api";

import {
  isLocalHostname,
  isPort,
  OVERLAY_WIDTHS,
  overlayUrl,
  popupFeatures,
  siteOrigin,
} from "./overlay-link";

/** The project has no hostname to open: what to add, and where. */
function NoHostname({ projectId }: { projectId: string }) {
  const canManage = useAccess().can("projects");
  return (
    <div data-slot="open-on-site" className="flex max-w-xl flex-col items-start gap-2">
      <p className="text-xs text-pretty text-ink-subtle">
        To see this heatmap over your live page, the project needs your site&apos;s hostname (such
        as www.example.com) in its allowed sites.
        {canManage ? "" : " An owner or admin adds it in the project's settings."}
      </p>
      {canManage && (
        <ButtonLink
          variant="outline"
          size="sm"
          to="/projects/$projectId/settings"
          params={{ projectId }}
          search={{ tab: "general" }}
        >
          Add your site&apos;s hostname
        </ButtonLink>
      )}
    </div>
  );
}

/**
 * "Open on your site": opens the page on the project's site, in a window
 * as wide as the device the report shows (desktop for all devices), with a one-time link that makes the tracker there
 * draw this heatmap over the page for this user only (docs/web-analytics.md,
 * "The overlay on your site"). The link is made when the button is pressed.
 */
export function OpenOnSite({
  projectId,
  path,
  hostnames,
  device,
}: {
  projectId: string;
  path: string;
  /** The project's allowed hostnames. */
  hostnames: readonly string[];
  /** The device the report shows: the window opens at its width (desktop for all devices). */
  device: HeatmapDevice | undefined;
}) {
  const [chosenHost, setChosenHost] = React.useState<string | undefined>(undefined);
  const [port, setPort] = React.useState("");
  const [opening, setOpening] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const noteId = React.useId();
  const portId = React.useId();
  if (hostnames.length === 0) return <NoHostname projectId={projectId} />;
  const hostname =
    chosenHost !== undefined && hostnames.includes(chosenHost) ? chosenHost : (hostnames[0] ?? "");
  // The device filtered on; all devices open at desktop width.
  const size = OVERLAY_WIDTHS.find((item) => item.value === device) ?? OVERLAY_WIDTHS[2];
  const local = isLocalHostname(hostname);
  const portValid = !local || isPort(port.trim());

  const open = async () => {
    setProblem(null);
    // Opened now, while the click still counts: a window opened after the
    // request would be blocked as a pop-up.
    const popup = window.open("", "_blank", popupFeatures(size, window.screen));
    if (popup === null) {
      setProblem(
        "Your browser blocked the new window. Allow pop-ups for this page, then try again.",
      );
      return;
    }
    // The site's page must not reach back to the dashboard.
    popup.opener = null;
    setOpening(true);
    try {
      const { token } = await mintOverlayLink(projectId);
      popup.location.href = overlayUrl(siteOrigin(hostname, local ? port.trim() : ""), path, token);
    } catch (error) {
      popup.close();
      setProblem(
        error instanceof ApiError ? error.message : "The link could not be made. Try again.",
      );
    } finally {
      setOpening(false);
    }
  };

  return (
    <div data-slot="open-on-site" className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {hostnames.length > 1 && (
          <Select
            items={hostnames.map((item) => ({ value: item, label: item }))}
            value={hostname}
            onValueChange={(value) => {
              if (typeof value === "string") setChosenHost(value);
            }}
          >
            <SelectTrigger aria-label="Site" size="sm" className="max-w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {hostnames.map((item) => (
                <SelectItem key={item} value={item}>
                  {item}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {local && (
          <Input
            id={portId}
            aria-label="Port"
            placeholder="Port"
            inputMode="numeric"
            className="h-7 w-20"
            value={port}
            aria-invalid={!portValid}
            onChange={(event) => setPort(event.target.value)}
          />
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => void open()}
          disabled={opening || !portValid}
          aria-describedby={noteId}
        >
          <ExternalLinkIcon aria-hidden="true" />
          {opening ? "Opening…" : "Open on your site"}
        </Button>
      </div>
      <p id={noteId} className="max-w-xl text-right text-xs text-pretty text-ink-subtle">
        Opens {siteOrigin(hostname, local ? port.trim() : "").replace(/^https?:\/\//, "")}
        {path} at {size.label.toLowerCase()} width ({size.width} px) with a heatmap overlay only you
        can see. The link works once, within 5 minutes. Browsers may ignore the window size.
      </p>
      {problem !== null && (
        <p role="alert" className="max-w-xl text-right text-xs text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}
