import * as React from "react";

/** Outside a workbench, treat the pane as visible and return dialog focus normally. */
export interface WorkbenchPane {
  /**
   * Whether the pane is on screen. Under 64rem CSS hides it, still mounted:
   * what polls or plays in it stops until it shows again.
   */
  shown: boolean;
  /** Return focus to the selected row when the pane is hidden; otherwise use the dialog trigger. */
  finalFocus: () => HTMLElement | true;
}

const defaultPane: WorkbenchPane = { shown: true, finalFocus: () => true };

export const WorkbenchPaneContext = React.createContext<WorkbenchPane>(defaultPane);

export function useWorkbenchPane(): WorkbenchPane {
  return React.useContext(WorkbenchPaneContext);
}

/** Stop polling in hidden panes. Spread after query options to override their polling interval. */
export function usePanePolling(): { refetchInterval?: false } {
  return useWorkbenchPane().shown ? {} : { refetchInterval: false };
}
