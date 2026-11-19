/**
 * Whether the development seed (seed.ts) may run: only against what looks
 * like the local development stack, since it deletes and makes a project.
 */
import {
  type Config,
  DEVELOPMENT_PUBLIC_URL,
  LOCAL_CLICKHOUSE,
  LOCAL_DATABASE_URL,
  LOCAL_OBJECT_STORE,
} from "../src/config.ts";

/**
 * Why the seed must not run, or null when it may. NODE_ENV=production
 * always refuses. Any setting that points away from the local development
 * stack (compose.yaml and the API's development defaults) refuses unless
 * `yes` is given, naming each.
 */
export function refusalOf(
  env: Record<string, string | undefined>,
  config: Pick<Config, "publicUrl" | "databaseUrl" | "clickhouse" | "objectStore">,
  { yes }: { yes: boolean },
): string | null {
  if (env.NODE_ENV === "production") {
    return "NODE_ENV is production. The demo data is for development only, and is never made in production.";
  }
  const unusual: string[] = [];
  if (config.publicUrl !== DEVELOPMENT_PUBLIC_URL) {
    unusual.push(
      `PUBLIC_URL is ${config.publicUrl}, not the development default ${DEVELOPMENT_PUBLIC_URL}.`,
    );
  }
  if (config.databaseUrl !== LOCAL_DATABASE_URL) {
    unusual.push("DATABASE_URL is not the local development database from compose.yaml.");
  }
  if (config.clickhouse.url !== LOCAL_CLICKHOUSE.url) {
    unusual.push("CLICKHOUSE_URL is not the local development ClickHouse from compose.yaml.");
  }
  if (config.objectStore !== null && config.objectStore.url !== LOCAL_OBJECT_STORE.url) {
    unusual.push("OBJECT_STORE_URL is not the local development Garage from compose.yaml.");
  }
  if (unusual.length === 0 || yes) return null;
  return [
    "This does not look like the local development stack:",
    ...unusual.map((line) => `  - ${line}`),
    "",
    'The seed deletes any project named "Demo shop" and makes it again. If this is a development',
    "instance, run it again with --yes: vp run seed -- --yes",
  ].join("\n");
}
