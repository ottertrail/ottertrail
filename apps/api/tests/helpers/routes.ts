import { tmpdir } from "node:os";

import type { RouteOptions } from "fastify";

import { type AccessDeclaration, declarationOf } from "../../src/access/access.ts";
import { buildApp } from "../../src/app.ts";
import { createAuth } from "../../src/auth/auth.ts";
import { createClickHouse } from "../../src/clickhouse/clickhouse.ts";
import { createDatabase } from "../../src/db/database.ts";
import { routeKey } from "./project-routes.ts";

/** A declaration as text: "errors:manage", "permission:channels", "project" … */
export function describeDeclaration(declaration: AccessDeclaration): string {
  if (declaration.scope === "instance") {
    return declaration.need === "signed_in" ? "signed_in" : `permission:${declaration.need}`;
  }
  const { need } = declaration;
  if (need === "project") return "project";
  if ("permission" in need) return `project:permission:${need.permission}`;
  return `${need.area}:${need.level}`;
}

function declarationsOf(route: RouteOptions): AccessDeclaration[] {
  const handlers = [route.preHandler ?? []].flat();
  return handlers.flatMap((handler) => {
    const declaration = declarationOf(handler);
    return declaration === undefined ? [] : [declaration];
  });
}

/** Every route the API registers, with every dashboard feature on, and what each declares. */
export async function registeredRoutes(): Promise<Map<string, AccessDeclaration[]>> {
  // Nothing connects: building the app and listing its routes needs no database.
  const db = createDatabase({ connectionString: "postgres://nobody@127.0.0.1:1/none" });
  const auth = createAuth({
    db,
    publicUrl: "http://localhost:5173",
    trustedOrigins: ["http://localhost:5173"],
    secret: "a-secret-only-these-tests-use-0123456789",
  });
  const clickhouse = createClickHouse({
    url: "http://127.0.0.1:1",
    username: "nobody",
    password: "none",
    database: "none",
  });
  const app = buildApp({
    db,
    dashboard: {
      auth,
      clickhouse,
      publicUrl: "http://localhost:5173",
      trustedOrigins: ["http://localhost:5173"],
    },
    trackerScriptPath: "tracker.js",
    dashboardPath: tmpdir(),
    replayPlayerPath: "player.js",
  });
  const routes = new Map<string, AccessDeclaration[]>();
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) {
      // HEAD comes with each GET, with the GET's handlers.
      if (method !== "HEAD") routes.set(routeKey(method, route.url), declarationsOf(route));
    }
  });
  try {
    await app.ready();
  } finally {
    await app.close();
    await db.destroy();
    await clickhouse.close();
  }
  return routes;
}
