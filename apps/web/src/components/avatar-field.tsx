import { cn } from "cn";
import * as React from "react";

import { AvatarSquare } from "@/components/avatar-square";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { AVATAR_TYPES, avatarDataUrl } from "@/lib/avatars";

/**
 * Choosing or removing an image waits for Save. value is a saved URL, a data: preview,
 * or null. Disable uploads when object storage is unavailable.
 */
export function AvatarField({
  label,
  value,
  onChange,
  text,
  fallbackSrc,
  uploads,
}: {
  label: string;
  value: string | null;
  onChange: (value: string | null) => void;
  /** The initial or initials shown without an image. */
  text: string;
  /** What shows when no image is set: a project's site's favicon. */
  fallbackSrc?: string | null;
  /** Whether the instance can store avatars (GET /api/me's `avatarUploads`). */
  uploads: boolean;
}) {
  const id = React.useId();
  const inputId = `${id}-file`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const [error, setError] = React.useState<string | null>(null);
  // Only the latest choice counts, should an earlier one finish reading later.
  const choice = React.useRef(0);

  async function choose(file: File) {
    const mine = (choice.current += 1);
    setError(null);
    try {
      const image = await avatarDataUrl(file);
      if (mine === choice.current) onChange(image);
    } catch (problem) {
      if (mine === choice.current) {
        setError(problem instanceof Error ? problem.message : "This file can't be read.");
      }
    }
  }

  const describedBy = [error === null ? null : errorId, uploads ? null : hintId]
    .filter((part) => part !== null)
    .join(" ");
  return (
    <Field data-invalid={error !== null || undefined}>
      <FieldLabel htmlFor={inputId}>{label}</FieldLabel>
      <div className="flex flex-wrap items-center gap-3">
        <AvatarSquare
          src={value ?? fallbackSrc}
          text={text}
          className="size-12"
          textClassName="text-base"
        />
        {/* The file input is the control, kept for keyboards and screen
            readers and hidden from sight; the label after it looks like a
            button and shows the input's focus. */}
        <input
          id={inputId}
          type="file"
          accept={AVATAR_TYPES.join(",")}
          className="peer sr-only"
          aria-label={`${label}, choose image`}
          disabled={!uploads}
          aria-describedby={describedBy === "" ? undefined : describedBy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            // The same file chosen again after Discard must still count.
            event.target.value = "";
            if (file !== undefined) void choose(file);
          }}
        />
        <label
          htmlFor={inputId}
          aria-hidden="true"
          className={cn(
            buttonVariants({ variant: "outline", size: "sm" }),
            "cursor-pointer peer-focus-visible:border-ring peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
          )}
        >
          Choose image
        </label>
        {value !== null && uploads && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setError(null);
              onChange(null);
            }}
          >
            Remove
          </Button>
        )}
      </div>
      {error !== null && <FieldError id={errorId}>{error}</FieldError>}
      {!uploads && (
        <FieldDescription id={hintId}>
          Uploads need object storage. Set OBJECT_STORE_URL on the server.
        </FieldDescription>
      )}
    </Field>
  );
}
