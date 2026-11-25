import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { type FunnelStep, MAX_STEPS, MIN_STEPS } from "@/lib/product-api";

import {
  type DraftStep,
  draftOf,
  emptyStep,
  hasProblems,
  type StepProblems,
  stepOf,
  allStepProblems,
} from "./funnel-steps";
import { StepFields } from "./step-fields";

function StepEditor({
  step,
  index,
  steps,
  problems,
  eventListId,
  onChange,
  onMove,
  onRemove,
}: {
  step: DraftStep;
  index: number;
  steps: number;
  problems: StepProblems;
  eventListId: string;
  onChange: (step: DraftStep) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const number = index + 1;
  return (
    <li>
      <fieldset className="flex min-w-0 flex-col gap-3 border-t border-hairline py-3">
        <legend className="sr-only">Step {number}</legend>
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="text-sm font-medium text-ink">
            Step {number}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Move step ${number} up`}
              disabled={index === 0}
              onClick={() => onMove(-1)}
            >
              <ArrowUpIcon aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Move step ${number} down`}
              disabled={index === steps - 1}
              onClick={() => onMove(1)}
            >
              <ArrowDownIcon aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove step ${number}`}
              disabled={steps <= MIN_STEPS}
              onClick={onRemove}
            >
              <Trash2Icon aria-hidden="true" />
            </Button>
          </div>
        </div>
        <StepFields
          step={step}
          problems={problems}
          eventListId={eventListId}
          typeLabel={`Step ${number} type`}
          onChange={onChange}
        />
      </fieldset>
    </li>
  );
}

function draftsOf(steps: readonly FunnelStep[]): DraftStep[] {
  const drafts = steps.map(draftOf);
  while (drafts.length < MIN_STEPS) drafts.push(emptyStep());
  return drafts;
}

const keyOf = (steps: readonly FunnelStep[]) => JSON.stringify(steps);

/**
 * Keep 2 to 5 steps. Address changes replace the draft. In a dialog (`onCancel`), the form ends
 * with Cancel and its submit button.
 */
export function FunnelEditor({
  applied,
  eventNames,
  onApply,
  submitLabel = "Show funnel",
  onCancel,
  children,
}: {
  applied: readonly FunnelStep[];
  eventNames: readonly string[];
  onApply: (steps: FunnelStep[]) => void;
  submitLabel?: string;
  onCancel?: () => void;
  children?: React.ReactNode;
}) {
  const eventListId = React.useId();
  const appliedKey = keyOf(applied);
  const [state, setState] = React.useState(() => ({
    key: appliedKey,
    drafts: draftsOf(applied),
    checked: false,
  }));
  if (state.key !== appliedKey) {
    // Keep matching drafts to preserve focus; reset for other address changes.
    const same =
      allStepProblems(state.drafts).every((problem) => !hasProblems(problem)) &&
      keyOf(state.drafts.map(stepOf)) === appliedKey;
    setState(
      same
        ? { ...state, key: appliedKey }
        : { key: appliedKey, drafts: draftsOf(applied), checked: false },
    );
  }
  const { drafts, checked } = state;
  const problems = allStepProblems(drafts);
  const valid = problems.every((problem) => !hasProblems(problem));
  const changed = !valid || keyOf(drafts.map(stepOf)) !== appliedKey;

  const setDrafts = (next: DraftStep[]) => setState({ ...state, drafts: next });
  const move = (index: number, by: -1 | 1) => {
    const next = [...drafts];
    const [step] = next.splice(index, 1);
    if (step !== undefined) next.splice(index + by, 0, step);
    setDrafts(next);
  };

  return (
    <form
      noValidate
      aria-label="Funnel steps"
      className="flex max-w-4xl flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) {
          setState({ ...state, checked: false });
          onApply(drafts.map(stepOf));
        } else {
          setState({ ...state, checked: true });
        }
      }}
    >
      <datalist id={eventListId}>
        {eventNames.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </datalist>
      <ol className="flex flex-col border-b border-hairline">
        {drafts.map((step, index) => (
          <StepEditor
            key={step.id}
            step={step}
            index={index}
            steps={drafts.length}
            problems={checked ? (problems[index] ?? {}) : {}}
            eventListId={eventListId}
            onChange={(changedStep) =>
              setDrafts(drafts.map((item) => (item.id === changedStep.id ? changedStep : item)))
            }
            onMove={(by) => move(index, by)}
            onRemove={() => setDrafts(drafts.filter((item) => item.id !== step.id))}
          />
        ))}
      </ol>
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={drafts.length >= MAX_STEPS}
          onClick={() => setDrafts([...drafts, emptyStep()])}
        >
          <PlusIcon aria-hidden="true" />
          Add a step
        </Button>
        {drafts.length >= MAX_STEPS && (
          <span className="ml-3 text-xs text-ink-subtle">
            A funnel has at most {MAX_STEPS} steps.
          </span>
        )}
      </div>
      {children}
      {onCancel === undefined ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit">{submitLabel}</Button>
          {checked && !valid && (
            <p role="alert" className="text-sm text-destructive">
              Some steps are incomplete. Correct the marked fields above.
            </p>
          )}
          {applied.length >= MIN_STEPS && changed && !(checked && !valid) && (
            <p className="text-sm text-ink-subtle">The funnel below is for the steps last shown.</p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {checked && !valid && (
            <p role="alert" className="text-sm text-destructive">
              Some steps are incomplete. Correct the marked fields above.
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit">{submitLabel}</Button>
          </div>
        </div>
      )}
    </form>
  );
}
