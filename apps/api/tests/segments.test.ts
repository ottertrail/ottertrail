import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { MAX_FILTER_QUERY_LENGTH } from "../src/reports/routes.ts";
import { MAX_PERSONAL_SEGMENTS, MAX_PROJECT_SEGMENTS } from "../src/segments/segments.ts";
import { PUBLIC_URL, signedInDashboard, signedInUser } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;

/** A new project, so each test has its own segments. */
const newProject = async (name: string) => (await insertProject(dashboard.db, { name })).id;

function call(
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  payload?: object,
  { cookie = dashboard.cookie, origin = PUBLIC_URL }: { cookie?: string; origin?: string } = {},
) {
  return dashboard.app.inject({
    method,
    url: `/api/projects/${url}`,
    headers: { cookie, origin },
    ...(payload === undefined ? {} : { payload }),
  });
}

const GERMANY = { country: ["DE"], "page.contains": ["/blog"] };
const segment = (name: string, filters: object = GERMANY) => ({ name, filters });

/** A request's options as another user. */
const as = (cookie: string) => ({ cookie });

const names = (body: { segments: { name: string }[] }) => body.segments.map((item) => item.name);

/** Inserts many segments at once, past the routes, to reach a limit quickly. */
async function fill(projectId: string, count: number, ownerId: string | null) {
  await dashboard.db
    .insertInto("segments")
    .values(
      Array.from({ length: count }, (_, index) => ({
        project_id: projectId,
        name: `Filled ${index}`,
        filters: JSON.stringify({ country: ["DE"] }),
        visibility: ownerId === null ? ("project" as const) : ("personal" as const),
        owner_id: ownerId,
        created_by: ownerId,
      })),
    )
    .execute();
}

beforeAll(async () => {
  dashboard = await signedInDashboard();
});

afterAll(async () => {
  await dashboard?.close();
});

