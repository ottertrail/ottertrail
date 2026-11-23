import { cn } from "cn";
import type * as React from "react";

import { PopoverTitle } from "@/components/ui/popover";
import { SheetTitle } from "@/components/ui/sheet";

export type PanelKind = "popover" | "sheet";

export function PanelTitle({ kind }: { kind: PanelKind }) {
  const className = "text-sm font-medium text-ink";
  return kind === "sheet" ? (
    <SheetTitle className={className}>Notifications</SheetTitle>
  ) : (
    <PopoverTitle className={className}>Notifications</PopoverTitle>
  );
}

export function PanelHead({ kind, children }: { kind: PanelKind; children?: React.ReactNode }) {
  return (
    <div
      className={cn(
        "flex min-h-11 items-center justify-between gap-3 border-b py-1.5 pl-3",
        kind === "sheet" ? "pr-12" : "pr-1.5",
      )}
    >
      <PanelTitle kind={kind} />
      {children}
    </div>
  );
}
