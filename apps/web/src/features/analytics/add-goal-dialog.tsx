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
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import { createGoal, goalNameProblem } from "@/lib/goals-api";

import { emptyStep, hasProblems, stepOf, stepProblems } from "../product/funnel-steps";
import { StepFields } from "../product/step-fields";

const STEP_HELP = {
  event:
    "Counts visitors whose browser sent this event. If you add a property filter, the value must match. Server events have no visitor and do not count toward goals.",
  page: "Counts the visitors who viewed exactly this path, without its query or fragment.",
} as const;

/** The form, mounted while the dialog is open, so each opening starts empty. */
function AddGoalForm({
  projectId,
  eventNames,
  onAdded,
}: {
  projectId: string;
  eventNames: readonly string[];
  onAdded: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = React.useState("");
  const [step, setStep] = React.useState(emptyStep);
  const [checked, setChecked] = React.useState(false);
  const nameId = React.useId();
  const eventListId = React.useId();
  const add = useMutation({
    mutationFn: () => createGoal(projectId, name, stepOf(step)),
    onSuccess: () => {
      // Its counts come with the next analytics answer.
      void queryClient.invalidateQueries({ queryKey: ["analytics", projectId] });
      onAdded();
    },
  });

  const nameProblem = goalNameProblem(name);
  const problems = stepProblems(step);
  const valid = nameProblem === null && !hasProblems(problems);
  const takenError =
    add.error instanceof ApiError && add.error.code === "goal_name_taken" ? add.error : null;
  const nameTaken = takenError !== null;
  const shownNameProblem = checked && nameProblem !== null ? nameProblem : null;
  const nameError = shownNameProblem ?? takenError?.message ?? null;

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setChecked(true);
        if (valid && !add.isPending) add.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle>Add a goal</DialogTitle>
        <DialogDescription>
          A goal is a page or event that counts as a success. The analytics page shows how many
          visitors reached it.
        </DialogDescription>
      </DialogHeader>
      <Field data-invalid={nameError !== null || undefined}>
        <FieldLabel htmlFor={nameId}>Name</FieldLabel>
        <Input
          id={nameId}
          value={name}
          placeholder="Signed up"
          autoComplete="off"
          aria-invalid={nameError !== null || undefined}
          aria-describedby={nameError === null ? undefined : `${nameId}-error`}
          onChange={(event) => {
            setName(event.target.value);
            if (nameTaken) add.reset();
          }}
        />
        {nameError !== null && <FieldError id={`${nameId}-error`}>{nameError}</FieldError>}
      </Field>
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-sm font-medium text-ink">Reached when</legend>
        <datalist id={eventListId}>
          {eventNames.map((eventName) => (
            <option key={eventName} value={eventName}>
              {eventName}
            </option>
          ))}
        </datalist>
        <StepFields
          step={step}
          problems={checked ? problems : {}}
          eventListId={eventListId}
          typeLabel="Goal type"
          onChange={setStep}
        />
        <FieldDescription>{STEP_HELP[step.type]}</FieldDescription>
      </fieldset>
      {checked && !valid && (
        <p role="alert" className="text-sm text-destructive">
          The goal is incomplete. Correct the marked fields above.
        </p>
      )}
      {add.error !== null && !nameTaken && (
        <Alert variant="destructive" role="alert">
          <OctagonAlertIcon />
          <AlertDescription>{add.error.message}</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
        <Button type="submit" disabled={add.isPending}>
          {add.isPending && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
          Add goal
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Adds a goal: a name, and the page or event that reaches it, checked as the API checks them. */
export function AddGoalDialog({
  open,
  onOpenChange,
  projectId,
  eventNames,
  returnFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** The page's custom events, offered as suggestions. */
  eventNames: readonly string[];
  /** Where focus goes on closing: the button that opened it may be gone after the refetch. */
  returnFocus: React.RefObject<HTMLElement | null>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" finalFocus={returnFocus}>
        <AddGoalForm
          projectId={projectId}
          eventNames={eventNames}
          onAdded={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
