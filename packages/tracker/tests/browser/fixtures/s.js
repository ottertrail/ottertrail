// Stands in for s.js in tests/browser/snapshot.test.ts: hands back the
// test's snapshot function as s.js does, while it is the running script.
document.currentScript.ottertrailSnapshot.ready(window.ottertrailTestTake);
