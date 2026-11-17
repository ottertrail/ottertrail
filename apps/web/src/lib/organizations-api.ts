import { queryOptions } from "@tanstack/react-query";

import { apiRequest, expectShape } from "./api";

/** An organization, as GET /api/organizations returns it to one of its members. */
export interface Organization {
  id: string;
  name: string;
  /** IANA timezone: reports count days in it. */
  timeZone: string;
  /** The signed-in user's role in it. */
  role: "owner" | "member";
  createdAt: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function isOrganization(value: unknown): value is Organization {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.timeZone === "string" &&
    (value.role === "owner" || value.role === "member") &&
    typeof value.createdAt === "string"
  );
}

const isOrganizationList = (value: unknown): value is { organizations: Organization[] } =>
  isRecord(value) &&
  Array.isArray(value.organizations) &&
  value.organizations.every(isOrganization);

const isOneOrganization = (value: unknown): value is { organization: Organization } =>
  isRecord(value) && isOrganization(value.organization);

export const organizationsQuery = () =>
  queryOptions({
    queryKey: ["organizations"],
    queryFn: async ({ signal }) =>
      expectShape(await apiRequest("/api/organizations", { signal }), isOrganizationList)
        .organizations,
  });

/** Changes an organization's name or timezone; its owner only. */
export async function updateOrganization(
  id: string,
  changes: { name?: string; timeZone?: string },
) {
  const body = await apiRequest(`/api/organizations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: changes,
  });
  return expectShape(body, isOneOrganization).organization;
}
