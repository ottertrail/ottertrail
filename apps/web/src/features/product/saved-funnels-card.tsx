import { type UseQueryResult, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CopyIcon, LoaderCircleIcon, OctagonAlertIcon, PencilIcon, Trash2Icon } from "lucide-react";
import * as React from "react";

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
import { ROW_LINK, workbenchRow } from "@/components/workbench-rows";
import { ApiError } from "@/lib/api";
import {
  createFunnel,
  deleteFunnel,
  MAX_SAVED_FUNNELS,
  type SavedFunnel,
  savedFunnelsKey,
  updateFunnel,
} from "@/lib/funnels-api";
import { typingOrOverlay } from "@/lib/keys";
import { MISSING } from "@/lib/missing";
import type { SavedFunnelResult, SavedFunnelResults } from "@/lib/product-api";

import { formatWhole } from "../analytics/format";
import { countLine, formatShare, stepsLine } from "./format";
import { FunnelNameDialog } from "./funnel-name-dialog";
import { LoadFailed, LoadingRows } from "./report-state";
import { LIMIT_REASON } from "./save-funnel-actions";
import { copyName } from "./saved-funnels";
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

/** A new saved funnel with the same steps, count, and window, under a new name. */
function DuplicateFunnelDialog({
  projectId,
  funnel,
  funnels,
  limitReasonId,
  onDuplicated,
}: {
  projectId: string;
  funnel: SavedFunnel;
  funnels: readonly SavedFunnel[];
  /** The reason shown once beside the count while the project is at the limit. */
  limitReasonId: string;
  onDuplicated: (funnel: SavedFunnel) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const atLimit = funnels.length >= MAX_SAVED_FUNNELS;
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Duplicate the funnel ${funnel.name}`}
        disabled={atLimit}
        focusableWhenDisabled
        aria-describedby={atLimit ? limitReasonId : undefined}
        className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
        onClick={() => setOpen(true)}
      >
        <CopyIcon aria-hidden="true" />
      </Button>
      <FunnelNameDialog
        open={open}
        onOpenChange={setOpen}
        projectId={projectId}
        title={`Duplicate the funnel “${funnel.name}”`}
        initialName={copyName(funnel.name, funnels)}
        submitLabel="Save funnel"
        save={(name) =>
          createFunnel(projectId, name, {
            steps: funnel.steps,
            count: funnel.count,
            window: funnel.window,
          })
        }
        onSaved={(created) => {
          setOpen(false);
          onDuplicated(created);
        }}
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

/** On a phone each row stacks: the name and actions, the steps, then who and the conversion. */
const STACK_ROW = "max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:gap-x-3 max-sm:py-2";
const STACK_CELL = "max-sm:p-0 max-sm:whitespace-normal";

function SavedFunnelTable({
  funnels,
  results,
  projectId,
  search,
  openId,
  active,
  limitReasonId,
  returnFocus,
  onDeleted,
  onDuplicated,
}: {
  funnels: SavedFunnel[];
  results: UseQueryResult<SavedFunnelResults>;
  projectId: string;
  search: FunnelSearch;
  openId: string | undefined;
  /** The row j and k moved to. */
  active: string | undefined;
  limitReasonId: string;
  returnFocus: React.RefObject<HTMLHeadingElement | null>;
  onDeleted: (funnel: SavedFunnel) => void;
  onDuplicated: (funnel: SavedFunnel) => void;
}) {
  return (
    <ScrollHint disabled>
      <Table className="table-fixed max-sm:block">
        <caption className="sr-only">Saved funnels, by name</caption>
        <TableHeader className="max-sm:sr-only">
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col" className="h-8 w-1/4 pl-0 text-xs font-normal text-ink-subtle">
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
            <TableHead scope="col" className="h-8 w-28 pr-0">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="max-sm:block">
          {funnels.map((funnel) => {
            const open = funnel.id === openId;
            const steps = stepsLine(funnel.steps);
            return (
              <TableRow
                key={funnel.id}
                {...workbenchRow(funnel.id, funnel.id === active, STACK_ROW)}
              >
                <th
                  scope="row"
                  className="py-1.5 pr-3 text-left align-middle font-normal max-sm:col-start-1 max-sm:row-start-1 max-sm:self-center max-sm:p-0"
                >
                  <TruncatedText
                    text={funnel.name}
                    className={`rounded-sm text-link hover:underline ${open ? "font-medium" : ""}`}
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
                        {...ROW_LINK}
                      />
                    }
                  />
                </th>
                <TableCell
                  className={`py-1.5 max-sm:col-start-2 max-sm:row-start-3 max-sm:justify-self-end max-sm:text-right ${STACK_CELL}`}
                >
                  <ConversionCell funnel={funnel} results={results} />
                </TableCell>
                <TableCell
                  className={`py-1.5 text-ink max-sm:col-span-2 max-sm:row-start-2 max-sm:pt-1 ${STACK_CELL}`}
                >
                  {/* On a phone the steps wrap rather than being cut off. */}
                  <TruncatedText
                    text={steps}
                    className="max-sm:overflow-visible max-sm:break-words max-sm:whitespace-normal"
                  />
                </TableCell>
                <TableCell
                  className={`py-1.5 text-ink-subtle max-sm:col-start-1 max-sm:row-start-3 max-sm:self-end max-sm:text-xs ${STACK_CELL}`}
                >
                  {countLine(funnel.count, funnel.window)}
                </TableCell>
                <TableCell className="py-0.5 pr-0 text-right whitespace-nowrap max-sm:col-start-2 max-sm:row-start-1 max-sm:p-0">
                  <WhenAllowed area="product_analytics" level="manage">
                    <RenameFunnelDialog projectId={projectId} funnel={funnel} />
                    <DuplicateFunnelDialog
                      projectId={projectId}
                      funnel={funnel}
                      funnels={funnels}
                      limitReasonId={limitReasonId}
                      onDuplicated={onDuplicated}
                    />
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

/**
 * j and k move through the rows, focusing each one's name; Enter or o opens
 * the row moved to, and Esc leaves it. Not while typing or with a dialog
 * open (lib/keys.ts), as on the workbench pages.
 */
function useRowKeys(
  ids: readonly string[],
  listRef: React.RefObject<HTMLElement | null>,
): [string | undefined, (id: string | undefined) => void] {
  const [active, setActive] = React.useState<string | undefined>(undefined);
  const moved = React.useRef(false);
  const linkOf = React.useCallback(
    (id: string) =>
      listRef.current?.querySelector<HTMLElement>(
        `[data-workbench-id="${CSS.escape(id)}"] [data-row-link]`,
      ) ?? null,
    [listRef],
  );
  React.useEffect(() => {
    if (!moved.current || active === undefined) return;
    moved.current = false;
    const link = linkOf(active);
    link?.focus({ preventScroll: true });
    link?.closest("tr")?.scrollIntoView?.({ block: "nearest" });
  }, [active, linkOf]);
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (typingOrOverlay(event)) return;
      const index = active === undefined ? -1 : ids.indexOf(active);
      const pressed = event.key;
      if (pressed === "j" || pressed === "k") {
        if (ids.length === 0) return;
        event.preventDefault();
        const next =
          pressed === "j"
            ? Math.min(index + 1, ids.length - 1)
            : index === -1
              ? 0
              : Math.max(index - 1, 0);
        moved.current = true;
        setActive(ids[next]);
      } else if ((pressed === "Enter" || pressed === "o") && index !== -1 && active !== undefined) {
        // Enter on a link or a button is that control's own.
        const target = event.target instanceof Element ? event.target : null;
        if (pressed === "Enter" && target?.closest("a[href], button") != null) return;
        event.preventDefault();
        linkOf(active)?.click();
      } else if (pressed === "Escape" && active !== undefined) {
        event.preventDefault();
        setActive(undefined);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ids, active, linkOf]);
  return [active, setActive];
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
  const listRef = React.useRef<HTMLElement>(null);
  const ids = React.useMemo(() => (funnels ?? []).map((funnel) => funnel.id), [funnels]);
  const [active, setActive] = useRowKeys(ids, listRef);
  const limitReasonId = React.useId();
  const atLimit = (funnels?.length ?? 0) >= MAX_SAVED_FUNNELS;
  return (
    <section ref={listRef} aria-labelledby="saved-funnels" className="flex flex-col gap-3">
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
          {atLimit && (
            <p id={limitReasonId} className="text-xs text-ink-subtle">
              {LIMIT_REASON}
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
          active={active}
          limitReasonId={limitReasonId}
          returnFocus={headingRef}
          onDeleted={onDeleted}
          onDuplicated={(created) => setActive(created.id)}
        />
      )}
    </section>
  );
}
