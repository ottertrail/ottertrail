import { cn } from "cn";
import { OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { DirtyForm } from "@/hooks/use-dirty-form";

/** Keep edits after failed saves. Omit form for sections without editable fields or a Save bar. */
export function SettingsSection<T>({
  title,
  description,
  form,
  onSave,
  saving = false,
  error,
  saveLabel = "Save changes",
  headingRef,
  headingLevel = 2,
  wide = false,
  children,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  form?: DirtyForm<T>;
  onSave?: (values: T) => void;
  saving?: boolean;
  /** Why the last save failed, from the server's answer. */
  error?: string | undefined;
  saveLabel?: string;
  /** Accept focus when the previously focused control is removed, such as after deleting a row. */
  headingRef?: React.Ref<HTMLHeadingElement>;
  headingLevel?: 2 | 3;
  /** Use true for table width or "full" for the full page width. */
  wide?: boolean | "full";
  children: React.ReactNode;
  className?: string;
}) {
  const headingId = React.useId();
  const saveRef = React.useRef<HTMLButtonElement>(null);
  const Heading = `h${headingLevel}` as const;
  const content = cn(
    "flex flex-col gap-6",
    wide === "full" ? "min-w-0" : wide ? "max-w-5xl" : "max-w-2xl",
  );
  const head = (
    <header className="flex max-w-2xl flex-col gap-1">
      <Heading
        id={headingId}
        ref={headingRef}
        tabIndex={headingRef === undefined ? undefined : -1}
        className="text-base font-medium text-ink outline-none"
      >
        {title}
      </Heading>
      {description !== undefined && (
        <div className="text-sm text-pretty text-ink-subtle">{description}</div>
      )}
    </header>
  );
  if (form === undefined) {
    return (
      <section
        aria-labelledby={headingId}
        data-slot="settings-section"
        className={cn("flex flex-col gap-6 py-6", className)}
      >
        {head}
        <div className={content}>{children}</div>
      </section>
    );
  }
  const status = saving ? "Saving…" : form.dirty ? "Unsaved changes" : "No unsaved changes";
  const focusSave = () => requestAnimationFrame(() => saveRef.current?.focus());
  return (
    <form
      aria-labelledby={headingId}
      data-slot="settings-section"
      className={cn("flex flex-col gap-6 pt-6", className)}
      onSubmit={(event) => {
        event.preventDefault();
        if (form.dirty && !saving) onSave?.(form.values);
      }}
      onReset={(event) => {
        event.preventDefault();
        form.discard();
        // Keep focus in the Save bar after Discard removes its button.
        focusSave();
      }}
    >
      {head}
      <div className={content}>{children}</div>
      {error !== undefined && (
        <Alert variant="destructive" className="max-w-2xl">
          <OctagonAlertIcon />
          <AlertTitle>The changes were not saved</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div
        data-slot="save-bar"
        className="sticky bottom-0 z-10 -mx-[var(--gutter)] flex flex-wrap items-center gap-x-3 gap-y-2 border-t bg-[var(--block-surface,var(--background))] px-gutter py-3"
      >
        <output aria-live="polite" className="mr-auto text-sm text-ink-subtle">
          {status}
        </output>
        {form.conflict && (
          <p
            role="alert"
            className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-sm text-warning"
          >
            This section changed on the server while you edited it.
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                form.discard();
                focusSave();
              }}
            >
              Load the new values
            </Button>
          </p>
        )}
        {form.dirty && (
          <Button type="reset" variant="ghost" disabled={saving}>
            Discard
          </Button>
        )}
        <Button
          ref={saveRef}
          type="submit"
          // Focusable while disabled: focus stays on Save during and after the request.
          disabled={!form.dirty || saving}
          focusableWhenDisabled
          aria-busy={saving || undefined}
          // Base UI uses aria-disabled for focusable disabled buttons.
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
        >
          {saving ? "Saving…" : saveLabel}
        </Button>
      </div>
    </form>
  );
}
