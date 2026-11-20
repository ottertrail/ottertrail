import { queryOptions } from "@tanstack/react-query";

import { ApiError, apiRequest, expectShape } from "./api";
import { authClient } from "./auth-client";

/** The signed-in user's own account, as the account routes answer it. */
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

/** One of the user's sessions, as Better Auth's list-sessions answers it. */
export interface AccountSession {
  id: string;
  /** What revoking it takes; the cookie also needs the server's signature, which the page never sees. */
  token: string;
  userAgent: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const asDate = (value: unknown) =>
  value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;

function toSession(value: unknown): AccountSession | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.token !== "string") {
    return null;
  }
  const createdAt = asDate(value.createdAt);
  const updatedAt = asDate(value.updatedAt);
  if (createdAt === null || updatedAt === null) return null;
  return {
    id: value.id,
    token: value.token,
    userAgent:
      typeof value.userAgent === "string" && value.userAgent !== "" ? value.userAgent : null,
    createdAt,
    updatedAt,
  };
}

/** Better Auth's client answers { data, error }: an error becomes an ApiError, as the API's own. */
function failed(error: { status: number; message?: string | undefined }): never {
  throw new ApiError(
    error.status,
    error.status === 429
      ? "Too many requests. Wait a few seconds. Then try again."
      : (error.message ?? `The request failed (HTTP ${error.status}).`),
  );
}

/**
 * Every session of the signed-in user, most recently active first, and
 * which one is this browser's (`currentId`, null if it could not be told).
 */
export const accountSessionsQuery = () =>
  queryOptions({
    queryKey: ["account", "sessions"],
    queryFn: async () => {
      const [list, current] = await Promise.all([
        authClient.listSessions(),
        authClient.getSession(),
      ]);
      if (list.error) failed(list.error);
      if (current.error) failed(current.error);
      if (!Array.isArray(list.data)) throw new ApiError(0, "The API sent an unexpected response.");
      const sessions = list.data
        .map(toSession)
        .filter((session) => session !== null)
        .toSorted((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      return { sessions, currentId: current.data?.session.id ?? null };
    },
  });

/** Signs out one of the user's other sessions. */
export async function revokeSession(token: string): Promise<void> {
  const { error } = await authClient.revokeSession({ token });
  if (error) failed(error);
}

/** Signs out every session of the user but this one. */
export async function revokeOtherSessions(): Promise<void> {
  const { error } = await authClient.revokeOtherSessions();
  if (error) failed(error);
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
  [/\bVersion\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari\//, "Safari"],
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

/**
 * The browser (with its major version) and the system from a User-Agent:
 * a few patterns for the common browsers, not a full parser. Browsers
 * freeze or trim their User-Agent, so the system's version is left out.
 */
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
