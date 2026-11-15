import type * as React from "react";

/** Placeholder mark. Final Ottertrail branding has not been decided. */
export function BrandMark(props: React.ComponentProps<"svg">) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <rect width="24" height="24" rx="6" fill="var(--brand)" />
      <path
        d="M5 15.5c2.2-3.6 4.2-3.6 6 0s3.8 3.6 6 0c.7-1.1 1.3-1.9 2-2.3"
        stroke="#fff"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="16.5" cy="8" r="1.5" fill="#fff" />
    </svg>
  );
}
