import { queryOptions } from "@tanstack/react-query";

import { apiRequest, expectShape } from "./api";

export interface AccountUser {
  id: string;
  name: string;
  email: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isUserBody = (value: unknown): value is { user: AccountUser } =>
  isRecord(value) &&
  isRecord(value.user) &&
  typeof value.user.id === "string" &&
  typeof value.user.name === "string" &&
  typeof value.user.email === "string";

/** The API's limit on a name, as setup's. */
export const MAX_NAME_LENGTH = 200;

/** PATCH /api/account: one's own name. */
export async function updateName(name: string): Promise<AccountUser> {
  const body = await apiRequest("/api/account", { method: "PATCH", body: { name } });
  return expectShape(body, isUserBody).user;
}

/** POST /api/account/email: one's own email, at once, with the current password. */
export async function changeEmail(email: string, password: string): Promise<AccountUser> {
  const body = await apiRequest("/api/account/email", {
    method: "POST",
    body: { email, password },
  });
  return expectShape(body, isUserBody).user;
}

/** POST /api/account/password: Better Auth's change of password, behind the API's limits. */
export async function changePassword(input: {
  currentPassword: string;
  password: string;
  confirmPassword: string;
  revokeOtherSessions: boolean;
}): Promise<void> {
  await apiRequest("/api/account/password", { method: "POST", body: input });
}

/** One of the user's sessions, as GET /api/account/sessions answers it: no token. */
export interface AccountSession {
  id: string;
  userAgent: string | null;
  createdAt: Date;
  /** When the session's row was last renewed: at most once a day. */
  updatedAt: Date;
  current: boolean;
}

const isDateText = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));

function toSession(value: unknown): AccountSession | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !isDateText(value.createdAt) ||
    !isDateText(value.lastActiveAt) ||
    typeof value.current !== "boolean"
  ) {
    return null;
  }
  return {
    id: value.id,
    userAgent:
      typeof value.userAgent === "string" && value.userAgent !== "" ? value.userAgent : null,
    createdAt: new Date(value.createdAt),
    updatedAt: new Date(value.lastActiveAt),
    current: value.current,
  };
}

const isSessionsBody = (value: unknown): value is { sessions: unknown[] } =>
  isRecord(value) && Array.isArray(value.sessions);

/**
 * Every session of the signed-in user, most recently active first, and
 * which one is this browser's (`currentId`).
 */
export const accountSessionsQuery = () =>
  queryOptions({
    queryKey: ["account", "sessions"],
    queryFn: async ({ signal }) => {
      const body = expectShape(
        await apiRequest("/api/account/sessions", { signal }),
        isSessionsBody,
      );
      const sessions = body.sessions
        .map(toSession)
        .filter((session) => session !== null)
        .toSorted((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      return { sessions, currentId: sessions.find((session) => session.current)?.id ?? null };
    },
  });

export async function revokeSession(id: string): Promise<void> {
  await apiRequest(`/api/account/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function revokeOtherSessions(): Promise<void> {
  await apiRequest("/api/account/sessions", { method: "DELETE" });
}

/** A browser and its system, as a User-Agent names them; null for each part not recognized. */
export interface Device {
  browser: string | null;
  os: string | null;
}

const BROWSERS: readonly [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\/(\d+)/, "Edge"],
  [/\bOPR\/(\d+)/, "Opera"],
  [/\bSamsungBrowser\/(\d+)/, "Samsung Internet"],
  [/\b(?:Firefox|FxiOS)\/(\d+)/, "Firefox"],
  [/\b(?:CriOS|Chrome)\/(\d+)/, "Chrome"],
  [/\bVersion\/(\d+)(?:\.\d+)* (?:Mobile\/\S+ )?Safari\//, "Safari"],
];

const SYSTEMS: readonly [RegExp, string][] = [
  [/\biPad\b/, "iPadOS"],
  [/\b(?:iPhone|iPod)\b/, "iOS"],
  [/\bAndroid\b/, "Android"],
  [/\bWindows\b/, "Windows"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bLinux\b/, "Linux"],
];

/** Common User-Agent patterns only. Browsers trim or freeze system versions, so omit them. */
export function parseUserAgent(userAgent: string | null): Device {
  if (userAgent === null) return { browser: null, os: null };
  let browser: string | null = null;
  for (const [pattern, name] of BROWSERS) {
    const match = pattern.exec(userAgent);
    if (match !== null) {
      browser = `${name} ${match[1] ?? ""}`.trim();
      break;
    }
  }
  const os = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null;
  return { browser, os };
}

/** "Firefox 140 on macOS", from a session's User-Agent. */
export function deviceName(userAgent: string | null): string {
  const { browser, os } = parseUserAgent(userAgent);
  if (browser === null) return os === null ? "Unknown browser" : `A browser on ${os}`;
  return os === null ? browser : `${browser} on ${os}`;
}
