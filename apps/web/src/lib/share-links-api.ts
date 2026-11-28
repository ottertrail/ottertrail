import { queryOptions } from "@tanstack/react-query";

import { apiRequest, expectShape } from "./api";
import { isRecord, isText, isTextOrNull } from "./telemetry-shapes";

/*
 * Shared links (docs/web-analytics.md, "Shared links"): the project
 * settings' list of them, and what a link's page shows around the reports.
 */

/** A link as the settings list it: never its token, only the first characters. */
export interface ShareLink {
  id: string;
  name: string;
  environment: string;
  prefix: string;
  createdAt: string;
  createdBy: { id: string; name: string } | null;
  lastOpenedAt: string | null;
}

export interface ShareLinks {
  links: ShareLink[];
  maxLinks: number;
}

export const isShareLink = (value: unknown): value is ShareLink =>
  isRecord(value) &&
  isText(value.id) &&
  isText(value.name) &&
  isText(value.environment) &&
  isText(value.prefix) &&
  isText(value.createdAt) &&
  isTextOrNull(value.lastOpenedAt) &&
  (value.createdBy === null ||
    (isRecord(value.createdBy) && isText(value.createdBy.id) && isText(value.createdBy.name)));

const isShareLinks = (value: unknown): value is ShareLinks =>
  isRecord(value) &&
  Array.isArray(value.links) &&
  value.links.every(isShareLink) &&
  typeof value.maxLinks === "number";

const linksPath = (projectId: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/share-links`;

export const shareLinksQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["share-links", projectId],
    queryFn: async ({ signal }) =>
      expectShape(await apiRequest(linksPath(projectId), { signal }), isShareLinks),
  });

/** A new link, with its address: the only time the address is shown. */
export interface NewShareLink {
  link: ShareLink;
  url: string;
}

const isNewShareLink = (value: unknown): value is NewShareLink =>
  isRecord(value) && isShareLink(value.link) && isText(value.url);

export async function createShareLink(
  projectId: string,
  body: { name: string; environment: string },
): Promise<NewShareLink> {
  return expectShape(
    await apiRequest(linksPath(projectId), { method: "POST", body }),
    isNewShareLink,
  );
}

export async function revokeShareLink(projectId: string, linkId: string): Promise<void> {
  await apiRequest(`${linksPath(projectId)}/${encodeURIComponent(linkId)}`, { method: "DELETE" });
}

/** What a shared link's page shows around the reports. */
export interface SharedPage {
  project: { name: string; iconUrl: string | null };
  environment: string;
  timeZone: string;
}

const isSharedPage = (value: unknown): value is SharedPage =>
  isRecord(value) &&
  isRecord(value.project) &&
  isText(value.project.name) &&
  isTextOrNull(value.project.iconUrl) &&
  isText(value.environment) &&
  isText(value.timeZone);

export const sharedPageQuery = (token: string) =>
  queryOptions({
    queryKey: ["shared-page", token],
    queryFn: async ({ signal }) =>
      expectShape(
        await apiRequest(`/api/share/${encodeURIComponent(token)}`, { signal }),
        isSharedPage,
      ),
    staleTime: Infinity,
  });

/** A shared link's token from its page's address, `/share/<token>`; null for another address. */
export function shareTokenOf(pathname: string): string | null {
  const match = /^\/share\/([\w-]+)\/?$/u.exec(pathname);
  return match?.[1] ?? null;
}
