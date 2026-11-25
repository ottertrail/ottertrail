import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
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
import { DEFAULT_ENVIRONMENT } from "@/lib/analytics-api";
import { deleteUserData } from "@/lib/users-api";

/**
 * Deletes everything stored about one known user in the project, after a
 * confirmation (docs/data.md, "Deleting one user's data"). The server
 * starts it and answers at once; the Users list then shows it pending.
 */
export function DeleteUserDialog({
  projectId,
  userId,
  environment,
}: {
  projectId: string;
  userId: string;
  environment: string;
}) {
  const [open, setOpen] = React.useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const remove = useMutation({
    mutationFn: () => deleteUserData(projectId, userId),
    onSuccess: async () => {
      setOpen(false);
      try {
        await navigate({
          to: "/projects/$projectId/users",
          params: { projectId },
          search: environment === DEFAULT_ENVIRONMENT ? {} : { env: environment },
        });
      } finally {
        queryClient.removeQueries({ queryKey: ["user", projectId, userId] });
        await queryClient.invalidateQueries({ queryKey: ["users", projectId] });
      }
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
        Delete data
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="break-all">Delete the data of {userId}?</DialogTitle>
          <DialogDescription>
            Everything stored with this user ID in this project is permanently deleted: events,
            errors, session replays, AI calls, and the traces and logs that carry the ID. This
            cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-ink-muted">
          <li>
            Stop your app from sending events for this user first. Events sent after the deletion
            are stored again.
          </li>
          <li>Backups keep the data until they expire.</li>
        </ul>
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
            Delete data
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
