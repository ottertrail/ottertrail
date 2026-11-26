import packageJson from "../package.json" with { type: "json" };

/** Webhooks include this version in their User-Agent; the owner sees it in Settings. */
export const OTTERTRAIL_VERSION: string = packageJson.version;

// `vp pack` (vite.config.ts) defines this as true; run from source, it stays undefined.
declare const __OTTERTRAIL_BUNDLE__: boolean | undefined;
const BUNDLED = typeof __OTTERTRAIL_BUNDLE__ !== "undefined" && __OTTERTRAIL_BUNDLE__;

const RELEASE = /^\d+\.\d+\.\d+$/;

/**
 * The notes of the release this build is, or null for a development build: a
 * version that is not a plain x.y.z, or the API run from source, whose version
 * is the last release's while its code may have moved on.
 */
export function releaseNotesUrl(version: string, bundled: boolean): string | null {
  if (!bundled || !RELEASE.test(version)) return null;
  return `https://github.com/ottertrail/ottertrail/releases/tag/v${version}`;
}

export const OTTERTRAIL_RELEASE_NOTES_URL = releaseNotesUrl(OTTERTRAIL_VERSION, BUNDLED);
