import type { Annotation, ReleaseMark } from "../../src/lib/annotations-api.ts";

/**
 * The Web analytics chart's notes and release marks in the fake API
 * (GET, POST, PUT, DELETE /api/projects/:id/annotations and GET
 * /api/projects/:id/release-marks; the API's own tests are
 * apps/api/tests/annotations.test.ts). Changes need product analytics at
 * manage, as on the API.
 */
export interface FakeAnnotations {
  notes: Annotation[];
  releases: ReleaseMark[];
  /** Each request's method, path with its query, and body, in order. */
  requests: { method: string; path: string; body: unknown }[];
}

const AUTHOR = { id: "user-1", name: "Ada Owner" };

export function fakeNote(
  fields: Partial<Annotation> & Pick<Annotation, "day" | "text">,
): Annotation {
  return {
    id: crypto.randomUUID(),
    time: null,
    environment: null,
    author: AUTHOR,
    createdAt: "2026-11-12T03:00:00.000Z",
    updatedAt: "2026-11-12T03:00:00.000Z",
    ...fields,
  };
}

/** A note on 12 November, a release on the 13th, and both on the 15th. */
export function fakeAnnotations(): FakeAnnotations {
  return {
    notes: [
      fakeNote({ day: "2026-11-12", text: "Launched the pricing page" }),
      fakeNote({
        day: "2026-11-15",
        time: "09:30",
        text: "Newsletter sent",
        author: { id: "user-2", name: "Mark Eting" },
      }),
    ],
    releases: [
      { release: "1.4.2", firstSeen: "2026-11-13T02:00:00.000Z", local: "2026-11-13T10:00" },
      { release: "1.5.0", firstSeen: "2026-11-15T06:00:00.000Z", local: "2026-11-15T14:00" },
    ],
    requests: [],
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const FORBIDDEN = {
  error: "forbidden",
  message: "You don't have access to this. Ask the instance's owner or an admin if you need it.",
};

type Fields = Pick<Annotation, "day" | "time" | "text" | "environment">;

const isFields = (value: unknown): value is Fields =>
  typeof value === "object" &&
  value !== null &&
  "day" in value &&
  typeof value.day === "string" &&
  "text" in value &&
  typeof value.text === "string" &&
  "time" in value &&
  (value.time === null || typeof value.time === "string") &&
  "environment" in value &&
  (value.environment === null || typeof value.environment === "string");

export function answerAnnotations(
  fake: FakeAnnotations,
  url: URL,
  init: RequestInit | undefined,
  canManage: boolean,
): Response | null {
  const path = url.pathname;
  const method = init?.method ?? "GET";
  const releases = /^\/api\/projects\/[^/]+\/release-marks$/.test(path);
  const list = /^\/api\/projects\/[^/]+\/annotations$/.test(path);
  const one = /^\/api\/projects\/[^/]+\/annotations\/([^/]+)$/.exec(path);
  if (!releases && !list && one === null) return null;
  const body: unknown =
    typeof init?.body === "string" && init.body !== "" ? JSON.parse(init.body) : null;
  fake.requests.push({ method, path: `${path}${url.search}`, body });
  const query = url.searchParams;
  const from = query.get("from") ?? "";
  const to = query.get("to") ?? "9999-12-31";
  const environment = query.get("environment") ?? "production";
  if (releases) {
    return json({
      releases: fake.releases.filter(
        (mark) => mark.local.slice(0, 10) >= from && mark.local.slice(0, 10) <= to,
      ),
    });
  }
  if (list && method === "GET") {
    return json({
      annotations: fake.notes.filter(
        (note) =>
          note.day >= from &&
          note.day <= to &&
          (note.environment === null || note.environment === environment),
      ),
    });
  }
  if (!canManage) return json(FORBIDDEN, 403);
  if (method !== "DELETE" && !isFields(body)) {
    return json({ error: "invalid", message: "Not a note." }, 400);
  }
  if (list && method === "POST" && isFields(body)) {
    const note = fakeNote({ ...body, author: AUTHOR });
    fake.notes = [...fake.notes, note];
    return json({ annotation: note }, 201);
  }
  const id = decodeURIComponent(one?.[1] ?? "");
  const existing = fake.notes.find((note) => note.id === id);
  if (existing === undefined) {
    return json({ error: "annotation_not_found", message: "The project has no such note." }, 404);
  }
  if (method === "PUT" && isFields(body)) {
    const note = { ...existing, ...body, author: AUTHOR };
    fake.notes = fake.notes.map((item) => (item.id === id ? note : item));
    return json({ annotation: note });
  }
  fake.notes = fake.notes.filter((note) => note.id !== id);
  return new Response(null, { status: 204 });
}
