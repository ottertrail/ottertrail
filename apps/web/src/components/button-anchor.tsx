import type { VariantProps } from "class-variance-authority";
import { cn } from "cn";
import type * as React from "react";

import { buttonVariants } from "@/components/ui/button";

/** An anchor with the button styles; use it through ButtonLink (button-link.ts). */
export function ButtonAnchor({
  className,
  variant,
  size,
  children,
  ...props
}: React.ComponentProps<"a"> & VariantProps<typeof buttonVariants>) {
  return (
    <a data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props}>
      {children}
    </a>
  );
}
