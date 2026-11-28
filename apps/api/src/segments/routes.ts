import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";

import { type ProjectAccess, requireProjectAccess } from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireTrustedOrigin } from "../auth/origin.ts";
import { requireSession } from "../auth/routes.ts";
import type { Database } from "../db/schema.ts";
import {
  filterQueryOf,
  MAX_FILTER_LENGTH,
  MAX_FILTER_QUERY_LENGTH,
  MAX_FILTER_VALUES,
} from "../reports/routes.ts";
import {
  createSegment,
  deleteSegment,
  listSegments,
  MAX_PERSONAL_SEGMENTS,
  MAX_PROJECT_SEGMENTS,
  type SegmentDefinition,
  type SegmentScope,
  updateSegment,
  type Visibility,
} from "./segments.ts";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

// eslint-disable-next-line no-control-regex -- control characters are what it refuses
const SEGMENT_NAME = /^[^\u0000-\u001F\u007F]{1,100}$/u;

const problem = (error: string, message: string) => ({ error, message });

const NAME_TAKEN = {
  project: problem("segment_name_taken", "The project already has a segment with this name."),
  personal: problem("segment_name_taken", "You already have a segment with this name."),
};
const NOT_FOUND = problem("segment_not_found", "There is no such segment of yours to change.");
const INVALID_FILTERS = problem(
  "invalid_filters",
  `filters is an object of 1 or more filters, as the analytics page's query has them, such as {"country.not":["DE"],"page.contains":["/blog"]}: each a filter and operator the page takes, with 1 to ${MAX_FILTER_VALUES} values within its limits, and at most ${MAX_FILTER_QUERY_LENGTH} characters as query text.`,
);
const TOO_MANY = {
  project: problem(
    "too_many_segments",
    `A project has at most ${MAX_PROJECT_SEGMENTS} project segments.`,
  ),
  personal: problem(
    "too_many_segments",
    `You have at most ${MAX_PERSONAL_SEGMENTS} personal segments in a project.`,
  ),
};

function scopeOf(
  request: FastifyRequest & { projectAccess: ProjectAccess | null },
  visibility: Visibility,
): SegmentScope {
  const access = request.projectAccess;
  if (access === null) {
    throw new Error("requireProjectAccess must run before this route");
  }
  return { projectId: access.projectId, visibility, userId: access.user.userId };
}

interface SegmentBody {
  name: string;
  filters: Record<string, unknown>;
}

const SEGMENT_BODY = {
  type: "object",
  required: ["name", "filters"] as string[],
  additionalProperties: false,
  properties: {
    name: { type: "string", maxLength: 200 },
    // Checked in full by filterQueryOf; the schema only bounds its size first.
    filters: { type: "object", maxProperties: 100 },
  },
};

/** Return null after sending a validation refusal. */
function definitionOf(body: SegmentBody, reply: FastifyReply): SegmentDefinition | null {
  const name = body.name.trim();
  if (!SEGMENT_NAME.test(name)) {
    void reply
      .code(400)
      .send(
        problem(
          "invalid_name",
          "A segment's name has 1 to 100 characters, and no control characters.",
        ),
      );
    return null;
  }
  const filters = filterQueryOf(body.filters);
  if (filters === null) {
    void reply.code(400).send(INVALID_FILTERS);
    return null;
  }
  return { name, filters };
}

/** Bounds a body before parsing: the largest filters it takes, as JSON, with room for the name. */
const BODY_LIMIT = MAX_FILTER_QUERY_LENGTH * 3 + MAX_FILTER_LENGTH;

/**
 * Saved segments (docs/web-analytics.md, "Segments"). Anyone who reads
 * the project's Web analytics lists the project's segments and their own,
 * and keeps personal ones; project segments are changed by those who may
 * change what the project shows everyone: the `projects` permission, as
 * for heatmaps' saved views, since Web analytics has no manage level.
 * Changes require the dashboard origin, and updates the previously read
 * updatedAt to prevent lost edits.
 */
