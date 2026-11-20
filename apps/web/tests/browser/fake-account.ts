/**
 * The signed-in user's own account in the fake API: their name, email and
 * password, and their sessions, as the account routes and Better Auth's
 * session routes answer them (apps/api/src/account/routes.ts).
 */
export interface FakeSession {
  id: string;
  token: string;
  userAgent: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FakeAccount {
  name: string;
  email: string;
  password: string;
  /** Every session of the user; `currentSessionId` is this browser's. */
  sessions: FakeSession[];
  currentSessionId: string;
  /** Other users' emails, which an email change cannot take. */
  takenEmails: string[];
  /** Password tries left before the API answers 429. */
  triesLeft: number;
  /** Whether listing the sessions fails (a 500). */
  listFails: boolean;
}

export const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
export const FIREFOX_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0";
export const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";

export const FAKE_PASSWORD = "correct horse battery";

export function fakeAccount(): FakeAccount {
  return {
    name: "Test Owner",
    email: "owner@example.com",
    password: FAKE_PASSWORD,
    sessions: [
      {
        id: "session-1",
        token: "token-1",
        userAgent: CHROME_MAC,
        createdAt: "2026-11-16T00:00:00.000Z",
        updatedAt: "2026-11-16T00:00:00.000Z",
      },
      {
        id: "session-2",
        token: "token-2",
        userAgent: FIREFOX_WINDOWS,
        createdAt: "2026-11-10T08:30:00.000Z",
        updatedAt: "2026-11-15T12:00:00.000Z",
      },
      {
        id: "session-3",
        token: "token-3",
        userAgent: SAFARI_IPHONE,
        createdAt: "2026-11-02T19:45:00.000Z",
        updatedAt: "2026-11-12T07:00:00.000Z",
      },
    ],
    currentSessionId: "session-1",
    takenEmails: ["admin@example.com"],
    triesLeft: 5,
    listFails: false,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const problem = (error: string, message: string, status: number) =>
  json({ error, message }, status);

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  const parsed: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? Object.fromEntries(Object.entries(parsed))
    : {};
}

const WRONG_PASSWORD = () =>
  problem("wrong_password", "The current password is incorrect. Enter it again.", 403);
const RATE_LIMITED = () =>
  problem("rate_limited", "Too many attempts. Retry after 60 seconds.", 429);

/** What GET /api/auth/get-session answers for this account. */
export function sessionBody(account: FakeAccount) {
  const current = account.sessions.find((session) => session.id === account.currentSessionId);
  return {
    session: {
      id: account.currentSessionId,
      userId: "user-1",
      expiresAt: "2026-12-16T00:00:00.000Z",
      createdAt: current?.createdAt ?? "2026-11-16T00:00:00.000Z",
      updatedAt: current?.updatedAt ?? "2026-11-16T00:00:00.000Z",
      token: current?.token ?? "fake",
      ipAddress: null,
      userAgent: current?.userAgent ?? null,
    },
    user: {
      id: "user-1",
      name: account.name,
      email: account.email,
      emailVerified: false,
      image: null,
      createdAt: "2026-11-16T00:00:00.000Z",
      updatedAt: "2026-11-16T00:00:00.000Z",
    },
  };
}

/** Answers the account's routes; null for any other path. Signed in only (checked before). */
export function answerAccount(
  account: FakeAccount,
  url: URL,
  init: RequestInit | undefined,
): Response | null {
  const path = url.pathname;
  const user = () => ({ id: "user-1", name: account.name, email: account.email });
  if (path === "/api/account" && init?.method === "PATCH") {
    const { name } = bodyOf(init);
    if (typeof name !== "string" || name.trim() === "") {
      return problem("Bad Request", "body/name must match pattern", 400);
    }
    account.name = name.trim();
    return json({ user: user() });
  }
  if (path === "/api/account/email") {
    const { email, password } = bodyOf(init);
    const address = typeof email === "string" ? email.trim().toLowerCase() : "";
    if (!/^[^\s@!]+@[^\s@]+\.[a-z]{2,}$/.test(address)) {
      return problem(
        "invalid_email",
        "Sign-in does not accept this email address. Use letters, digits, and . _ ' + - before the @. Use a domain such as example.com.",
        400,
      );
    }
    if (account.triesLeft <= 0) return RATE_LIMITED();
    account.triesLeft -= 1;
    if (password !== account.password) return WRONG_PASSWORD();
    if (account.takenEmails.includes(address)) {
      return problem(
        "email_in_use",
        "Another account already uses this email address. Enter a different one.",
        409,
      );
    }
    account.email = address;
    return json({ user: user() });
  }
  if (path === "/api/account/password") {
    const body = bodyOf(init);
    if (body.password !== body.confirmPassword) {
      return problem(
        "passwords_differ",
        "The passwords do not match. Enter the same password in both fields.",
        400,
      );
    }
    if (account.triesLeft <= 0) return RATE_LIMITED();
    account.triesLeft -= 1;
    if (body.currentPassword !== account.password) return WRONG_PASSWORD();
    account.password = typeof body.password === "string" ? body.password : "";
    if (body.revokeOtherSessions === true) {
      // As Better Auth: every session goes, and this browser gets a new one.
      const renewed: FakeSession = {
        id: "session-renewed",
        token: "token-renewed",
        userAgent: CHROME_MAC,
        createdAt: "2026-11-17T09:00:00.000Z",
        updatedAt: "2026-11-17T09:00:00.000Z",
      };
      account.sessions = [renewed];
      account.currentSessionId = renewed.id;
    }
    return new Response(null, { status: 204 });
  }
  if (path === "/api/auth/list-sessions") {
    return account.listFails
      ? json({ message: "Internal Server Error" }, 500)
      : json(account.sessions);
  }
  if (path === "/api/auth/revoke-session") {
    const { token } = bodyOf(init);
    account.sessions = account.sessions.filter((session) => session.token !== token);
    return json({ status: true });
  }
  if (path === "/api/auth/revoke-other-sessions") {
    account.sessions = account.sessions.filter(
      (session) => session.id === account.currentSessionId,
    );
    return json({ status: true });
  }
  return null;
}
