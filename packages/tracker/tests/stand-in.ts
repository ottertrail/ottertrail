/**
 * The before-load stand-in, exactly as docs/session-replay.md ("Waiting for
 * consent") and the dashboard's Session replay tab give it to sites, for
 * calls before the deferred tracker runs.
 */
export const STAND_IN = `window.ottertrail = window.ottertrail || (function () {
  var q = [];
  var p = [];
  function noop() {}
  return {
    q: q,
    p: p,
    replay: function (on) { q.push(on); },
    pageview: function (path) { p.push(path); },
    track: noop,
    identify: noop,
    reset: noop,
    captureError: noop,
    notFound: noop,
  };
})();`;