export const segmentRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  auth: Auth;
  trustedOrigins: readonly string[];
}> = (app, { db, auth, trustedOrigins }, done) => {
  const signedIn = requireSession(auth);
  const canView = requireProjectAccess(db, { area: "web_analytics", level: "view" });
  const canManageProject = requireProjectAccess(db, { permission: "projects" });
  const fromDashboard = requireTrustedOrigin(trustedOrigins);
  const params = {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", pattern: UUID_PATTERN } },
  };
  const segmentParams = {
    type: "object",
    required: ["id", "segmentId"],
    properties: {
      id: { type: "string", pattern: UUID_PATTERN },
      segmentId: { type: "string", pattern: UUID_PATTERN },
    },
  };

  app.get<{ Params: { id: string } }>(
    "/projects/:id/segments",
    { preHandler: [signedIn, canView], schema: { params } },
    async (request) => {
      const scope = scopeOf(request, "personal");
      return { segments: await listSegments(db, scope.projectId, scope.userId) };
    },
  );

  for (const visibility of ["personal", "project"] as const) {
    const canChange = visibility === "personal" ? canView : canManageProject;

    app.post<{ Params: { id: string }; Body: SegmentBody }>(
      `/projects/:id/segments/${visibility}`,
      {
        bodyLimit: BODY_LIMIT,
        preHandler: [fromDashboard, signedIn, canChange],
        schema: { params, body: SEGMENT_BODY },
      },
      async (request, reply) => {
        const definition = definitionOf(request.body, reply);
        if (definition === null) return reply;
        const created = await createSegment(db, scopeOf(request, visibility), definition);
        if ("refused" in created) {
          return reply
            .code(409)
            .send(created.refused === "too_many" ? TOO_MANY[visibility] : NAME_TAKEN[visibility]);
        }
        return reply.code(201).send({ segment: created.segment });
      },
    );

    app.put<{
      Params: { id: string; segmentId: string };
      Body: SegmentBody & { updatedAt: string };
    }>(
      `/projects/:id/segments/${visibility}/:segmentId`,
      {
        bodyLimit: BODY_LIMIT,
        preHandler: [fromDashboard, signedIn, canChange],
        schema: {
          params: segmentParams,
          body: {
            ...SEGMENT_BODY,
            required: [...SEGMENT_BODY.required, "updatedAt"],
            properties: {
              ...SEGMENT_BODY.properties,
              updatedAt: { type: "string", maxLength: 40 },
            },
          },
        },
      },
      async (request, reply) => {
        const read = new Date(request.body.updatedAt);
        if (Number.isNaN(read.getTime())) {
          return reply
            .code(400)
            .send(
              problem(
                "invalid_updated_at",
                "updatedAt is the segment's updatedAt as read, such as 2026-11-28T12:00:00.000Z.",
              ),
            );
        }
        const definition = definitionOf(request.body, reply);
        if (definition === null) return reply;
        const updated = await updateSegment(
          db,
          scopeOf(request, visibility),
          request.params.segmentId,
          read,
          definition,
        );
        if (updated === null) return reply.code(404).send(NOT_FOUND);
        if ("refused" in updated) {
          return reply
            .code(409)
            .send(
              updated.refused === "name_taken"
                ? NAME_TAKEN[visibility]
                : problem(
                    "segment_changed",
                    "The segment changed after it was read, such as in another tab. Read it again before changing it.",
                  ),
            );
        }
        return { segment: updated.segment };
      },
    );

    app.delete<{ Params: { id: string; segmentId: string } }>(
      `/projects/:id/segments/${visibility}/:segmentId`,
      { preHandler: [fromDashboard, signedIn, canChange], schema: { params: segmentParams } },
      async (request, reply) => {
        const deleted = await deleteSegment(
          db,
          scopeOf(request, visibility),
          request.params.segmentId,
        );
        return deleted ? reply.code(204).send() : reply.code(404).send(NOT_FOUND);
      },
    );
  }

  done();
};
