import * as React from "react";

/**
 * What the Workbench tells the content of its detail pane (`workbench.tsx`).
 * Outside a workbench, such as on an item's own page, the pane counts as shown
 * and dialogs return focus as they would.
 */
export interface WorkbenchPane {
  /**
   * Whether the pane is on screen. Under 64rem CSS hides it, still mounted:
   * what polls or plays in it stops until it shows again.
   */
  shown: boolean;
  /**
   * Where a dialog opened from the pane returns focus as it closes (Base UI's
   * `finalFocus`): while the pane is hidden, the selected row; otherwise the
   * dialog's default, its trigger.
   */
  finalFocus: () => HTMLElement | true;
}

const defaultPane: WorkbenchPane = { shown: true, finalFocus: () => true };

export const WorkbenchPaneContext = React.createContext<WorkbenchPane>(defaultPane);

export function useWorkbenchPane(): WorkbenchPane {
  return React.useContext(WorkbenchPaneContext);
}

/**
 * Options that stop a query's polling while its workbench pane is hidden:
 * spread after the query's own (`useQuery({ ...checkQuery(id), ...usePanePolling() })`).
 * Polling starts again as the pane shows.
 */
export function usePanePolling(): { refetchInterval?: false } {
  return useWorkbenchPane().shown ? {} : { refetchInterval: false };
}
