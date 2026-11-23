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

/** Keep inactive Save focusable (docs/design-system.md, "The save rule"). */
const RESTING = "aria-disabled:cursor-not-allowed aria-disabled:opacity-50";

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

/** Save the shown definition from the address; the editor may hold an unshown draft. */
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
  shown: FunnelDefinition | null;
  funnels: SavedFunnel[] | undefined;
  loading: boolean;
  openId: string | undefined;
  returnFocus: React.RefObject<HTMLElement | null>;
  onSaved: (funnel: SavedFunnel) => void;
}) {
  const queryClient = useQueryClient();
  const [naming, setNaming] = React.useState(false);
  const saveChanges = useMutation({
    mutationFn: ({ funnel, definition }: { funnel: SavedFunnel; definition: FunnelDefinition }) =>
      updateFunnel(projectId, funnel, funnel.name, definition),
    onSuccess: (funnel) => {
      // Update the cache immediately to prevent a second save. Keep focus on the disabled button.
      rememberSavedFunnel(queryClient, projectId, funnel);
    },
    // Refetch after conflicts before retrying.
    onError: () => void queryClient.invalidateQueries({ queryKey: savedFunnelsKey(projectId) }),
  });

  // Show failures only for the definition that failed.
  const failedFor =
    saveChanges.variables === undefined
      ? undefined
      : JSON.stringify([saveChanges.variables.funnel.id, saveChanges.variables.definition]);
  const open = funnels?.find((funnel) => funnel.id === openId);
  const atLimit = (funnels?.length ?? 0) >= MAX_SAVED_FUNNELS;
  const unchanged = open !== undefined && shown !== null && isShownFunnel(open, shown);
  const saveNew = () => setNaming(true);
  // Wait for the saved list before comparing the open funnel.
  const known = !(openId !== undefined && loading);
  // Skip comparison when the address has no steps to show.
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
