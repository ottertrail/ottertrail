import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileCode2Icon, LoaderCircleIcon, OctagonAlertIcon, Trash2Icon } from "lucide-react";
import * as React from "react";

import { CopyableCode } from "@/components/copyable-code";
import { SettingsSection } from "@/components/settings-section";
import { TruncatedText } from "@/components/truncated-text";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ApiError } from "@/lib/api";
import {
  deleteSourceMaps,
  formatBytes,
  type ReleaseOrder,
  type SourceMapOverview,
  type SourceMapRelease,
  sourceMapFilesQuery,
  sourceMapsKey,
  sourceMapsQuery,
} from "@/lib/source-maps-api";

import { timeAgo } from "./format";

/** Match the CLI in packages/sourcemaps. */
function cliExample(origin: string): string {
  return `OTTERTRAIL_SECRET_KEY=sk_… npx @ottertrail/sourcemaps upload dist \\
  --release 1.4.2 --url-prefix / --host ${origin}`;
}

function curlExample(origin: string): string {
  return `curl -X PUT "${origin}/api/source-maps?release=1.4.2&path=/assets/index-4f3a.js" \\
  -H "Authorization: Bearer $OTTERTRAIL_SECRET_KEY" \\
  -H "Content-Type: application/json" \\
  --data-binary @dist/assets/index-4f3a.js.map`;
}

const code = (text: string) => <code className="font-mono">{text}</code>;

/** Keep the secret key as a placeholder in upload examples. */
function UploadHelp() {
  const origin = window.location.origin;
  return (
    <div className="flex flex-col gap-3 text-sm text-ink-muted">
      <p>
        After each build, upload one map per minified file and release. Use the secret key from Your
        server; keep it in your build's secrets.
      </p>
      <CopyableCode text={cliExample(origin)} copyLabel="Copy the upload command" />
      <p className="text-xs text-ink-subtle">
        The command is not on npm yet. Until it is published, run it from this repository's{" "}
        {code("packages/sourcemaps")}.
      </p>
      <p>Or upload one file at a time, with any HTTP client:</p>
      <CopyableCode text={curlExample(origin)} copyLabel="Copy the curl example" />
      <ul className="flex list-disc flex-col gap-1 pl-5">
        <li>
          {code("path")} is the minified file&apos;s path as the browser loads it, such as{" "}
          {code("/assets/index-4f3a.js")}, without the site&apos;s address.
        </li>
        <li>
          {code("release")} must match the {code("data-release")} on the tracker's script tag.
        </li>
        <li>
          In Vite, use {code('build.sourcemap: "hidden"')}. Upload the maps and exclude them from
          your deployment.
        </li>
      </ul>
    </div>
  );
}

