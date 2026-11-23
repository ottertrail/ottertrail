/** Separate module so browser tests can replace it; location.reload cannot be replaced. */
export function reloadPage() {
  window.location.reload();
}
