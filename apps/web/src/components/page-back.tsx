import { cn } from "cn";
import { ArrowLeftIcon } from "lucide-react";
import type * as React from "react";

import { PageBackSlot } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * An item's way back to its list, in the page header before its title
 * (docs/design-system.md, "Page header"): an arrow named by `label` ("All
 * events"), which its tooltip shows. `link` is the router link, without
 * children or styles. Its own module, so only the pages that use it load it.
 */
export function PageBack({ label, link }: { label: string; link: React.ReactElement }) {
  return (
    <PageBackSlot>
      <Tooltip>
        <TooltipTrigger
          render={link}
          aria-label={label}
          data-slot="page-back"
          // 44px to a finger, 32px to the eye, as the menu button.
          className={cn(
            buttonVariants({ variant: "ghost", size: "icon" }),
            "relative text-ink-muted after:absolute after:-inset-1.5",
          )}
        >
          <ArrowLeftIcon aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    </PageBackSlot>
  );
}