function FilesDialog({ projectId, release }: { projectId: string; release: SourceMapRelease }) {
  const [open, setOpen] = React.useState(false);
  const files = useQuery({ ...sourceMapFilesQuery(projectId, release.release), enabled: open });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Show the files of release ${release.release}`}
        onClick={() => setOpen(true)}
      >
        <FileCode2Icon aria-hidden="true" />
      </Button>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Release {release.release}</DialogTitle>
        </DialogHeader>
        {files.isPending ? (
          <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-2/3" />
          </div>
        ) : files.isError ? (
          <Alert variant="destructive" role="alert">
            <OctagonAlertIcon />
            <AlertDescription>{files.error.message}</AlertDescription>
          </Alert>
        ) : files.data.length === 0 ? (
          <p className="text-sm text-ink-subtle">This release no longer has source maps.</p>
        ) : (
          <div className="max-h-96 overflow-y-auto">
            <table className="w-full table-fixed text-sm">
              <caption className="sr-only">Files of release {release.release}, by path</caption>
              <thead className="sticky top-0 bg-popover">
                <tr className="text-xs text-ink-subtle">
                  <th scope="col" className="pb-2 text-left font-normal">
                    Path
                  </th>
                  <th scope="col" className="w-24 pb-2 text-right font-normal">
                    Size
                  </th>
                </tr>
              </thead>
              <tbody>
                {files.data.map((file) => (
                  <tr key={file.path} className="border-t border-hairline">
                    <th
                      scope="row"
                      className="py-1.5 pr-3 text-left font-mono font-normal break-all text-ink"
                    >
                      {file.path}
                    </th>
                    <td className="py-1.5 text-right align-top text-ink-muted tabular-nums">
                      {formatBytes(file.bytes)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" type="button" />}>Close</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Delete maps only; errors stay. */
function DeleteReleaseDialog({
  projectId,
  release,
  returnFocus,
}: {
  projectId: string;
  release: SourceMapRelease;
  returnFocus: React.RefObject<HTMLElement | null>;
}) {
  const [open, setOpen] = React.useState(false);
  const deleted = React.useRef(false);
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: async () => {
      try {
        await deleteSourceMaps(projectId, release.release);
      } catch (error) {
        // Treat deletion in another tab as success.
        if (!(error instanceof ApiError && error.code === "no_source_maps")) throw error;
      }
    },
    onSuccess: () => {
      deleted.current = true;
      setOpen(false);
      // Remove the row even if refetching fails.
      queryClient.setQueriesData<SourceMapOverview>(
        { queryKey: [...sourceMapsKey(projectId), "list"] },
        (overview) =>
          overview === undefined
            ? undefined
            : {
                ...overview,
                ...(overview.instance === undefined
                  ? {}
                  : {
                      instance: {
                        ...overview.instance,
                        storedBytes: Math.max(0, overview.instance.storedBytes - release.bytes),
                      },
                    }),
                releases: overview.releases.filter((item) => item.release !== release.release),
                totalReleases: Math.max(0, overview.totalReleases - 1),
              },
      );
      void queryClient.invalidateQueries({ queryKey: sourceMapsKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: ["error", projectId] });
    },
  });
  const files = release.files === 1 ? "its 1 file" : `its ${release.files} files`;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) remove.reset();
      }}
    >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Delete the source maps of release ${release.release}`}
        onClick={() => setOpen(true)}
      >
        <Trash2Icon aria-hidden="true" />
      </Button>
      <DialogContent
        className="sm:max-w-md"
        finalFocus={() => (deleted.current && returnFocus.current) || true}
      >
        <DialogHeader>
          <DialogTitle>Delete the source maps of release {release.release}?</DialogTitle>
          <DialogDescription>
            The maps of {files} are permanently deleted. Your errors are retained. The stacks of
            release {release.release} show minified code again until its maps are uploaded again.
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
            Delete source maps
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReleaseTable({
  projectId,
  releases,
  order,
  returnFocus,
}: {
  projectId: string;
  releases: SourceMapRelease[];
  order: ReleaseOrder;
  returnFocus: React.RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <table className="w-full table-fixed text-sm">
      <caption className="sr-only">
        Releases with source maps, {order === "newest" ? "newest" : "oldest"} upload first
      </caption>
      <thead>
        <tr className="text-xs text-ink-subtle">
          <th scope="col" className="pb-2 text-left font-normal">
            Release
          </th>
          <th scope="col" className="w-14 pb-2 text-right font-normal">
            Files
          </th>
          <th scope="col" className="w-20 pb-2 text-right font-normal">
            Size
          </th>
          <th scope="col" className="w-32 pb-2 pl-3 text-left font-normal">
            Last uploaded
          </th>
          <th scope="col" className="w-18 pb-2">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {releases.map((release) => (
          <tr key={release.release} className="border-t border-hairline">
            <th scope="row" className="py-1.5 pr-3 text-left font-mono font-normal text-ink">
              <TruncatedText text={release.release} />
            </th>
            <td className="py-1.5 text-right text-ink tabular-nums">
              {release.files.toLocaleString("en")}
            </td>
            <td className="py-1.5 text-right text-ink tabular-nums">
              {formatBytes(release.bytes)}
            </td>
            <td className="py-1.5 pl-3 text-ink-muted">
              <time
                dateTime={release.lastUploadedAt}
                title={new Date(release.lastUploadedAt).toLocaleString()}
              >
                {timeAgo(new Date(release.lastUploadedAt))}
              </time>
            </td>
            <td className="py-0.5 text-right whitespace-nowrap">
              <FilesDialog projectId={projectId} release={release} />
              <DeleteReleaseDialog
                projectId={projectId}
                release={release}
                returnFocus={returnFocus}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function UploadHelpToggle() {
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  return (
    <div className="flex flex-col gap-3 border-t pt-4">
      <div>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((shown) => !shown)}
        >
          {open ? "Hide how to upload" : "Show how to upload"}
        </Button>
      </div>
      <div id={id} hidden={!open}>
        {open && <UploadHelp />}
      </div>
    </div>
  );
}

function OrderChoice({
  order,
  onOrder,
}: {
  order: ReleaseOrder;
  onOrder: (order: ReleaseOrder) => void;
}) {
  return (
    <ToggleGroup
      value={[order]}
      onValueChange={(value) => {
        const [next] = value;
        if (next === "newest" || next === "oldest") onOrder(next);
      }}
      aria-label="Order of releases"
      variant="outline"
      size="sm"
      spacing={0}
      className="self-start"
    >
      <ToggleGroupItem value="newest">Newest first</ToggleGroupItem>
      <ToggleGroupItem value="oldest">Oldest first</ToggleGroupItem>
    </ToggleGroup>
  );
}

function Overview({
  projectId,
  overview,
  onOrder,
  returnFocus,
}: {
  projectId: string;
  overview: SourceMapOverview;
  onOrder: (order: ReleaseOrder) => void;
  returnFocus: React.RefObject<HTMLHeadingElement | null>;
}) {
  if (!overview.configured) {
    return (
      <p className="text-sm text-ink-muted">
        Source maps are disabled on this instance because it has no object store for them. Its
        operator can enable them by setting {code("OBJECT_STORE_URL")}.
      </p>
    );
  }
  const { instance } = overview;
  return (
    <>
      {instance !== undefined && (
        <p className="text-sm text-ink-muted">
          <span className="text-ink tabular-nums">
            {formatBytes(instance.storedBytes)} of {formatBytes(instance.limitBytes)}
          </span>{" "}
          used, by all projects together.
        </p>
      )}
      {overview.releases.length === 0 ? (
        <>
          <p className="text-sm text-ink">No source maps are uploaded yet.</p>
          <UploadHelp />
        </>
      ) : (
        <>
          {overview.totalReleases > 1 && <OrderChoice order={overview.order} onOrder={onOrder} />}
          <ReleaseTable
            projectId={projectId}
            releases={overview.releases}
            order={overview.order}
            returnFocus={returnFocus}
          />
          {overview.totalReleases > overview.releases.length && (
            <p className="text-xs text-ink-subtle">
              {overview.releases.length.toLocaleString("en")} of{" "}
              {overview.totalReleases.toLocaleString("en")} releases are shown,{" "}
              {overview.order === "newest"
                ? "the newest. Select Oldest first to find and delete the oldest maps to free space."
                : "the oldest."}
            </p>
          )}
          <UploadHelpToggle />
        </>
      )}
    </>
  );
}

/** Deleting source maps keeps their errors (docs/errors.md, "Source maps"). */
export function SourceMapsCard({ projectId }: { projectId: string }) {
  const [order, setOrder] = React.useState<ReleaseOrder>("newest");
  const query = useQuery({
    ...sourceMapsQuery(projectId, order),
    placeholderData: keepPreviousData,
  });
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  return (
    <SettingsSection title="Source maps" headingRef={headingRef}>
      <div id="source-maps" className="flex flex-col gap-4">
        {query.isPending ? (
          <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : query.isError ? (
          <Alert variant="destructive">
            <OctagonAlertIcon />
            <AlertTitle>The source maps could not load</AlertTitle>
            <AlertDescription>{query.error.message}</AlertDescription>
            <AlertAction>
              <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        ) : (
          <Overview
            projectId={projectId}
            overview={query.data}
            onOrder={setOrder}
            returnFocus={headingRef}
          />
        )}
      </div>
    </SettingsSection>
  );
}
