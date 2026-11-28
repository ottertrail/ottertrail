/**
 * Clicks on links to other sites and on files, and pages the site marks as
 * not found (docs/web-analytics.md, "Links and not found pages"). Each is
 * one of the tracker's own events, which track() refuses.
 */

export const OUTBOUND_LINK = "outbound_link";
export const FILE_DOWNLOAD = "file_download";
export const NOT_FOUND = "not_found";

/** As long as the API takes a property value. A longer link is not recorded. */
export const MAX_LINK_LENGTH = 500;

/** The file types a link's path can end in to count as a download, in any case. */
export const FILE_EXTENSIONS =
  /\.(?:7z|apk|csv|deb|dmg|docx?|epub|exe|gz|iso|mov|mp3|mp4|msi|odt|ods|pdf|pkg|pptx?|rar|rpm|tgz|wav|xlsx?|zip)$/i;

/** The parts of an <a> element a click reads: never its text. */
export interface LinkElement {
  href?: unknown;
  hasAttribute(name: string): boolean;
}

/**
 * The event a click on a link makes, with the link's origin and path
 * (no query string or fragment), or undefined for none: a link on the
 * page's own host that is no file, a link that is not http(s), or a kind
 * turned off. A file is a download wherever it is, never also an
 * outbound link.
 */
export function linkClick(
  link: LinkElement,
  pageHostname: string,
  on: { outbound: boolean; downloads: boolean },
): { name: string; url: string } | undefined {
  // An SVG link's href is an object, not text.
  if (typeof link.href !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(link.href);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  const clean = url.origin + url.pathname;
  if (clean.length > MAX_LINK_LENGTH) return undefined;
  if (link.hasAttribute("download") || FILE_EXTENSIONS.test(url.pathname)) {
    return on.downloads ? { name: FILE_DOWNLOAD, url: clean } : undefined;
  }
  return on.outbound && url.hostname !== pageHostname
    ? { name: OUTBOUND_LINK, url: clean }
    : undefined;
}
