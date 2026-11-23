/**
 * The player page's Content Security Policy for styles, images, and fonts
 * (apps/api/src/replays/dashboard-routes.ts, playerPolicy), for a project
 * whose allowed hostname is example.com: every browser test runs under it,
 * so the player is shown to need no 'self' there. Scripts and connections
 * stay open for the test runner; the API's tests check those directives.
 */
const sites = "https://example.com:* http://example.com:*";
export const PLAYER_POLICY = [
  `style-src 'unsafe-inline' ${sites}`,
  `img-src data: blob: ${sites}`,
  `font-src data: ${sites}`,
].join("; ");

declare global {
  interface Window {
    /** What the policy refused in this test page, outside the replay's frame. */
    ottertrailViolations: string[];
  }
}

window.ottertrailViolations = [];
document.addEventListener("securitypolicyviolation", (event) => {
  window.ottertrailViolations.push(`${event.effectiveDirective} ${event.blockedURI}`);
});
const meta = document.createElement("meta");
meta.httpEquiv = "Content-Security-Policy";
meta.content = PLAYER_POLICY;
document.head.prepend(meta);
