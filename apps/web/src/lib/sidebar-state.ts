const SIDEBAR_KEY = "ottertrail.sidebar";

/** Whether the sidebar starts expanded: yes, unless this browser collapsed it last. */
export function sidebarOpen(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) !== "collapsed";
  } catch {
    return true;
  }
}

export function rememberSidebar(open: boolean) {
  try {
    window.localStorage.setItem(SIDEBAR_KEY, open ? "expanded" : "collapsed");
  } catch {
    // Storage can be off or full; the sidebar then opens expanded next time.
  }
}
