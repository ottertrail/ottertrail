import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircleIcon, OctagonAlertIcon, Trash2Icon } from "lucide-react";
import * as React from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAccess } from "@/lib/access";
import type { PageRange } from "@/lib/analytics-api";
import {
  deleteHeatmapSnapshot,
  type HeatmapDevice,
  type HeatmapSnapshot,
  type HeatmapSnapshots,
  heatmapSnapshotsKey,
  heatmapSnapshotsQuery,
  snapshotPlayerSrc,
} from "@/lib/heatmaps-api";
import { playerUrlInTheme, themeMessage } from "@/lib/replay-messages";
import { useTheme } from "@/lib/theme";

import { formatWhole } from "../analytics/format";
import { elementTitle, formatSavedAt } from "./format";
import { type MissingElements, readSnapshotMissingMessage } from "./snapshot-messages";

/** Asks before deleting the saved view; the heatmap's data stays. */
function DeleteSnapshot({
  projectId,
  path,
  device,
}: {
  projectId: string;
  path: string;
  device: HeatmapDevice;
}) {
  const [open, setOpen] = React.useState(false);
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => deleteHeatmapSnapshot(projectId, device, path),
    onSuccess: () => {
      setOpen(false);
      queryClient.setQueryData<HeatmapSnapshots>(heatmapSnapshotsKey(projectId, path), (answer) =>
        answer === undefined
          ? undefined
          : { ...answer, snapshots: answer.snapshots.filter((item) => item.device !== device) },
      );
      void queryClient.invalidateQueries({ queryKey: heatmapSnapshotsKey(projectId, path) });
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) remove.reset();
      }}
    >
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Trash2Icon aria-hidden="true" />
        Delete
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete the saved view?</DialogTitle>
          <DialogDescription>
            The {device} view of <span className="font-mono">{path}</span> is permanently deleted.
            The heatmap&apos;s data stays.
          </DialogDescription>
        </DialogHeader>
        {remove.error !== null && (
          <Alert variant="destructive" role="alert">
            <OctagonAlertIcon />
            <AlertDescription>{remove.error.message}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
          <Button variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>
            {remove.isPending && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The elements of the heatmap the snapshot does not have, with their clicks. */
function NotOnSnapshot({ missing }: { missing: MissingElements }) {
  if (missing.total === 0) return null;
  const more = missing.total - missing.items.length;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-ink-muted">
        Not on this snapshot ({formatWhole(missing.total)})
      </summary>
      <ul aria-label="Not on this snapshot" className="mt-2 flex flex-col gap-1">
        {missing.items.map((item) => (
          <li key={`${item.label ?? ""}\u0000${item.element}`} className="flex gap-2">
            <span className="min-w-0 font-mono text-xs break-all">
              {elementTitle(item.label, item.element)}
            </span>
            <span className="shrink-0 text-ink-subtle tabular-nums">
              {formatWhole(item.clicks)} {item.clicks === 1 ? "click" : "clicks"}
            </span>
          </li>
        ))}
        {more > 0 && <li className="text-ink-subtle">and {formatWhole(more)} more</li>}
      </ul>
    </details>
  );
}

/**
 * A saved view: the page as its owner saved it from the overlay, rebuilt
 * in the replay player's frame with this report's heatmap drawn over it
 * (docs/dashboard.md, "Heatmaps"). The frame is an API page under its own
 * Content Security Policy; it sends back only the elements it did not
 * find, checked (snapshot-messages.ts).
 */
function SavedView({
  projectId,
  path,
  snapshot,
  range,
  environment,
  timeZone,
}: {
  projectId: string;
  path: string;
  snapshot: HeatmapSnapshot;
  range: PageRange;
  environment: string;
  timeZone: string;
}) {
  const frameRef = React.useRef<HTMLIFrameElement>(null);
  const { theme } = useTheme();
  // Deleting a saved view is the owner's and admins' (docs/access.md); members see it.
  const canManage = useAccess().can("projects");
  const src = `${snapshotPlayerSrc(projectId, snapshot.device, path, range, environment)}&v=${encodeURIComponent(snapshot.savedAt)}`;
  // The theme of the moment the view opened, for its first paint; later ones as a message.
  const [opened, setOpened] = React.useState({ src, theme });
  if (opened.src !== src) setOpened({ src, theme });
  const frameSrc = playerUrlInTheme(opened.src, opened.theme);
  // What the frame said, for the address it said it from: a new view starts with nothing.
  const [heard, setHeard] = React.useState<{ src: string; missing: MissingElements } | null>(null);
  const missing =
    heard !== null && heard.src === frameSrc ? heard.missing : { items: [], total: 0 };

  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const said = readSnapshotMissingMessage(
        event,
        frameRef.current?.contentWindow,
        window.location.origin,
      );
      const from = frameRef.current?.getAttribute("src");
      if (said !== null && typeof from === "string") setHeard({ src: from, missing: said });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  React.useEffect(() => {
    frameRef.current?.contentWindow?.postMessage(themeMessage(theme), window.location.origin);
  }, [theme]);

  return (
    <section aria-label="Saved view" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-ink-subtle" data-slot="saved-by">
          Saved {formatSavedAt(snapshot.savedAt, timeZone)}
          {snapshot.savedBy === null ? "" : ` by ${snapshot.savedBy}`} at {snapshot.width} px wide.
        </p>
        {canManage && <DeleteSnapshot projectId={projectId} path={path} device={snapshot.device} />}
      </div>
      {/* No sandbox: the player must run its script and read the snapshot as the
          signed-in user, and the page's own Content Security Policy keeps the
          snapshot from running anything (its frame inside is rrweb's sandbox). */}
      {/* oxlint-disable-next-line react/iframe-missing-sandbox */}
      <iframe
        ref={frameRef}
        src={frameSrc}
        title={`Saved view of ${path} with its heatmap`}
        referrerPolicy="no-referrer"
        onLoad={() =>
          frameRef.current?.contentWindow?.postMessage(themeMessage(theme), window.location.origin)
        }
        style={{ aspectRatio: `${snapshot.width} / ${snapshot.height}` }}
        className="max-h-[75vh] min-h-64 w-full rounded-lg border-0 bg-canvas ring-1 ring-border"
      />
      <NotOnSnapshot missing={missing} />
    </section>
  );
}

/**
 * The page's saved view for the device the report shows, with the heatmap
 * over it; without one, a line on how to save it. Nothing for all devices,
 * or where the server keeps no saved views (no object store).
 */
export function SnapshotSection({
  projectId,
  path,
  device,
  range,
  environment,
  timeZone,
}: {
  projectId: string;
  path: string;
  device: HeatmapDevice | undefined;
  range: PageRange;
  environment: string;
  timeZone: string;
}) {
  const snapshots = useQuery(heatmapSnapshotsQuery(projectId, path));
  const canSave = useAccess().can("projects");
  if (snapshots.data === undefined || !snapshots.data.configured || device === undefined) {
    return null;
  }
  const snapshot = snapshots.data.snapshots.find((item) => item.device === device);
  if (snapshot === undefined) {
    return (
      <p className="max-w-4xl text-xs text-pretty text-ink-subtle" data-slot="no-saved-view">
        {canSave ? (
          <>
            To see this heatmap over the page here, open it with &ldquo;Open on your site&rdquo; and
            press &ldquo;Save this view&rdquo;.
          </>
        ) : (
          "No saved view of this page yet. Only the owner and admins can save one."
        )}
      </p>
    );
  }
  return (
    <SavedView
      projectId={projectId}
      path={path}
      snapshot={snapshot}
      range={range}
      environment={environment}
      timeZone={timeZone}
    />
  );
}
