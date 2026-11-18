import packageJson from "../package.json" with { type: "json" };

/** Ottertrail's version, as the API's package.json gives it; webhooks name it in their User-Agent. */
export const OTTERTRAIL_VERSION: string = packageJson.version;
