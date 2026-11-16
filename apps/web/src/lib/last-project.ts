const LAST_PROJECT_KEY = "ottertrail.project";

/** The project this browser showed last, if storage allows. */
export function lastProject(): string | null {
  try {
    return window.localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    return null;
  }
}

export function rememberProject(projectId: string) {
  try {
    window.localStorage.setItem(LAST_PROJECT_KEY, projectId);
  } catch {
    // Storage can be off or full; the home page then opens the first project.
  }
}

/** After a project is deleted: the home page should not try to open it. */
export function forgetProject(projectId: string) {
  try {
    if (window.localStorage.getItem(LAST_PROJECT_KEY) === projectId) {
      window.localStorage.removeItem(LAST_PROJECT_KEY);
    }
  } catch {
    // Storage can be off; the home page then finds the project gone anyway.
  }
}
