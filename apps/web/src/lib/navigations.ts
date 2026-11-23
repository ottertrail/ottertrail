/**
 * Track navigation, Back, and retries so page states focus and announce their headings.
 * On first load, screen readers already start at the top.
 */
const moved = new WeakSet<object>();

/** Called on each navigation that comes from a page already shown (router.tsx). */
export function markNavigated(router: object) {
  moved.add(router);
}

/** Whether the router has moved since the page loaded. */
export function hasNavigated(router: object): boolean {
  return moved.has(router);
}
