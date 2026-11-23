import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LoaderCircleIcon, OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { SettingsSection } from "@/components/settings-section";
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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { forgetProject } from "@/lib/last-project";
import {
  deleteProject,
  type Project,
  projectQuery,
  projectsQuery,
  replacePublicKey,
  replaceSecretKey,
} from "@/lib/projects-api";

const KEYS = {
  public: {
    button: "Replace public key",
    title: "Replace the public key?",
    description:
      "The current snippet stops working immediately. Replace it on your site. Existing data is kept.",
    replace: replacePublicKey,
  },
  secret: {
    button: "Replace secret key",
    title: "Replace the secret key?",
    description:
      "The current key immediately stops working for server events and user ID signatures. Update your server with the new key. Existing data is kept.",
    replace: replaceSecretKey,
  },
} as const;

/** Replacing a key invalidates the current key immediately. */
function ReplaceKeyDialog({ project, which }: { project: Project; which: keyof typeof KEYS }) {
  const texts = KEYS[which];
  const [open, setOpen] = React.useState(false);
  const queryClient = useQueryClient();
  const replace = useMutation({
    mutationFn: () => texts.replace(project.id),
    onSuccess: (updated) => {
      queryClient.setQueryData(projectQuery(project.id).queryKey, updated);
      void queryClient.invalidateQueries({ queryKey: projectsQuery().queryKey, exact: true });
      setOpen(false);
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) replace.reset();
      }}
    >
      <Button variant="outline" onClick={() => setOpen(true)}>
        {texts.button}
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{texts.title}</DialogTitle>
          <DialogDescription>{texts.description}</DialogDescription>
        </DialogHeader>
        {replace.error !== null && (
          <Alert variant="destructive" role="alert">
            <OctagonAlertIcon />
            <AlertDescription>{replace.error.message}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
          <Button onClick={() => replace.mutate()} disabled={replace.isPending}>
            {replace.isPending && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
            Replace key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteProjectDialog({ project }: { project: Project }) {
  const [open, setOpen] = React.useState(false);
  const [typed, setTyped] = React.useState("");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const remove = useMutation({
    mutationFn: () => deleteProject(project.id, typed),
    onSuccess: async () => {
      forgetProject(project.id);
      setOpen(false);
      try {
        // Bypass the leave guard because a deleted project cannot save edits.
        await navigate({ to: "/projects", ignoreBlocker: true });
      } finally {
        queryClient.removeQueries({ queryKey: projectQuery(project.id).queryKey });
        queryClient.removeQueries({ queryKey: ["analytics", project.id] });
        await queryClient.invalidateQueries({ queryKey: projectsQuery().queryKey, exact: true });
      }
    },
  });
  const matches = typed.trim() === project.name;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setTyped("");
          remove.reset();
        }
      }}
    >
      <Button variant="destructive" onClick={() => setOpen(true)}>
        Delete project
      </Button>
      <DialogContent className="sm:max-w-md">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (matches) remove.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Delete {project.name}?</DialogTitle>
            <DialogDescription>
              This permanently deletes the project and all events it received. Its snippet stops
              sending events.
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="delete-confirm">
              Type the project&apos;s name to confirm
            </FieldLabel>
            <Input
              id="delete-confirm"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              aria-describedby="delete-confirm-name"
            />
            <FieldDescription id="delete-confirm-name">{project.name}</FieldDescription>
          </Field>
          {remove.error !== null && (
            <Alert variant="destructive" role="alert">
              <OctagonAlertIcon />
              <AlertDescription>{remove.error.message}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
            <Button type="submit" variant="destructive" disabled={!matches || remove.isPending}>
              {remove.isPending && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
              Delete permanently
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DangerZone({ project }: { project: Project }) {
  return (
    <SettingsSection title="Danger zone">
      <div className="flex flex-col divide-y">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium text-ink">Replace the public key</h3>
            <p className="text-sm text-muted-foreground">
              Replace an exposed key. The current snippet stops working.
            </p>
          </div>
          <ReplaceKeyDialog project={project} which="public" />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 py-4">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium text-ink">Replace the secret key</h3>
            <p className="text-sm text-muted-foreground">
              Replace an exposed key. Your server's current key stops working.
            </p>
          </div>
          <ReplaceKeyDialog project={project} which="secret" />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 pt-4">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium text-ink">Delete the project</h3>
            <p className="text-sm text-muted-foreground">
              Permanently delete the project and all its events.
            </p>
          </div>
          <DeleteProjectDialog project={project} />
        </div>
      </div>
    </SettingsSection>
  );
}
