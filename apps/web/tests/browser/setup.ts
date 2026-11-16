import { fakeFetch } from "./fake-api.ts";

// Before any app module loads, so every client that keeps a reference to
// fetch at start-up gets the fake one.
globalThis.fetch = fakeFetch;
