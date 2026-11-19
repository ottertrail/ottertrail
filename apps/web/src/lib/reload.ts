/**
 * Reloads the page, fetching the dashboard's current version. Its own
 * module so a browser test can replace it: `location.reload` cannot be.
 */
export function reloadPage() {
  window.location.reload();
}
