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
        Uses the current period and environment when reopened.
      </p>
    </div>
  );
}

/** Remount on open to reset to initialName. */
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
  description?: string;
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
    // Refetch after conflicts before retrying.
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
        {description && <DialogDescription>{description}</DialogDescription>}
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

export function FunnelNameDialog({
  open,
  onOpenChange,
  savedFocus,
  onSaved,
  ...form
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** After saving, focus here if the trigger is gone. Cancel returns focus to the trigger. */
  savedFocus?: React.RefObject<HTMLElement | null>;
  projectId: string;
  title: string;
  description?: string;
  initialName: string;
  submitLabel: string;
  save: (name: string) => Promise<SavedFunnel>;
  onSaved: (funnel: SavedFunnel) => void;
  children?: React.ReactNode;
}) {
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
