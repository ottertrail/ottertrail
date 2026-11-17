import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LoaderCircleIcon, OctagonAlertIcon, SaveIcon } from "lucide-react";
import * as React from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  createFunnel,
  type FunnelDefinition,
  changeFailure,
  MAX_SAVED_FUNNELS,
  rememberSavedFunnel,
  type SavedFunnel,
  savedFunnelsKey,
  updateFunnel,
} from "@/lib/funnels-api";

import { DefinitionSummary, FunnelNameDialog } from "./funnel-name-dialog";
import { isShownFunnel } from "./search";

/** A button that saves a new funnel, or, at the limit, the same button disabled with the reason. */
function SaveNewButton({
  label,
  atLimit,
  icon = false,
  onClick,
}: {
  label: string;
  atLimit: boolean;
  icon?: boolean;
  onClick: () => void;
}) {
  const reasonId = React.useId();
  return (
    <>
      {atLimit && (
        <span id={reasonId} className="text-xs text-ink-subtle">
          A project has at most {MAX_SAVED_FUNNELS} saved funnels. Delete one to save another.
        </span>
      )}
      <Button
        variant="outline"
        size="sm"
        disabled={atLimit}
        aria-describedby={atLimit ? reasonId : undefined}
        onClick={onClick}
      >
        {icon && <SaveIcon aria-hidden="true" />}
        {label}
      </Button>
    </>
  );
}

/**
 * Saving the funnel shown (the address's steps, count, and window, not an
 * unshown draft in the editor): as a new saved funnel, or over the saved
 * funnel open in the address when it has changed since.
 */
export function SaveFunnelActions({
  projectId,
  shown,
  funnels,
  loading,
  openId,
  returnFocus,
  onSaved,
}: {
  projectId: string;
  shown: FunnelDefinition;
  /** The saved funnels; undefined while they load, or when they could not load. */
  funnels: SavedFunnel[] | undefined;
  /** Whether they are still loading. */
  loading: boolean;
  /** The saved funnel open in the address, if any. */
  openId: string | undefined;
  /** Where focus goes once saved: the buttons that did it are replaced by the status. */
  returnFocus: React.RefObject<HTMLElement | null>;
  /** After a new funnel is saved: open it. */
  onSaved: (funnel: SavedFunnel) => void;
}) {
  const queryClient = useQueryClient();
  const [naming, setNaming] = React.useState(false);
  const saveChanges = useMutation({
    mutationFn: ({ funnel, definition }: { funnel: SavedFunnel; definition: FunnelDefinition }) =>
      updateFunnel(projectId, funnel, funnel.name, definition),
    onSuccess: (funnel) => {
      // Shown as saved at once, so the button that did it goes with no second click.
      rememberSavedFunnel(queryClient, projectId, funnel);
      returnFocus.current?.focus();
    },
    // Changed or deleted elsewhere: the list as it is now, to look at before trying again.
    onError: () => void queryClient.invalidateQueries({ queryKey: savedFunnelsKey(projectId) }),
  });

  // A failure shows for the funnel and steps it was for, not for others shown since.
  const failedFor =
    saveChanges.variables === undefined
      ? undefined
      : JSON.stringify([saveChanges.variables.funnel.id, saveChanges.variables.definition]);
  const open = funnels?.find((funnel) => funnel.id === openId);
  const atLimit = (funnels?.length ?? 0) >= MAX_SAVED_FUNNELS;
  const unchanged = open !== undefined && isShownFunnel(open, shown);
  const saveNew = () => setNaming(true);
  // Until the list loads, whether the open funnel has changed is not known.
  const known = !(openId !== undefined && loading);

  return (
    <div className="flex max-w-md flex-col items-end gap-2">
      <div className={known ? "flex flex-wrap items-center justify-end gap-2" : "hidden"}>
        <output aria-live="polite" className="text-sm text-ink-subtle empty:hidden">
          {open === undefined
            ? ""
            : unchanged
              ? `Saved as “${open.name}”.`
              : `Changed from the saved funnel “${open.name}”.`}
        </output>
        {open !== undefined && !unchanged && (
          <Button
            size="sm"
            disabled={saveChanges.isPending}
            onClick={() => saveChanges.mutate({ funnel: open, definition: shown })}
          >
            {saveChanges.isPending && (
              <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
            )}
            Save changes
          </Button>
        )}
        {open === undefined ? (
          <SaveNewButton label="Save funnel" icon atLimit={atLimit} onClick={saveNew} />
        ) : (
          !unchanged && (
            <SaveNewButton label="Save as new funnel" atLimit={atLimit} onClick={saveNew} />
          )
        )}
      </div>
      {saveChanges.error !== null && failedFor === JSON.stringify([openId, shown]) && (
        <Alert variant="destructive" role="alert">
          <OctagonAlertIcon />
          <AlertDescription>
            The changes could not be saved. {changeFailure(saveChanges.error)}
          </AlertDescription>
        </Alert>
      )}
      <FunnelNameDialog
        open={naming}
        onOpenChange={setNaming}
        savedFocus={returnFocus}
        projectId={projectId}
        title={open === undefined ? "Save the funnel" : "Save as a new funnel"}
        description="Saves the funnel shown under a name, to open again from Saved funnels."
        initialName=""
        submitLabel="Save funnel"
        save={(name) => createFunnel(projectId, name, shown)}
        onSaved={(funnel) => {
          setNaming(false);
          onSaved(funnel);
        }}
      >
        <DefinitionSummary definition={shown} />
      </FunnelNameDialog>
    </div>
  );
}
