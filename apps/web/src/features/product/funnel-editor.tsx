import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

const STEP_TYPES = [
  { value: "event", label: "Event" },
  { value: "page", label: "Page" },
] as const;

const isStepType = (value: unknown): value is FunnelStep["type"] =>
  value === "event" || value === "page";

/** One input with its label, and its problem once the form was checked. */
function Field({
  label,
  problem,
  children,
}: {
  label: string;
  problem: string | undefined;
  children: (props: {
    id: string;
    "aria-invalid": boolean | undefined;
    "aria-describedby": string | undefined;
  }) => React.ReactNode;
}) {
  const id = React.useId();
  const problemId = `${id}-problem`;
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs text-ink-subtle">
        {label}
      </Label>
      {children({
        id,
        "aria-invalid": problem === undefined ? undefined : true,
        "aria-describedby": problem === undefined ? undefined : problemId,
      })}
      {problem !== undefined && (
        <p id={problemId} className="text-xs text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}

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
      <fieldset className="flex flex-col gap-3 rounded-lg border border-hairline p-3">
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
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-ink-subtle" aria-hidden="true">
              Type
            </span>
            <Select
              items={STEP_TYPES}
              value={step.type}
              onValueChange={(value) => {
                if (isStepType(value)) onChange({ ...step, type: value });
              }}
            >
              <SelectTrigger aria-label={`Step ${number} type`} className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STEP_TYPES.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {step.type === "event" ? (
            <Field label="Event name" problem={problems.name}>
              {(props) => (
                <Input
                  {...props}
                  list={eventListId}
                  value={step.name}
                  placeholder="signup"
                  autoComplete="off"
                  className="font-mono"
                  onChange={(event) => onChange({ ...step, name: event.target.value })}
                />
              )}
            </Field>
          ) : (
            <Field label="Path" problem={problems.path}>
              {(props) => (
                <Input
                  {...props}
                  value={step.path}
                  placeholder="/pricing"
                  autoComplete="off"
                  className="font-mono"
                  onChange={(event) => onChange({ ...step, path: event.target.value })}
                />
              )}
            </Field>
          )}
        </div>
        {step.type === "event" &&
          (step.filter === null ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="self-start"
              onClick={() => onChange({ ...step, filter: { key: "", value: "" } })}
            >
              <PlusIcon aria-hidden="true" />
              Add a property filter
            </Button>
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Property" problem={problems.filterKey}>
                {(props) => (
                  <Input
                    {...props}
                    value={step.filter?.key ?? ""}
                    placeholder="plan"
                    autoComplete="off"
                    className="font-mono"
                    onChange={(event) =>
                      onChange({
                        ...step,
                        filter: { key: event.target.value, value: step.filter?.value ?? "" },
                      })
                    }
                  />
                )}
              </Field>
              <span className="pb-1.5 text-sm text-ink-subtle" aria-hidden="true">
                =
              </span>
              <Field label="Value" problem={problems.filterValue}>
                {(props) => (
                  <Input
                    {...props}
                    value={step.filter?.value ?? ""}
                    placeholder="team"
                    autoComplete="off"
                    className="font-mono"
                    onChange={(event) =>
                      onChange({
                        ...step,
                        filter: { key: step.filter?.key ?? "", value: event.target.value },
                      })
                    }
                  />
                )}
              </Field>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onChange({ ...step, filter: null })}
              >
                <XIcon aria-hidden="true" />
                Remove the filter
              </Button>
            </div>
          ))}
      </fieldset>
    </li>
  );
}

/** The drafts a funnel's steps start the editor with: at least two. */
function draftsOf(steps: readonly FunnelStep[]): DraftStep[] {
  const drafts = steps.map(draftOf);
  while (drafts.length < MIN_STEPS) drafts.push(emptyStep());
  return drafts;
}

const keyOf = (steps: readonly FunnelStep[]) => JSON.stringify(steps);

/**
 * The funnel's steps, edited here and shown with "Show funnel": 2 to 5,
 * each an event (with an optional property filter) or a page. The shown
 * steps live in the address; a change there (Back, a link) replaces the
 * draft.
 */
export function FunnelEditor({
  applied,
  eventNames,
  onApply,
  children,
}: {
  applied: readonly FunnelStep[];
  /** The project's event names, offered as suggestions. */
  eventNames: readonly string[];
  onApply: (steps: FunnelStep[]) => void;
  /** More settings, such as the count and the window, before the button. */
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
    // The address changed. When it now holds this draft (just shown), keep
    // the draft, so focus and the inputs stay; otherwise start from it.
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
      className="flex flex-col gap-4"
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
      <ol className="flex flex-col gap-3">
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
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit">Show funnel</Button>
        {checked && !valid && (
          <p role="alert" className="text-sm text-destructive">
            Some steps are not complete. Fix the fields marked above.
          </p>
        )}
        {applied.length >= MIN_STEPS && changed && !(checked && !valid) && (
          <p className="text-sm text-ink-subtle">The funnel below is for the steps last shown.</p>
        )}
      </div>
    </form>
  );
}
