import * as React from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Goal } from "@/lib/goals-api";
import {
  FUNNEL_COUNTS,
  FUNNEL_WINDOWS,
  type FunnelCount,
  type FunnelStep,
  type FunnelWindow,
  isFunnelCount,
  isFunnelWindow,
  MAX_VISITOR_WINDOW,
  windowAllowed,
} from "@/lib/product-api";

import { FunnelEditor } from "./funnel-editor";

export interface FunnelDraft {
  steps: FunnelStep[];
  count: FunnelCount;
  window: FunnelWindow;
}

function FunnelSettings({
  count,
  window,
  onChange,
}: {
  count: FunnelCount;
  window: FunnelWindow;
  onChange: (next: { count: FunnelCount; window: FunnelWindow }) => void;
}) {
  return (
    <div className="flex flex-wrap items-start gap-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-ink-subtle" aria-hidden="true">
          Count by
        </span>
        <Select
          items={FUNNEL_COUNTS}
          value={count}
          onValueChange={(value) => {
            if (!isFunnelCount(value)) return;
            // Visitors cannot be followed past a day: shorten a longer window.
            onChange({
              count: value,
              window: windowAllowed(value, window) ? window : MAX_VISITOR_WINDOW,
            });
          }}
        >
          <SelectTrigger aria-label="Count by" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FUNNEL_COUNTS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-ink-subtle" aria-hidden="true">
          Conversion window
        </span>
        <Select
          items={FUNNEL_WINDOWS.map((item) => ({ value: item.value, label: item.label }))}
          value={window}
          onValueChange={(value) => {
            if (isFunnelWindow(value)) onChange({ count, window: value });
          }}
        >
          <SelectTrigger aria-label="Conversion window" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FUNNEL_WINDOWS.map((item) => (
              <SelectItem
                key={item.value}
                value={item.value}
                disabled={!windowAllowed(count, item.value)}
              >
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {count === "visitors" && (
        <p className="max-w-xs self-end pb-1.5 text-xs text-ink-subtle">
          Windows longer than a day need Users: a visitor's ID changes every day.
        </p>
      )}
    </div>
  );
}

/** The dialog's form, mounted on each open, so it starts from `initial`. */
function FunnelDraftForm({
  initial,
  eventNames,
  goals,
  onShow,
  onCancel,
}: {
  initial: FunnelDraft;
  eventNames: readonly string[];
  goals: readonly Goal[] | undefined;
  onShow: (draft: FunnelDraft) => void;
  onCancel: () => void;
}) {
  // Steps, who is counted, and the window apply together, with Show funnel.
  const [settings, setSettings] = React.useState({
    count: initial.count,
    window: initial.window,
  });
  return (
    <FunnelEditor
      applied={initial.steps}
      eventNames={eventNames}
      goals={goals}
      onCancel={onCancel}
      onApply={(steps) => onShow({ steps, ...settings })}
    >
      <FunnelSettings count={settings.count} window={settings.window} onChange={setSettings} />
    </FunnelEditor>
  );
}

/** Builds a new funnel, or changes the shown one's steps, in a dialog as Alerts' Add rule does. */
export function FunnelEditorDialog({
  open,
  onOpenChange,
  title,
  initial,
  eventNames,
  goals,
  onShow,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  initial: FunnelDraft;
  eventNames: readonly string[];
  /** The project's saved goals, to copy into steps. */
  goals: readonly Goal[] | undefined;
  onShow: (draft: FunnelDraft) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Two to eight steps, in the order people take them. Each step is a page or an event your
            site sends.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <FunnelDraftForm
            initial={initial}
            eventNames={eventNames}
            goals={goals}
            onCancel={() => onOpenChange(false)}
            onShow={(draft) => {
              onOpenChange(false);
              onShow(draft);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
