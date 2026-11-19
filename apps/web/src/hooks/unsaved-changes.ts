import * as React from "react";

/** Where forms report whether they hold unsaved changes (components/unsaved-changes-guard.tsx). */
export interface Registry {
  /** Says at once whether form `id` holds unsaved changes; leaving reads it in the same tick. */
  report: (id: string, dirty: boolean) => void;
  /** Lets the guard discard the form's edits when the user leaves anyway. */
  register: (id: string, discard: () => void) => () => void;
}

export const RegistryContext = React.createContext<Registry | null>(null);

/** The nearest guard, for `useDirtyForm`; null outside one. */
export function useUnsavedChangesRegistry(): Registry | null {
  return React.useContext(RegistryContext);
}
