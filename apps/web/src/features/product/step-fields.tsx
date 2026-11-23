import { PlusIcon, XIcon } from "lucide-react";
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

import type { DraftStep, StepProblems } from "./funnel-steps";

const STEP_TYPES = [
  { value: "event", label: "Event" },
  { value: "page", label: "Page" },
] as const;

const isStepType = (value: unknown): value is DraftStep["type"] =>
  value === "event" || value === "page";

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

export function StepFields({
  step,
  problems,
  eventListId,
  typeLabel,
  onChange,
}: {
  step: DraftStep;
  /** Hide validation problems until the form has been checked. */
  problems: StepProblems;
  eventListId: string;
  typeLabel: string;
  onChange: (step: DraftStep) => void;
}) {
  return (
    <>
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
            <SelectTrigger aria-label={typeLabel} className="w-28">
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
    </>
  );
}
