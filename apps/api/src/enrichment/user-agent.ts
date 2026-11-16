import { parse } from "bowser";
import { isbot } from "isbot";

export type DeviceType = "desktop" | "mobile" | "tablet" | "tv";

export interface Client {
  /** Such as "Chrome", "Safari", "Microsoft Edge". */
  browser?: string;
  /** Major version only, such as "142". */
  browserVersion?: string;
  /** Name only, such as "macOS" or "Android". */
  os?: string;
  deviceType?: DeviceType;
}

const DEVICE_TYPES: ReadonlySet<string> = new Set<DeviceType>([
  "desktop",
  "mobile",
  "tablet",
  "tv",
]);

function isDeviceType(type: string | undefined): type is DeviceType {
  return type !== undefined && DEVICE_TYPES.has(type);
}

/**
 * Whether a request comes from a bot rather than a person's browser.
 *
 * isbot matches User-Agents that announce themselves as automated:
 * search engine crawlers, link previews, monitoring tools, headless
 * browsers, and HTTP libraries such as curl. Every real browser sends a
 * User-Agent, so a request without one counts as a bot too. Bots that
 * pretend to be browsers are not caught here.
 */
export function isBot(userAgent: string | undefined): boolean {
  return userAgent === undefined || userAgent.trim() === "" || isbot(userAgent);
}

/**
 * Browser, OS, and device type from a User-Agent header.
 *
 * Browsers now freeze parts of the User-Agent to make people harder to
 * fingerprint ("User-Agent reduction"): every Mac reports macOS 10.15.7
 * and Windows 11 reports Windows NT 10.0. OS versions would be wrong, so
 * only the OS name is kept, and only the browser's major version.
 * iPads present themselves as Macs, so they count as desktop.
 */
export function parseUserAgent(userAgent: string): Client {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(userAgent); // Throws on an empty string.
  } catch {
    return {}; // An unreadable header must never cost the event.
  }
  const client: Client = {};

  const browser = parsed.browser.name?.trim();
  if (browser) client.browser = browser.slice(0, 50);

  const major = parsed.browser.version?.split(".")[0];
  if (major !== undefined && /^\d{1,6}$/.test(major)) client.browserVersion = major;

  const os = parsed.os.name?.trim();
  if (os) client.os = os.slice(0, 50);

  if (isDeviceType(parsed.platform.type)) client.deviceType = parsed.platform.type;

  return client;
}
