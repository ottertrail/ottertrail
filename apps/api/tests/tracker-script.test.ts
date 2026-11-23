import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";

import { trackerScriptRoutes } from "../src/tracker-script/routes.ts";

const reads = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readFile: (async (...args: Parameters<typeof original.readFile>) => {
      reads.count += 1;
      return original.readFile(...args);
    }) as typeof original.readFile,
  };
});

let directory = "";
const app = Fastify();

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "ottertrail-script-cache-"));
  await writeFile(join(directory, "tracker.js"), "console.log('tracker');\n");
  app.register(trackerScriptRoutes, { scriptPath: join(directory, "tracker.js") });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(directory, { recursive: true, force: true });
});

describe("tracker scripts", () => {
  test("are read once, then served from memory until the file changes", async () => {
    const before = reads.count;
    for (let i = 0; i < 3; i += 1) {
      expect((await app.inject({ url: "/t.js" })).body).toBe("console.log('tracker');\n");
    }
    expect(reads.count - before).toBe(1);
    await writeFile(join(directory, "tracker.js"), "console.log('rebuilt');\n");
    expect((await app.inject({ url: "/t.js" })).body).toBe("console.log('rebuilt');\n");
    expect(reads.count - before).toBe(2);
  });
});
