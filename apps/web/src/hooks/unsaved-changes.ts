import * as React from "react";

/** Shared with components/unsaved-changes-guard.tsx. */
export interface Registry {
  /** Reports synchronously because navigation reads it in the same tick. */
  report: (id: string, dirty: boolean) => void;
  /** Registers cleanup for leaving with unsaved edits. */
  register: (id: string, discard: () => void) => () => void;
}

export const RegistryContext = React.createContext<Registry | null>(null);

/** Returns null outside an unsaved changes guard. */
export function useUnsavedChangesRegistry(): Registry | null {
  return React.useContext(RegistryContext);
}
