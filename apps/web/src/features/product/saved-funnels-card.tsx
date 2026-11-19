import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { LoaderCircleIcon, OctagonAlertIcon, PencilIcon, Trash2Icon } from "lucide-react";
import * as React from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { WhenAllowed } from "@/components/when-allowed";
import { ApiError } from "@/lib/api";
import {
  deleteFunnel,
  MAX_SAVED_FUNNELS,
  type SavedFunnel,
  savedFunnelsKey,
  updateFunnel,
} from "@/lib/funnels-api";

import { countLine, stepsLine } from "./format";
import { FunnelNameDialog } from "./funnel-name-dialog";
import { LoadFailed, LoadingRows } from "./report-state";
import { type FunnelSearch, funnelSearchOf, stepsFrom } from "./search";

/** Renames a saved funnel: the same steps, count, and window under a new name. */
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
        description="Only the name changes. The steps, counted identities, and conversion window remain as saved."
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

/** Asks before deleting a saved funnel; only its definition goes, the events stay. */
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
  // Once deleted, the row and its buttons go: focus goes to the heading. On Cancel, back to the button.
  const deleted = React.useRef(false);
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: async () => {
      try {
        await deleteFunnel(projectId, funnel.id);
      } catch (error) {
        // Already deleted, such as in another tab: what was asked for.
        if (!(error instanceof ApiError && error.code === "funnel_not_found")) throw error;
      }
    },
    onSuccess: () => {
      deleted.current = true;
      setOpen(false);
      onDeleted(funnel);
      // Gone from the list at once, even should fetching it again fail.
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
            This deletes the funnel's definition: its name, steps, counted identities, and
            conversion window. Your events are retained. You can build and save the same funnel
            again without losing data.
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

/** Each saved funnel by name: a link that opens it, its steps, and who it counts for how long. */
function SavedFunnelTable({
  funnels,
  projectId,
  search,
  openId,
  returnFocus,
  onDeleted,
}: {
  funnels: SavedFunnel[];
  projectId: string;
  search: FunnelSearch;
  openId: string | undefined;
  returnFocus: React.RefObject<HTMLHeadingElement | null>;
  onDeleted: (funnel: SavedFunnel) => void;
}) {
  return (
    <table className="w-full table-fixed text-sm">
      <caption className="sr-only">Saved funnels, by name</caption>
      <thead>
        <tr className="text-xs text-ink-subtle">
          <th scope="col" className="w-1/4 pb-2 text-left font-normal">
            Name
          </th>
          <th scope="col" className="pb-2 text-left font-normal">
            Steps
          </th>
          <th scope="col" className="w-48 pb-2 text-left font-normal">
            Counts
          </th>
          <th scope="col" className="w-18 pb-2">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {funnels.map((funnel) => {
          const open = funnel.id === openId;
          const steps = stepsLine(funnel.steps);
          return (
            <tr key={funnel.id}>
              <th scope="row" className="py-1.5 pr-3 text-left align-top font-normal">
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
                  className={`block truncate text-link hover:underline ${open ? "font-medium" : ""}`}
                  title={funnel.name}
                >
                  {funnel.name}
                </Link>
              </th>
              <td className="truncate py-1.5 pr-3 align-top text-ink" title={steps}>
                {steps}
              </td>
              <td className="py-1.5 pr-3 align-top text-ink-subtle">
                {countLine(funnel.count, funnel.window)}
              </td>
              <td className="py-0.5 text-right align-top whitespace-nowrap">
                <WhenAllowed area="product_analytics" level="manage">
                  <RenameFunnelDialog projectId={projectId} funnel={funnel} />
                  <DeleteFunnelDialog
                    projectId={projectId}
                    funnel={funnel}
                    returnFocus={returnFocus}
                    onDeleted={onDeleted}
                  />
                </WhenAllowed>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * The project's saved funnels. Opening one shows it in the page's period and
 * environment; renaming and deleting refetch the list.
 */
export function SavedFunnelsCard({
  projectId,
  funnels,
  failure,
  onRetry,
  search,
  openId,
  onDeleted,
}: {
  projectId: string;
  /** undefined while the list loads, or when it could not load. */
  funnels: SavedFunnel[] | undefined;
  /** Why the list could not load, if it could not. */
  failure: string | null;
  onRetry: () => void;
  search: FunnelSearch;
  /** The saved funnel open in the address, if any. */
  openId: string | undefined;
  onDeleted: (funnel: SavedFunnel) => void;
}) {
  // Where focus goes when a dialog closes: a deleted row's buttons are gone.
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3 ref={headingRef} tabIndex={-1} className="outline-none">
            Saved funnels
          </h3>
        </CardTitle>
        {funnels !== undefined && (
          <CardAction>
            <p className="text-xs text-ink-subtle tabular-nums">
              {funnels.length} of {MAX_SAVED_FUNNELS} saved
            </p>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
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
          <p className="text-sm text-ink-subtle">
            No funnels are saved yet. Set the steps below. Select Show funnel. Then select Save
            funnel to save it here with a name.
          </p>
        ) : (
          <SavedFunnelTable
            funnels={funnels}
            projectId={projectId}
            search={search}
            openId={openId}
            returnFocus={headingRef}
            onDeleted={onDeleted}
          />
        )}
      </CardContent>
    </Card>
  );
}
