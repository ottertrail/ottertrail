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

/** The look of a Save that has nothing to save: it stays focusable, as the Save bar's does. */
const RESTING = "aria-disabled:cursor-not-allowed aria-disabled:opacity-50";

/**
 * A button that saves a new funnel. Disabled with nothing to save (no
 * funnel shown), and at the limit, with the reason.
 */
function SaveNewButton({
  label,
  atLimit,
  nothingToSave = false,
  icon = false,
  onClick,
}: {
  label: string;
  atLimit: boolean;
  nothingToSave?: boolean;
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
        disabled={atLimit || nothingToSave}
        // With nothing to save it stays focusable; at the limit it is plainly disabled.
        focusableWhenDisabled={!atLimit}
        className={RESTING}
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
 * funnel open in the address when it has changed since. By the save rule,
 * Save is disabled while there is nothing new to save: before a funnel is
 * shown, and while the open saved funnel is shown as it was saved.
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
  /** The funnel shown; null until one is (fewer than two steps in the address). */
  shown: FunnelDefinition | null;
  /** The saved funnels; undefined while they load, or when they could not load. */
  funnels: SavedFunnel[] | undefined;
  /** Whether they are still loading. */
  loading: boolean;
  /** The saved funnel open in the address, if any. */
  openId: string | undefined;
  /**
   * Where focus goes once a new funnel is saved from the dialog: the Steps
   * heading, since Save funnel gives way to Save changes.
   */
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
      // Shown as saved at once, so Save changes is disabled again with no second click.
      // Focus stays on it: disabled, it stays focusable, beside the status that says so.
      rememberSavedFunnel(queryClient, projectId, funnel);
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
  const unchanged = open !== undefined && shown !== null && isShownFunnel(open, shown);
  const saveNew = () => setNaming(true);
  // Until the list loads, whether the open funnel has changed is not known.
  const known = !(openId !== undefined && loading);
  // A saved funnel open with no funnel shown (its steps gone from the address) is not compared.
  const compared = shown === null ? undefined : open;

  return (
    <div className="flex max-w-md flex-col items-end gap-2">
      <div className={known ? "flex flex-wrap items-center justify-end gap-2" : "hidden"}>
        <output aria-live="polite" className="text-sm text-ink-subtle empty:hidden">
          {compared === undefined
            ? ""
            : unchanged
              ? `Saved as “${compared.name}”.`
              : `Changed from the saved funnel “${compared.name}”.`}
        </output>
        {compared === undefined || shown === null ? (
          <SaveNewButton
            label="Save funnel"
            icon
            atLimit={atLimit}
            nothingToSave={shown === null}
            onClick={saveNew}
          />
        ) : (
          <>
            <Button
              size="sm"
              disabled={unchanged || saveChanges.isPending}
              focusableWhenDisabled
              className={RESTING}
              onClick={() => saveChanges.mutate({ funnel: compared, definition: shown })}
            >
              {saveChanges.isPending && (
                <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
              )}
              Save changes
            </Button>
            {!unchanged && (
              <SaveNewButton label="Save as new funnel" atLimit={atLimit} onClick={saveNew} />
            )}
          </>
        )}
      </div>
      {saveChanges.error !== null &&
        shown !== null &&
        failedFor === JSON.stringify([openId, shown]) && (
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
        description="Save the displayed funnel with a name. Open it again from Saved funnels."
        initialName=""
        submitLabel="Save funnel"
        save={(name) =>
          shown === null
            ? Promise.reject(new Error("Show a funnel before saving it."))
            : createFunnel(projectId, name, shown)
        }
        onSaved={(funnel) => {
          setNaming(false);
          onSaved(funnel);
        }}
      >
        {shown !== null && <DefinitionSummary definition={shown} />}
      </FunnelNameDialog>
    </div>
  );
}
