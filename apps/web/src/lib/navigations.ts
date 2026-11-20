/**
 * Routers that have moved since the page loaded: a link, Back, or a retry
 * (`router.invalidate()`). A state that replaces the page, such as a 404 or
 * an error, moves focus to its heading and announces itself only then; on
 * the page's first load it is the page, and a screen reader starts there.
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
