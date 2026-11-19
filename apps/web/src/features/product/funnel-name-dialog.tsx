import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LoaderCircleIcon, OctagonAlertIcon } from "lucide-react";
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
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import {
  changeFailure,
  type FunnelDefinition,
  funnelNameProblem,
  rememberSavedFunnel,
  type SavedFunnel,
  savedFunnelsKey,
} from "@/lib/funnels-api";

import { countLine, stepsLine } from "./format";

/** What a saved funnel keeps, and what it does not. */
export function DefinitionSummary({ definition }: { definition: FunnelDefinition }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-hairline p-3 text-sm">
      <dl className="flex flex-col gap-1">
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-ink-subtle">Steps</dt>
          <dd className="min-w-0 break-words text-ink">{stepsLine(definition.steps)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-ink-subtle">Counts</dt>
          <dd className="text-ink">{countLine(definition.count, definition.window)}</dd>
        </div>
      </dl>
      <p className="text-xs text-ink-subtle">
        The period and environment are not saved. The funnel opens with the period and environment
        currently selected.
      </p>
    </div>
  );
}

/** The form, mounted while the dialog is open, so each opening starts from `initialName`. */
function FunnelNameForm({
  projectId,
  title,
  description,
  initialName,
  submitLabel,
  save,
  onSaved,
  children,
}: {
  projectId: string;
  title: string;
  description: string;
  initialName: string;
  submitLabel: string;
  save: (name: string) => Promise<SavedFunnel>;
  onSaved: (funnel: SavedFunnel) => void;
  children?: React.ReactNode;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = React.useState(initialName);
  const [checked, setChecked] = React.useState(false);
  const nameId = React.useId();
  const mutation = useMutation({
    mutationFn: () => save(name),
    onSuccess: (funnel) => {
      rememberSavedFunnel(queryClient, projectId, funnel);
      onSaved(funnel);
    },
    // Changed or deleted elsewhere: the list as it is now, before trying again.
    onError: () => void queryClient.invalidateQueries({ queryKey: savedFunnelsKey(projectId) }),
  });

  const nameProblem = funnelNameProblem(name);
  const takenError =
    mutation.error instanceof ApiError && mutation.error.code === "funnel_name_taken"
      ? mutation.error
      : null;
  const nameTaken = takenError !== null;
  const nameError = (checked ? nameProblem : null) ?? takenError?.message ?? null;

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setChecked(true);
        if (nameProblem === null && !mutation.isPending) mutation.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <Field data-invalid={nameError !== null || undefined}>
        <FieldLabel htmlFor={nameId}>Name</FieldLabel>
        <Input
          id={nameId}
          value={name}
          placeholder="Pricing to signup"
          autoComplete="off"
          aria-invalid={nameError !== null || undefined}
          aria-describedby={nameError === null ? undefined : `${nameId}-error`}
          onChange={(event) => {
            setName(event.target.value);
            if (nameTaken) mutation.reset();
          }}
        />
        {nameError !== null && <FieldError id={`${nameId}-error`}>{nameError}</FieldError>}
      </Field>
      {children}
      {mutation.error !== null && !nameTaken && (
        <Alert variant="destructive" role="alert">
          <OctagonAlertIcon />
          <AlertDescription>{changeFailure(mutation.error)}</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * Asks for a saved funnel's name, checked as the API checks it, then saves
 * it with `save`: a new funnel, or a new name. A name already taken shows
 * on the field; any other refusal of the API, in an alert.
 */
export function FunnelNameDialog({
  open,
  onOpenChange,
  savedFocus,
  onSaved,
  ...form
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Where focus goes once saved, when the button that opened the dialog is
   * gone by then. Without it, and on Cancel, focus goes back to that button.
   */
  savedFocus?: React.RefObject<HTMLElement | null>;
  projectId: string;
  title: string;
  description: string;
  initialName: string;
  submitLabel: string;
  save: (name: string) => Promise<SavedFunnel>;
  onSaved: (funnel: SavedFunnel) => void;
  children?: React.ReactNode;
}) {
  // Whether this opening ended in a save: read when the dialog has closed.
  const saved = React.useRef(false);
  React.useEffect(() => {
    if (open) saved.current = false;
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        finalFocus={() => (saved.current && savedFocus?.current) || true}
      >
        <FunnelNameForm
          {...form}
          onSaved={(funnel) => {
            saved.current = true;
            onSaved(funnel);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
