import { cn } from "cn";
import { OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { DirtyForm } from "@/hooks/use-dirty-form";

/**
 * One settings form with its own Save bar, sticky at the foot of the
 * screen while the form is in view.
 *
 * - Save is disabled until something in the form changes, and again when
 *   the change is undone; "Unsaved changes" and Discard show meanwhile.
 * - While `saving`, Save says so and the bar waits; a failed save shows
 *   `error` above the bar and keeps the edits.
 * - A section without fields (a key, a danger zone) leaves out `form` and
 *   has no Save bar.
 */
export function SettingsSection<T>({
  title,
  description,
  form,
  onSave,
  saving = false,
  error,
  saveLabel = "Save changes",
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
  children: React.ReactNode;
  className?: string;
}) {
  const headingId = React.useId();
  const saveRef = React.useRef<HTMLButtonElement>(null);
  const head = (
    <header className="flex max-w-2xl flex-col gap-1">
      <h2 id={headingId} className="text-base font-medium text-ink">
        {title}
      </h2>
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
        <div className="flex max-w-2xl flex-col gap-6">{children}</div>
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
        // Discard leaves the bar; focus stays in it rather than dropping to the page.
        focusSave();
      }}
    >
      {head}
      <div className="flex max-w-2xl flex-col gap-6">{children}</div>
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
        >
          {saving ? "Saving…" : saveLabel}
        </Button>
      </div>
    </form>
  );
}
