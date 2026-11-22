import { afterEach, beforeEach, vi } from "vite-plus/test";

import { resetThemeForTests } from "../../src/lib/theme.ts";
import { emulateColorScheme } from "./color-scheme.ts";
import { fakeFetch, removeFakeApi } from "./fake-api.ts";
import { installFakeEventSource } from "./fake-event-source.ts";
import { unmountAll } from "./mounted.ts";

// Runs before the test file loads the app, so every client that keeps a
// reference to fetch at start-up (the sign-in client does) gets the fake one.
// Nothing imported above loads the app.
globalThis.fetch = fakeFetch;
// Nor does the Server log's stream reach a server: tests play its side (fake-event-source.ts).
installFakeEventSource();

/** Console errors during a test, such as React or Base UI warnings; each test expects none. */
let consoleErrors: unknown[][] = [];

beforeEach(async () => {
  consoleErrors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args);
  });
  window.localStorage.clear();
  installFakeEventSource();
  // Each test starts on a dark device with no stored choice: System, so dark.
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