describe("saved segments", () => {
  test("are saved with their filters, listed by name, renamed, updated, and deleted", async () => {
    const project = await newProject("Listed");
    const saved = await call(
      "POST",
      `${project}/segments/project`,
      segment("  German blog readers ", {
        "page.contains": ["/blog", "/blog"],
        country: ["DE", "AT"],
        "city.not": [""],
      }),
    );
    expect(saved.statusCode).toBe(201);
    const { segment: body } = saved.json();
    expect(body).toMatchObject({
      name: "German blog readers",
      visibility: "project",
      // A value sent twice counts once; the empty value is the unknown one.
      filters: { country: ["DE", "AT"], "page.contains": ["/blog"], "city.not": [""] },
    });
    await call("POST", `${project}/segments/personal`, segment("mine"));
    await call("POST", `${project}/segments/project`, segment("Zebra"));
    expect(names((await call("GET", `${project}/segments`)).json())).toEqual([
      "German blog readers",
      "mine",
      "Zebra",
    ]);

    const renamed = await call("PUT", `${project}/segments/project/${body.id}`, {
      name: "Blog in DACH",
      filters: { country: ["DE", "AT", "CH"] },
      updatedAt: body.updatedAt,
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().segment).toMatchObject({
      name: "Blog in DACH",
      filters: { country: ["DE", "AT", "CH"] },
    });
    // The version read before the change is refused.
    const stale = await call("PUT", `${project}/segments/project/${body.id}`, {
      ...segment("Stale"),
      updatedAt: body.updatedAt,
    });
    expect([stale.statusCode, stale.json().error]).toEqual([409, "segment_changed"]);
    // The other visibility's route does not reach it.
    expect((await call("DELETE", `${project}/segments/personal/${body.id}`)).statusCode).toBe(404);
    expect((await call("DELETE", `${project}/segments/project/${body.id}`)).statusCode).toBe(204);
    expect((await call("DELETE", `${project}/segments/project/${body.id}`)).statusCode).toBe(404);
    expect(names((await call("GET", `${project}/segments`)).json())).toEqual(["mine", "Zebra"]);
  });

  test("refuse filters the analytics page's address would refuse, and a bad name", async () => {
    const project = await newProject("Refused");
    for (const [payload, error] of [
      [segment(""), "invalid_name"],
      [segment("Tab\there"), "invalid_name"],
      [segment("x".repeat(101)), "invalid_name"],
      [segment("No filters", {}), "invalid_filters"],
      [segment("Unknown filter", { planet: ["Mars"] }), "invalid_filters"],
      [segment("Contains a fixed value", { "country.contains": ["D"] }), "invalid_filters"],
      [segment("Not a list", { country: "DE" }), "invalid_filters"],
      [segment("Empty list", { country: [] }), "invalid_filters"],
      [segment("A number", { country: [49] }), "invalid_filters"],
      [
        segment("Eleven values", { country: Array.from({ length: 11 }, (_, i) => `C${i}`) }),
        "invalid_filters",
      ],
      [segment("Empty contains", { "page.contains": [""] }), "invalid_filters"],
      [segment("Long contains", { "page.contains": ["x".repeat(201)] }), "invalid_filters"],
      [segment("Long value", { page: ["/".repeat(2049)] }), "invalid_filters"],
      [segment("NUL", { page: ["/a\u0000b"] }), "invalid_filters"],
      [
        segment("Over the query's length", {
          page: Array.from({ length: 10 }, (_, i) => `/${i}`.padEnd(2000, "x")),
        }),
        "invalid_filters",
      ],
    ] as const) {
      const response = await call("POST", `${project}/segments/personal`, payload);
      expect({
        name: payload.name,
        status: response.statusCode,
        error: response.json().error,
      }).toEqual({ name: payload.name, status: 400, error });
    }
    // At the limits: 10 values, 200 characters of contains, 2,048 of is.
    const atLimits = {
      country: Array.from({ length: 10 }, (_, i) => `C${i}`),
      "page.contains": ["x".repeat(200)],
      page: ["/".repeat(2048)],
    };
    expect(
      new URLSearchParams(
        Object.entries(atLimits).flatMap(([k, v]) => v.map((x) => [k, x])),
      ).toString().length,
    ).toBeLessThan(MAX_FILTER_QUERY_LENGTH);
    expect(
      (await call("POST", `${project}/segments/personal`, segment("At limits", atLimits)))
        .statusCode,
    ).toBe(201);
    // 100 emoji: 200 UTF-16 units, but 100 characters.
    expect(
      (await call("POST", `${project}/segments/personal`, segment("🎉".repeat(100)))).statusCode,
    ).toBe(201);
    // Changes come from the dashboard only.
    const elsewhere = await call("POST", `${project}/segments/personal`, segment("Evil"), {
      origin: "https://evil.example",
    });
    expect(elsewhere.statusCode).toBe(403);
  });

  test("names are unique, ignoring case, among a project's segments and among one person's", async () => {
    const project = await newProject("Names");
    expect((await call("POST", `${project}/segments/project`, segment("Blog"))).statusCode).toBe(
      201,
    );
    const taken = await call("POST", `${project}/segments/project`, segment("BLOG"));
    expect([taken.statusCode, taken.json().error]).toEqual([409, "segment_name_taken"]);
    // A personal segment may share a project segment's name.
    expect((await call("POST", `${project}/segments/personal`, segment("blog"))).statusCode).toBe(
      201,
    );
    expect((await call("POST", `${project}/segments/personal`, segment("Blog"))).statusCode).toBe(
      409,
    );
    const other = await signedInUser(dashboard, {
      name: "Other admin",
      email: "names-admin@example.com",
      role: "admin",
    });
    expect(
      (
        await call("POST", `${project}/segments/personal`, segment("Blog"), {
          cookie: other.cookie,
        })
      ).statusCode,
    ).toBe(201);
  });

  test("a project and a person have at most their limits", async () => {
    const project = await newProject("Limits");
    await fill(project, MAX_PROJECT_SEGMENTS, null);
    const tooMany = await call("POST", `${project}/segments/project`, segment("One more"));
    expect([tooMany.statusCode, tooMany.json().error]).toEqual([409, "too_many_segments"]);
    // Personal segments count apart, per person.
    expect((await call("POST", `${project}/segments/personal`, segment("Mine"))).statusCode).toBe(
      201,
    );
    const person = await signedInUser(dashboard, {
      name: "Limited",
      email: "limited@example.com",
      grants: { projects: [project], areas: { web_analytics: "view" } },
    });
    await fill(project, MAX_PERSONAL_SEGMENTS, person.userId);
    const theirs = await call("POST", `${project}/segments/personal`, segment("One more"), {
      cookie: person.cookie,
    });
    expect([theirs.statusCode, theirs.json().error]).toEqual([409, "too_many_segments"]);
    expect(
      (await call("POST", `${project}/segments/personal`, segment("Mine too"))).statusCode,
    ).toBe(201);
  });

  test("a stored filter the page no longer takes is listed as invalid, never as other filters", async () => {
    const project = await newProject("Invalid");
    const valid = (await call("POST", `${project}/segments/project`, segment("Valid"))).json()
      .segment;
    await dashboard.db
      .insertInto("segments")
      .values(
        [
          { planet: ["Mars"] },
          { country: ["DE"], "country.contains": ["D"] },
          { country: Array.from({ length: 11 }, (_, i) => `C${i}`) },
          { country: "DE" },
          {},
        ].map((filters, index) => ({
          project_id: project,
          name: `Old ${index}`,
          filters: JSON.stringify(filters),
          visibility: "project" as const,
          owner_id: null,
          created_by: null,
        })),
      )
      .execute();
    const { segments } = (await call("GET", `${project}/segments`)).json();
    expect(
      segments.map((item: { name: string; filters: unknown }) => [item.name, item.filters]),
    ).toEqual([
      ["Old 0", null],
      ["Old 1", null],
      ["Old 2", null],
      ["Old 3", null],
      ["Old 4", null],
      ["Valid", valid.filters],
    ]);
    // Saving valid filters over one makes it usable again.
    const fixed = await call("PUT", `${project}/segments/project/${segments[0].id}`, {
      ...segment("Old 0", { country: ["FR"] }),
      updatedAt: segments[0].updatedAt,
    });
    expect(fixed.json().segment.filters).toEqual({ country: ["FR"] });
  });

  test("a personal segment is only its owner's, and project segments need the projects permission", async () => {
    const project = await newProject("People");
    const viewer = await signedInUser(dashboard, {
      name: "Viewer",
      email: "viewer@example.com",
      grants: { projects: [project], areas: { web_analytics: "view" } },
    });
    const outsider = await signedInUser(dashboard, {
      name: "Outsider",
      email: "outsider@example.com",
      grants: { projects: [project], areas: { product_analytics: "manage" } },
    });
    const ownerPersonal = (
      await call("POST", `${project}/segments/personal`, segment("Owner's"))
    ).json().segment;
    const shared = (await call("POST", `${project}/segments/project`, segment("Team's"))).json()
      .segment;
    const viewerPersonal = await call(
      "POST",
      `${project}/segments/personal`,
      segment("Viewer's"),
      as(viewer.cookie),
    );
    expect(viewerPersonal.statusCode).toBe(201);
    const theirs = viewerPersonal.json().segment;

    // Each sees the project's segments and their own only.
    expect(
      names((await call("GET", `${project}/segments`, undefined, as(viewer.cookie))).json()),
    ).toEqual(["Team's", "Viewer's"]);
    expect(names((await call("GET", `${project}/segments`)).json())).toEqual(["Owner's", "Team's"]);

    // A member with Web analytics at view cannot change project segments.
    for (const [method, url, payload] of [
      ["POST", `${project}/segments/project`, segment("Viewer's team")],
      [
        "PUT",
        `${project}/segments/project/${shared.id}`,
        { ...segment("Renamed"), updatedAt: shared.updatedAt },
      ],
      ["DELETE", `${project}/segments/project/${shared.id}`, undefined],
    ] as const) {
      expect((await call(method, url, payload, as(viewer.cookie))).statusCode).toBe(403);
    }
    // Nor anyone's personal segment but their own: the same 404 as an unknown one.
    expect(
      (
        await call(
          "PUT",
          `${project}/segments/personal/${ownerPersonal.id}`,
          { ...segment("Taken over"), updatedAt: ownerPersonal.updatedAt },
          as(viewer.cookie),
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await call(
          "DELETE",
          `${project}/segments/personal/${ownerPersonal.id}`,
          undefined,
          as(viewer.cookie),
        )
      ).statusCode,
    ).toBe(404);
    expect((await call("DELETE", `${project}/segments/personal/${theirs.id}`)).statusCode).toBe(
      404,
    );
    expect(
      (
        await call(
          "PUT",
          `${project}/segments/personal/${theirs.id}`,
          { ...segment("Viewer's, updated", { country: ["FR"] }), updatedAt: theirs.updatedAt },
          as(viewer.cookie),
        )
      ).json().segment,
    ).toMatchObject({ name: "Viewer's, updated", filters: { country: ["FR"] } });

    // Without Web analytics, no segment at all.
    for (const [method, url, payload] of [
      ["GET", `${project}/segments`, undefined],
      ["POST", `${project}/segments/personal`, segment("Outsider's")],
    ] as const) {
      expect((await call(method, url, payload, as(outsider.cookie))).statusCode).toBe(403);
    }

    // An admin changes the project's segments.
    const admin = await signedInUser(dashboard, {
      name: "Admin",
      email: "people-admin@example.com",
      role: "admin",
    });
    expect(
      (
        await call(
          "DELETE",
          `${project}/segments/project/${shared.id}`,
          undefined,
          as(admin.cookie),
        )
      ).statusCode,
    ).toBe(204);
  });

  test("a project's segments stay in it", async () => {
    const one = await newProject("One");
    const two = await newProject("Two");
    const shared = (await call("POST", `${one}/segments/project`, segment("Shared"))).json()
      .segment;
    const mine = (await call("POST", `${one}/segments/personal`, segment("Mine"))).json().segment;
    expect((await call("GET", `${two}/segments`)).json().segments).toEqual([]);
    for (const [visibility, saved] of [
      ["project", shared],
      ["personal", mine],
    ] as const) {
      const url = `${two}/segments/${visibility}/${saved.id}`;
      expect(
        (await call("PUT", url, { ...segment("Moved"), updatedAt: saved.updatedAt })).statusCode,
      ).toBe(404);
      expect((await call("DELETE", url)).statusCode).toBe(404);
    }
    expect(names((await call("GET", `${one}/segments`)).json())).toEqual(["Mine", "Shared"]);
    // A member of the second project only does not reach the first's.
    const member = await signedInUser(dashboard, {
      name: "Second only",
      email: "second-only@example.com",
      grants: { projects: [two], areas: { web_analytics: "view" } },
    });
    expect(
      (await call("GET", `${one}/segments`, undefined, { cookie: member.cookie })).statusCode,
    ).toBe(404);
  });

  test("removing a person deletes their personal segments and keeps the project's they made", async () => {
    const project = await newProject("Removed");
    const admin = await signedInUser(dashboard, {
      name: "Leaving admin",
      email: "leaving@example.com",
      role: "admin",
    });
    await call("POST", `${project}/segments/personal`, segment("Leaving's own"), as(admin.cookie));
    await call("POST", `${project}/segments/project`, segment("Leaving's team"), as(admin.cookie));
    expect(
      (
        await dashboard.app.inject({
          method: "DELETE",
          url: `/api/members/${admin.userId}`,
          headers: { cookie: dashboard.cookie, origin: PUBLIC_URL },
        })
      ).statusCode,
    ).toBe(204);
    const rows = await dashboard.db
      .selectFrom("segments")
      .select(["name", "created_by"])
      .where("project_id", "=", project)
      .execute();
    expect(rows).toEqual([{ name: "Leaving's team", created_by: null }]);
  });

  test("deleting a project deletes its segments", async () => {
    const project = await newProject("Deleted");
    await call("POST", `${project}/segments/project`, segment("Gone"));
    await call("POST", `${project}/segments/personal`, segment("Gone too"));
    await dashboard.db.deleteFrom("projects").where("id", "=", project).execute();
    const left = await dashboard.db
      .selectFrom("segments")
      .select("id")
      .where("project_id", "=", project)
      .execute();
    expect(left).toEqual([]);
  });
});
