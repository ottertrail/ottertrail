import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LoaderCircleIcon, OctagonAlertIcon, PlusIcon } from "lucide-react";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formText } from "@/lib/form";
import { createProject } from "@/lib/projects-api";

import { hostnamesFromText } from "./format";

/** "New project" button and its dialog. On success, opens the new project's page. */
export function NewProjectDialog({ variant = "default" }: { variant?: "default" | "outline" }) {
  const [open, setOpen] = React.useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: createProject,
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      setOpen(false);
      await navigate({ to: "/projects/$projectId", params: { projectId: project.id } });
    },
  });

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    create.mutate({
      name: formText(form, "name"),
      allowedHostnames: hostnamesFromText(formText(form, "hostnames")),
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          create.reset();
        }
      }}
    >
      <DialogTrigger render={<Button variant={variant} />}>
        <PlusIcon aria-hidden="true" />
        New project
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              A project is one website or app. Each gets its own tracking snippet.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel htmlFor="project-name">Name</FieldLabel>
              <Input id="project-name" name="name" required maxLength={100} autoComplete="off" />
            </Field>
            <Field>
              <FieldLabel htmlFor="project-hostnames">Allowed sites</FieldLabel>
              <Textarea
                id="project-hostnames"
                name="hostnames"
                rows={3}
                placeholder={"example.com\nwww.example.com"}
                aria-describedby="project-hostnames-hint"
              />
              <FieldDescription id="project-hostnames-hint">
                Hostnames whose pages may send events, one per line. Events from other sites are
                refused. You can add them later.
              </FieldDescription>
            </Field>
            {create.error !== null && (
              <Alert variant="destructive" role="alert">
                <OctagonAlertIcon />
                <AlertDescription>{create.error.message}</AlertDescription>
              </Alert>
            )}
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
              Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
