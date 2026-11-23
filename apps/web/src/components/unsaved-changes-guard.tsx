import { useBlocker } from "@tanstack/react-router";
import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { type Registry, RegistryContext } from "@/hooks/unsaved-changes";

/**
 * Guard navigation, Back, tab close, and reload when any form is dirty.
 * Allow search-only tab changes because forms stay mounted.
 */
export function UnsavedChangesGuard({ children }: { children: React.ReactNode }) {
  // Read when leaving, in the same tick as a save or a discard that just ran.
  const dirtyForms = React.useRef(new Set<string>());
  const discards = React.useRef(new Map<string, () => void>());
  // For rendering: the blocker and the browser's question are on only while something is dirty.
  const [dirty, setDirty] = React.useState(false);
  const registry = React.useMemo<Registry>(
    () => ({
      report: (id, formDirty) => {
        if (formDirty) dirtyForms.current.add(id);
        else dirtyForms.current.delete(id);
        setDirty(dirtyForms.current.size > 0);
      },
      register: (id, discard) => {
        discards.current.set(id, discard);
        return () => {
          discards.current.delete(id);
        };
      },
    }),
    [],
  );
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      dirtyForms.current.size > 0 && current.pathname !== next.pathname,
    disabled: !dirty,
    // The guard's own listener below asks on close or reload, whatever the history.
    enableBeforeUnload: false,
    withResolver: true,
  });
  React.useEffect(() => {
    if (!dirty) return undefined;
    const ask = (event: BeforeUnloadEvent) => {
      if (dirtyForms.current.size > 0) event.preventDefault();
    };
    window.addEventListener("beforeunload", ask);
    return () => window.removeEventListener("beforeunload", ask);
  }, [dirty]);
  // Leaving anyway drops the edits, so a page that stays mounted (another project's
  // settings, the same component) starts from the saved values.
  const leave = () => {
    for (const discard of discards.current.values()) discard();
    blocker.proceed?.();
  };

  return (
    <RegistryContext.Provider value={registry}>
      {children}
      <Dialog
        open={blocker.status === "blocked"}
        onOpenChange={(open) => {
          if (!open) blocker.reset?.();
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Leave without saving?</DialogTitle>
            <DialogDescription>Your unsaved changes will be lost.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => blocker.reset?.()}>
              Stay on this page
            </Button>
            <Button variant="destructive" onClick={leave}>
              Leave and discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </RegistryContext.Provider>
  );
}
