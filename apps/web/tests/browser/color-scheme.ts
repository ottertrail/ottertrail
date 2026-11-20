import { commands } from "vite-plus/test/browser/context";

/**
 * Sets the device's color scheme, as `prefers-color-scheme` reads it, through
 * the command vite.config.ts adds (Playwright's emulateMedia on the test page).
 */
export async function emulateColorScheme(scheme: "light" | "dark"): Promise<void> {
  const command: unknown = Reflect.get(commands, "emulateColorScheme");
  if (typeof command !== "function") {
    throw new TypeError("The emulateColorScheme command is missing from vite.config.ts");
  }
  await command.call(commands, scheme);
}
