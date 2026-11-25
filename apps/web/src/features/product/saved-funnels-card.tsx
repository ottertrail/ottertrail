import { type UseQueryResult, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { LoaderCircleIcon, OctagonAlertIcon, PencilIcon, Trash2Icon } from "lucide-react";
import * as React from "react";

import { PINNED, PINNED_END } from "@/components/pinned-column";
import { ScrollHint } from "@/components/scroll-hint";
import { TruncatedText } from "@/components/truncated-text";
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { WhenAllowed } from "@/components/when-allowed";
import { ApiError } from "@/lib/api";
import {
  deleteFunnel,
  MAX_SAVED_FUNNELS,
  type SavedFunnel,
  savedFunnelsKey,
  updateFunnel,
} from "@/lib/funnels-api";
import { MISSING } from "@/lib/missing";
import type { SavedFunnelResult, SavedFunnelResults } from "@/lib/product-api";

import { formatWhole } from "../analytics/format";
import { countLine, formatShare, stepsLine } from "./format";
import { FunnelNameDialog } from "./funnel-name-dialog";
import { LoadFailed, LoadingRows } from "./report-state";
import { type FunnelSearch, funnelSearchOf, isShownFunnel, stepsFrom } from "./search";

function RenameFunnelDialog({ projectId, funnel }: { projectId: string; funnel: SavedFunnel }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Rename the funnel ${funnel.name}`}
        onClick={() => setOpen(true)}
      >
        <PencilIcon aria-hidden="true" />
      </Button>
      <FunnelNameDialog
        open={open}
        onOpenChange={setOpen}
        projectId={projectId}
        title={`Rename the funnel “${funnel.name}”`}
        initialName={funnel.name}
        submitLabel="Rename funnel"
        save={(name) =>
          updateFunnel(projectId, funnel, name, {
            steps: funnel.steps,
            count: funnel.count,
            window: funnel.window,
          })
        }
        onSaved={() => setOpen(false)}
      />
    </>
  );
}

/** Delete only the definition; events stay. */
function DeleteFunnelDialog({
  projectId,
  funnel,
  returnFocus,
  onDeleted,
}: {
  projectId: string;
  funnel: SavedFunnel;
  returnFocus: React.RefObject<HTMLElement | null>;
  onDeleted: (funnel: SavedFunnel) => void;
}) {
  const [open, setOpen] = React.useState(false);
  // Deletion removes the trigger. Return focus to the heading; Cancel returns to the trigger.
  const deleted = React.useRef(false);
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: async () => {
      try {
        await deleteFunnel(projectId, funnel.id);
      } catch (error) {
        // Treat deletion in another tab as success.
        if (!(error instanceof ApiError && error.code === "funnel_not_found")) throw error;
      }
    },
    onSuccess: () => {
      deleted.current = true;
      setOpen(false);
      onDeleted(funnel);
      // Remove the row even if refetching fails.
      queryClient.setQueryData<SavedFunnel[]>(savedFunnelsKey(projectId), (list) =>
        list?.filter((item) => item.id !== funnel.id),
      );
      void queryClient.invalidateQueries({ queryKey: savedFunnelsKey(projectId) });
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
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Delete the funnel ${funnel.name}`}
        onClick={() => setOpen(true)}
      >
        <Trash2Icon aria-hidden="true" />
      </Button>
      <DialogContent
        className="sm:max-w-md"
        finalFocus={() => (deleted.current && returnFocus.current) || true}
      >
        <DialogHeader>
          <DialogTitle>Delete the funnel “{funnel.name}”?</DialogTitle>
          <DialogDescription>
            Your events are kept. You can recreate this funnel later.
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
            Delete funnel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The saved funnel's counts, if the answer holds them for its current definition. */
function resultFor(
  results: SavedFunnelResults | undefined,
  funnel: SavedFunnel,
): SavedFunnelResult | undefined {
  const result = results?.funnels.find((item) => item.id === funnel.id);
  // A funnel changed since the answer was read has none until it is read again.
  return result !== undefined &&
    isShownFunnel(
      { steps: result.steps.map((item) => item.step), count: result.count, window: result.window },
      { steps: stepsFrom(funnel.steps), count: funnel.count, window: funnel.window },
    )
    ? result
    : undefined;
}

/** The overall conversion, with the people at the first and last steps under it. */
function ConversionCell({
  funnel,
  results,
}: {
  funnel: SavedFunnel;
  results: UseQueryResult<SavedFunnelResults>;
}) {
  const result = resultFor(results.data, funnel);
  if (result === undefined) {
    if (results.isError) {
      return (
        <div className="flex items-center gap-2">
          <span className="text-xs text-destructive">Not loaded</span>
          <Button
            variant="outline"
            size="xs"
            aria-label={`Retry the conversion of ${funnel.name}`}
            onClick={() => void results.refetch()}
          >
            Retry
          </Button>
        </div>
      );
    }
    if (results.isFetching || results.isPending) {
      return (
        <div className="flex flex-col gap-1" aria-busy="true" aria-label="Loading">
          <Skeleton className="h-4 w-10" />
          <Skeleton className="h-3 w-20" />
        </div>
      );
    }
    return <span className="text-ink-subtle">{MISSING}</span>;
  }
  const first = result.steps[0]?.reached ?? 0;
  const last = result.steps.at(-1)?.reached ?? 0;
  const who = result.count === "users" ? "users" : "visitors";
  return (
    <div
      className="flex flex-col tabular-nums transition-opacity data-[stale=true]:opacity-60"
      data-stale={results.isPlaceholderData}
    >
      <span aria-hidden="true" className="text-ink">
        {formatShare(last, first)}
      </span>
      <span aria-hidden="true" className="text-xs whitespace-nowrap text-ink-subtle">
        {formatWhole(first)} → {formatWhole(last)}
      </span>
      <span className="sr-only">
        {first === 0
          ? `No ${who} did step 1`
          : `${formatShare(last, first)}: ${formatWhole(last)} of ${formatWhole(first)} ${who}`}
      </span>
    </div>
  );
}

function SavedFunnelTable({
  funnels,
  results,
  projectId,
  search,
  openId,
  returnFocus,
  onDeleted,
}: {
  funnels: SavedFunnel[];
  results: UseQueryResult<SavedFunnelResults>;
  projectId: string;
  search: FunnelSearch;
  openId: string | undefined;
  returnFocus: React.RefObject<HTMLHeadingElement | null>;
  onDeleted: (funnel: SavedFunnel) => void;
}) {
  return (
    <ScrollHint>
      <Table className="table-fixed max-sm:min-w-[42rem]">
        <caption className="sr-only">Saved funnels, by name</caption>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead
              scope="col"
              className={`h-8 w-1/4 pl-0 text-xs font-normal text-ink-subtle ${PINNED}`}
            >
              Name
            </TableHead>
            <TableHead scope="col" className="h-8 w-32 text-xs font-normal text-ink-subtle">
              Conversion
            </TableHead>
            <TableHead scope="col" className="h-8 text-xs font-normal text-ink-subtle">
              Steps
            </TableHead>
            <TableHead scope="col" className="h-8 w-48 text-xs font-normal text-ink-subtle">
              Counted by
            </TableHead>
            <TableHead scope="col" className={`h-8 w-20 pr-0 ${PINNED_END}`}>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {funnels.map((funnel) => {
            const open = funnel.id === openId;
            const steps = stepsLine(funnel.steps);
            return (
              <TableRow key={funnel.id} className="hover:bg-transparent">
                <th
                  scope="row"
                  className={`py-1.5 pr-3 text-left align-middle font-normal ${PINNED}`}
                >
                  <TruncatedText
                    text={funnel.name}
                    className={`text-link hover:underline ${open ? "font-medium" : ""}`}
                    render={
                      <Link
                        to="/projects/$projectId/product/funnel"
                        params={{ projectId }}
                        search={funnelSearchOf({
                          range: search.range,
                          environment: search.environment,
                          funnel: funnel.id,
                          steps: stepsFrom(funnel.steps),
                          count: funnel.count,
                          window: funnel.window,
                        })}
                        aria-current={open ? "true" : undefined}
                      />
                    }
                  />
                </th>
                <TableCell className="py-1.5">
                  <ConversionCell funnel={funnel} results={results} />
                </TableCell>
                <TableCell className="py-1.5 text-ink">
                  <TruncatedText text={steps} />
                </TableCell>

                <TableCell className="py-1.5 text-ink-subtle">
                  {countLine(funnel.count, funnel.window)}
                </TableCell>
                <TableCell className={`py-0.5 pr-0 text-right whitespace-nowrap ${PINNED_END}`}>
                  <WhenAllowed area="product_analytics" level="manage">
                    <RenameFunnelDialog projectId={projectId} funnel={funnel} />
                    <DeleteFunnelDialog
                      projectId={projectId}
                      funnel={funnel}
                      returnFocus={returnFocus}
                      onDeleted={onDeleted}
                    />
                  </WhenAllowed>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </ScrollHint>
  );
}

/** Opening a saved funnel keeps the current period and environment. */
export function SavedFunnelsCard({
  projectId,
  funnels,
  failure,
  onRetry,
  search,
  openId,
  onDeleted,
  results,
  action,
}: {
  projectId: string;
  funnels: SavedFunnel[] | undefined;
  failure: string | null;
  onRetry: () => void;
  search: FunnelSearch;
  openId: string | undefined;
  onDeleted: (funnel: SavedFunnel) => void;
  /** Every saved funnel's counts for the period and environment shown. */
  results: UseQueryResult<SavedFunnelResults>;
  /** Beside the heading, as Add rule is on the Alerts page: New funnel. */
  action?: React.ReactNode;
}) {
  // Return focus to the heading if deletion removed the row.
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  return (
    <section aria-labelledby="saved-funnels" className="flex flex-col gap-3">
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h2
          id="saved-funnels"
          ref={headingRef}
          tabIndex={-1}
          className="text-sm font-medium text-ink outline-none"
        >
          Saved funnels
        </h2>
        <div className="flex items-center gap-3">
          {funnels !== undefined && (
            <p className="text-xs text-ink-subtle tabular-nums">
              {funnels.length} of {MAX_SAVED_FUNNELS} saved
            </p>
          )}
          {action}
        </div>
      </div>
      {failure !== null && (
        <LoadFailed
          what="The saved funnels"
          message={failure}
          hasData={funnels !== undefined}
          onRetry={onRetry}
        />
      )}
      {funnels === undefined ? (
        failure === null && <LoadingRows rows={2} />
      ) : funnels.length === 0 ? (
        <p className="text-sm text-ink-subtle">No saved funnels yet.</p>
      ) : (
        <SavedFunnelTable
          funnels={funnels}
          results={results}
          projectId={projectId}
          search={search}
          openId={openId}
          returnFocus={headingRef}
          onDeleted={onDeleted}
        />
      )}
    </section>
  );
}
