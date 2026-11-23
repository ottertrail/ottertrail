import { useId } from "react";
import type * as React from "react";

/*
 * The Ottertrail logo (docs/design-system.md, "Logo"): an otter's head held up,
 * on a slim neck with a rounded base. The eye is cut out, so the surface behind
 * shows through. The same shapes are in public/favicon.svg; change both together.
 */
const OTTER =
  "M176 33C184 21 198 16 211 18C220 19 226 24 231 27C237 30 237 39 231 42C224 45 217 45 210 47C203 49 200 55 201 61C202 67 206 71 205 73C204 76 197 77 186 77C175 77 168 76 167 73C166 70 169 66 170 60L171 50C171 44 173 38 176 33Z";
const EYE = "M206 31Q212.5 24 219 31";

export function BrandMark(props: React.ComponentProps<"svg">) {
  // useId's characters (":r1:", "«r1»") are not safe inside url(#…).
  const eye = `otter-eye-${useId().replace(/[^\w-]/g, "")}`;
  return (
    <svg viewBox="159.5 3 84 84" aria-hidden="true" {...props}>
      <mask id={eye}>
        <rect x="150" y="-5" width="100" height="100" fill="#fff" />
        <path d={EYE} fill="none" stroke="#000" strokeWidth="3" strokeLinecap="round" />
      </mask>
      <g mask={`url(#${eye})`} fill="var(--brand)">
        <circle cx="186" cy="21" r="8" />
        <path d={OTTER} />
      </g>
    </svg>
  );
}
