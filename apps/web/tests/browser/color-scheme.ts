import { commands } from "vite-plus/test/browser/context";

/**
 * Uses vite.config.ts's Playwright command to change prefers-color-scheme.
 */
export async function emulateColorScheme(scheme: "light" | "dark"): Promise<void> {
  const command: unknown = Reflect.get(commands, "emulateColorScheme");
  if (typeof command !== "function") {
    throw new TypeError("The emulateColorScheme command is missing from vite.config.ts");
  }
  await command.call(commands, scheme);
}
