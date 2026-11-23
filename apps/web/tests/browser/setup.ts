import { afterEach, beforeEach, vi } from "vite-plus/test";

import { resetThemeForTests } from "../../src/lib/theme.ts";
import { emulateColorScheme } from "./color-scheme.ts";
import { fakeFetch, removeFakeApi } from "./fake-api.ts";
import { installFakeEventSource } from "./fake-event-source.ts";
import { unmountAll } from "./mounted.ts";

// Install before app imports so clients that capture fetch use the fake.
// Imports above must not load the app.
globalThis.fetch = fakeFetch;
// Keep Server log streams local to tests (fake-event-source.ts).
installFakeEventSource();

/** Console errors fail the test, including React and Base UI warnings. */
let consoleErrors: unknown[][] = [];

beforeEach(async () => {
  consoleErrors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args);
  });
  window.localStorage.clear();
  installFakeEventSource();
  // Without a stored choice, System follows the emulated dark scheme.
  await emulateColorScheme("dark");
  resetThemeForTests();
});

afterEach(() => {
  unmountAll();
  removeFakeApi();
  vi.restoreAllMocks();
  if (consoleErrors.length > 0) {
    throw new Error(`The page logged errors: ${JSON.stringify(consoleErrors)}`);
  }
});
