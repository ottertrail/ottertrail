import packageJson from "../package.json" with { type: "json" };

/** Webhooks include this version in their User-Agent. */
export const OTTERTRAIL_VERSION: string = packageJson.version;
