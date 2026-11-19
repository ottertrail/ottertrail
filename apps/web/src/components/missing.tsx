import { MISSING } from "@/lib/missing";

/**
 * A missing value in a table: the placeholder dash for the eye, and what is
 * missing in words for a screen reader ("Not sent"), which would otherwise
 * read "en dash".
 */
export function Missing({ label, className }: { label: string; className?: string }) {
  return (
    <span className={className} title={label}>
      <span aria-hidden="true">{MISSING}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
