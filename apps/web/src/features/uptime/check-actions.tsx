import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  LoaderCircleIcon,
  OctagonAlertIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  Trash2Icon,
} from "lucide-react";
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
import { ApiError } from "@/lib/api";
import { type Check, deleteCheck, updateCheck } from "@/lib/uptime-api";

import { CheckFormDialog } from "./check-form-dialog";

/** Asks before deleting a check, with its incidents and results. */
function DeleteCheckDialog({
  projectId,
  check,
  open,
  onOpenChange,
  onDeleted,
}: {
  projectId: string;
  check: Check;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: (() => void) | undefined;
}) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: async () => {
      try {
        await deleteCheck(projectId, check.id);
      } catch (error) {
        // Already deleted, such as in another tab: what was asked for.
        if (!(error instanceof ApiError && error.code === "check_not_found")) throw error;
      }
    },
    onSuccess: () => {
      onOpenChange(false);
      onDeleted?.();
      void queryClient.invalidateQueries({ queryKey: ["checks", projectId] });
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) remove.reset();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete the check “{check.name}”?</DialogTitle>
          <DialogDescription>
            It stops running, and its incidents go with it. Its results stay out of reach and leave
            with the 90 days they are kept. To stop it for a while instead, pause it.
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
            Delete check
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Edit, pause or resume, and delete, for one check: icon buttons named
 * for the check in a table row (`compact`), buttons with words on its page.
 */
export function CheckActions({
  projectId,
  check,
  compact = false,
  onDeleted,
}: {
  projectId: string;
  check: Check;
  compact?: boolean;
  onDeleted?: () => void;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const pause = useMutation({
    mutationFn: () => updateCheck(projectId, check.id, { paused: !check.paused }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["checks", projectId] }),
  });
  const pauseLabel = check.paused ? "Resume" : "Pause";
  return (
    <div className={compact ? "flex items-center gap-1" : "flex flex-wrap items-center gap-1"}>
      <Button
        variant={compact ? "ghost" : "outline"}
        size={compact ? "icon-sm" : "sm"}
        aria-label={compact ? `Edit ${check.name}` : undefined}
        onClick={() => setEditing(true)}
      >
        <PencilIcon aria-hidden="true" />
        {!compact && "Edit"}
      </Button>
      <Button
        variant={compact ? "ghost" : "outline"}
        size={compact ? "icon-sm" : "sm"}
        aria-label={compact ? `${pauseLabel} ${check.name}` : undefined}
        disabled={pause.isPending}
        onClick={() => pause.mutate()}
      >
        {check.paused ? <PlayIcon aria-hidden="true" /> : <PauseIcon aria-hidden="true" />}
        {!compact && pauseLabel}
      </Button>
      <Button
        variant={compact ? "ghost" : "outline"}
        size={compact ? "icon-sm" : "sm"}
        aria-label={compact ? `Delete ${check.name}` : undefined}
        onClick={() => setDeleting(true)}
      >
        <Trash2Icon aria-hidden="true" />
        {!compact && "Delete"}
      </Button>
      {pause.error !== null && (
        <p
          role="alert"
          className={compact ? "text-xs text-destructive" : "w-full text-xs text-destructive"}
        >
          {pause.error.message}
        </p>
      )}
      <CheckFormDialog
        open={editing}
        onOpenChange={setEditing}
        projectId={projectId}
        check={check}
      />
      <DeleteCheckDialog
        projectId={projectId}
        check={check}
        open={deleting}
        onOpenChange={setDeleting}
        onDeleted={onDeleted}
      />
    </div>
  );
}
