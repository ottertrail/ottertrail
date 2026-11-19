import { describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import { SEEK_MESSAGE, TIME_MESSAGE } from "../../src/lib/replay-messages.ts";
import type { ReplayList } from "../../src/lib/replays-api.ts";
import type { Activity, UserActivity } from "../../src/lib/users-api.ts";
import {
  ERROR_FINGERPRINTS,
  type FakeApi,
  fakeReplay,
  fakeReplayId,
  fakeReplayList,
  fakeReplayTimeline,
  fakeUser,
  installFakeApi,
  PROJECT,
} from "./fake-api.ts";
import { renderApp } from "./render.tsx";

const REPLAYS = `/projects/${PROJECT.id}/replays`;

/** The query of the latest request to `path`, such as { period: "7d" }. */
function lastQuery(api: FakeApi, path: string): Record<string, string> {
  const request = api.requests.findLast((item) => item.split("?")[0]?.endsWith(path)) ?? "";
  const at = request.indexOf("?");
  return at === -1 ? {} : Object.fromEntries(new URLSearchParams(request.slice(at + 1)));
}

const table = () => page.getByRole("table", { name: "Session replays, newest first" });
const rows = () => [...document.querySelectorAll("tbody tr")];
const cells = (row: Element | undefined) =>
  [...(row?.querySelectorAll("td") ?? [])].map((cell) => cell.textContent);

/** An empty list, as the API answers one for these days. */
const emptyList = (query: URLSearchParams): ReplayList => ({
  ...fakeReplayList(query),
  replays: [],
  errorGroups: [],
  next: null,
});

describe("the Replays page", () => {
  test("opens from the sidebar, near Errors, and lists replays newest first", async () => {
    const api = installFakeApi();
    const router = renderApp(`/projects/${PROJECT.id}/errors`);
    await page
      .getByRole("navigation", { name: "Project" })
      .getByRole("link", { name: "Replays" })
      .click();

    await expect.poll(() => router.state.location.pathname).toBe(REPLAYS);
    await expect.element(table()).toBeVisible();
    expect(lastQuery(api, "/replays/list")).toEqual({ period: "7d" });
    expect(
      [...table().element().querySelectorAll("thead th")].map((cell) => cell.textContent),
    ).toEqual(["When", "Length", "Error", "User", "Pages", "Environment", "Browser"]);
    await expect.poll(() => rows().length).toBe(50);
    expect(cells(rows()[0])).toEqual([
      "16 Nov 2026, 16:00",
      "45 s",
      "TypeError: cart is undefined",
      "ada",
      "/cart → /checkout",
      "production",
      "Firefox, Linux, desktop",
    ]);
    // Cut, anonymous; an error never found; one still looked for.
    expect(cells(rows()[1]).slice(0, 4)).toEqual([
      "16 Nov 2026, 15:00",
      "Cut12 s",
      "ReferenceError: pay is not defined",
      "Anonymous",
    ]);
    expect(cells(rows()[2])[2]).toBe("Error not found");
    expect(cells(rows()[2])[5]).toBe("—");
    expect(cells(rows()[3])[2]).toBe("Looking for its error…");

    // Each replay, its error, and its user are links.
    const first = table().getByRole("row").nth(1);
    await expect
      .element(first.getByRole("link", { name: "Replay at 16 Nov 2026, 16:00" }))
      .toHaveAttribute("href", `${REPLAYS}/${fakeReplayId(0)}`);
    await expect
      .element(first.getByRole("link", { name: "TypeError: cart is undefined" }))
      .toHaveAttribute(
        "href",
        `/projects/${PROJECT.id}/errors/${ERROR_FINGERPRINTS.typeError}?from=2026-11-16&to=2026-11-16`,
      );
    await expect
      .element(first.getByRole("link", { name: "ada" }))
      .toHaveAttribute("href", `/projects/${PROJECT.id}/users/ada`);

    // Older ones on request, from the last one's cursor.
    await page.getByRole("button", { name: "Load older replays" }).click();
    await expect.poll(() => rows().length).toBe(60);
    expect(lastQuery(api, "/replays/list")).toEqual({ period: "7d", before: fakeReplayId(49) });
    await expect
      .element(page.getByRole("button", { name: "Load older replays" }))
      .not.toBeInTheDocument();
  });

  test("filters by path, user, error, and length, kept in the address", async () => {
    const api = installFakeApi();
    const router = renderApp(REPLAYS);
    await expect.poll(() => rows().length).toBe(50);

    const path = page.getByRole("searchbox", { name: "Path contains" });
    await userEvent.type(path, "checkout{Enter}");
    await expect
      .poll(() => lastQuery(api, "/replays/list"))
      .toEqual({
        period: "7d",
        path: "checkout",
      });
    expect(router.state.location.search).toEqual({ path: "checkout" });
    await expect.poll(() => rows().length).toBe(20);

    const user = page.getByRole("searchbox", { name: "User ID" });
    await userEvent.type(user, "ada{Enter}");
    await expect
      .poll(() => lastQuery(api, "/replays/list"))
      .toEqual({ period: "7d", path: "checkout", userId: "ada" });

    await page.getByRole("combobox", { name: "Error" }).click();
    await page.getByRole("option", { name: "TypeError: cart is undefined" }).click();
    await expect
      .poll(() => lastQuery(api, "/replays/list"))
      .toEqual({
        period: "7d",
        path: "checkout",
        userId: "ada",
        fingerprint: ERROR_FINGERPRINTS.typeError,
      });

    await page.getByRole("combobox", { name: "Minimum length" }).click();
    await page.getByRole("option", { name: "1 min or longer" }).click();
    await expect
      .poll(() => lastQuery(api, "/replays/list"))
      .toEqual({
        period: "7d",
        path: "checkout",
        userId: "ada",
        fingerprint: ERROR_FINGERPRINTS.typeError,
        minDuration: "60000",
      });
    expect(router.state.location.search).toEqual({
      path: "checkout",
      user: "ada",
      error: ERROR_FINGERPRINTS.typeError,
      min: 60_000,
    });
    // None left: the empty state says to change a filter.
    await expect.element(page.getByText("No replay matches these filters")).toBeVisible();
    await expect.element(page.getByText("Change or clear a filter to see more.")).toBeVisible();

    // The period and environment, as on the other pages.
    await page.getByRole("combobox", { name: "Environment" }).click();
    await page.getByRole("option", { name: "staging" }).click();
    await expect.poll(() => lastQuery(api, "/replays/list").environment).toBe("staging");
  });

  test("reads its filters from the address, dropping what it does not offer", async () => {
    const api = installFakeApi();
    renderApp(`${REPLAYS}?path=%22cart%22&min=12345&error=%22nope%22&user=%22grace%22`);
    await expect
      .poll(() => lastQuery(api, "/replays/list"))
      .toEqual({ period: "7d", path: "cart", userId: "grace" });
    await expect.element(page.getByText("No replay matches these filters")).toBeVisible();
  });

  test("says when replays are off for the project, and where to turn them on", async () => {
    installFakeApi({ replayList: emptyList });
    renderApp(REPLAYS);
    await expect.element(page.getByText("Replays are off for this project")).toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Open the project's settings" }))
      .toHaveAttribute("href", `/projects/${PROJECT.id}/settings?tab=replay`);
  });

  test("says when the period has none, with replays on", async () => {
    installFakeApi({
      projects: [{ ...PROJECT, replayMode: "errors" }],
      replayList: emptyList,
    });
    renderApp(REPLAYS);
    await expect.element(page.getByText("No replays in this period")).toBeVisible();
    await expect.element(page.getByText(/Replays are kept 30 days/)).toBeVisible();
  });

  test("says when the install has no object store", async () => {
    installFakeApi({
      replayList: (query) => ({ ...emptyList(query), configured: false }),
    });
    renderApp(REPLAYS);
    await expect
      .element(page.getByText("Session replay is disabled on this instance"))
      .toBeVisible();
    await expect
      .element(page.getByRole("searchbox", { name: "Path contains" }))
      .not.toBeInTheDocument();
  });
});

/** The player's frame, with a fake player: a window of its own whose messages are kept. */
async function fakePlayer() {
  await expect.poll(() => document.querySelector("iframe[title^='Session replay']")).not.toBeNull();
  const frame = document.querySelector<HTMLIFrameElement>("iframe[title^='Session replay']");
  if (frame === null) throw new Error("No player frame");
  const stand = document.createElement("iframe");
  document.body.append(stand);
  const player = stand.contentWindow;
  if (player === null) throw new Error("No window for the fake player");
  const posted: { message: unknown; origin: string }[] = [];
  player.postMessage = (message: unknown, origin: unknown) => {
    posted.push({ message, origin: String(origin) });
  };
  // The page reads the frame's window when it posts, and when a message comes.
  Object.defineProperty(frame, "contentWindow", { value: player });
  /** A message from `source` on `origin`, as the browser delivers it. */
  const deliver = (data: unknown, origin = location.origin, source: Window | null = player) =>
    window.dispatchEvent(new MessageEvent("message", { data, origin, source }));
  return { frame, posted, deliver };
}

const timeline = () => page.getByRole("list", { name: "Timeline of the replay" });
const timelineTexts = () =>
  [...timeline().element().querySelectorAll("li")].map((item) => item.textContent);
const currentItem = () =>
  timeline().element().querySelector("[aria-current=true]")?.textContent ?? null;

describe("a replay's page", () => {
  test("shows what the replay shows, the player at its error, and its timeline", async () => {
    installFakeApi();
    renderApp(`${REPLAYS}/${fakeReplayId(0)}`);

    await expect
      .element(page.getByRole("heading", { name: "Replay at 16 Nov 2026, 16:00" }))
      .toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "TypeError: cart is undefined" }))
      .toBeVisible();
    await expect.element(page.getByText("/cart → /checkout")).toBeVisible();
    await expect.element(page.getByText("Firefox, Linux, desktop")).toBeVisible();
    const frame = document.querySelector("iframe");
    // The recording's own clock: its start, and the error 35 seconds in.
    expect(frame?.getAttribute("src")).toBe(
      `/api/projects/${PROJECT.id}/replays/${fakeReplayId(0)}/player?errorAt=${Date.UTC(2026, 10, 16, 8, 0) + 35_000}`,
    );
    expect(frame?.hasAttribute("sandbox")).toBe(false);
    expect(frame?.getAttribute("referrerpolicy")).toBe("no-referrer");

    await expect.element(timeline()).toBeVisible();
    // Scrolls are left out until asked for; never what was typed.
    expect(timelineTexts()).toEqual([
      "0:00On /cart",
      "0:02Clicked a button at 120, 340",
      "0:06Typed in a field",
      "0:09Changed a field",
      "0:12Went to /checkout",
      "0:15Clicked a <div> element at 10, 20",
      "0:35The error",
    ]);
    await page.getByRole("checkbox", { name: "Show scrolls (1)" }).click();
    await expect.poll(timelineTexts).toContain("0:04Scrolled to 600 px");
  });

  test("an item moves the player there, by a message to its frame only", async () => {
    installFakeApi();
    renderApp(`${REPLAYS}/${fakeReplayId(0)}`);
    await expect.element(timeline()).toBeVisible();
    const { posted } = await fakePlayer();

    await page.getByRole("button", { name: "0:12: Went to /checkout. Play from here" }).click();
    expect(posted).toEqual([
      { message: { type: SEEK_MESSAGE, offsetMs: 12_000 }, origin: location.origin },
    ]);
    await expect.poll(currentItem).toBe("0:12Went to /checkout");

    await page.getByRole("button", { name: "0:35: The error. Play from here" }).click();
    expect(posted.at(-1)?.message).toEqual({ type: SEEK_MESSAGE, offsetMs: 35_000 });
  });

  test("follows the player's time, and ignores messages from anywhere else", async () => {
    installFakeApi();
    renderApp(`${REPLAYS}/${fakeReplayId(0)}`);
    await expect.element(timeline()).toBeVisible();
    const { deliver } = await fakePlayer();

    deliver({ type: TIME_MESSAGE, offsetMs: 6_600, totalMs: 45_000 });
    await expect.poll(currentItem).toBe("0:06Typed in a field");

    // Another origin, another window, other shapes: nothing moves.
    const at15 = { type: TIME_MESSAGE, offsetMs: 15_500, totalMs: 45_000 };
    deliver(at15, "https://evil.example");
    deliver(at15, location.origin, window);
    deliver(at15, location.origin, null);
    deliver({ ...at15, offsetMs: "15500" });
    deliver({ ...at15, extra: true });
    deliver({ type: SEEK_MESSAGE, offsetMs: 15_500 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(currentItem()).toBe("0:06Typed in a field");

    deliver(at15);
    await expect.poll(currentItem).toBe("0:15Clicked a <div> element at 10, 20");
  });

  test("asks again for a moment the player may have missed while it loaded", async () => {
    installFakeApi();
    renderApp(`${REPLAYS}/${fakeReplayId(0)}`);
    await expect.element(timeline()).toBeVisible();
    const { frame, posted, deliver } = await fakePlayer();
    const seekTo12 = { message: { type: SEEK_MESSAGE, offsetMs: 12_000 }, origin: location.origin };

    await page.getByRole("button", { name: "0:12: Went to /checkout. Play from here" }).click();
    expect(posted).toEqual([seekTo12]);
    // The frame's page loads (its script now listening): the moment is sent again.
    frame.dispatchEvent(new Event("load"));
    expect(posted.at(-1)).toEqual(seekTo12);
    const sent = posted.length;
    expect(sent).toBeGreaterThanOrEqual(2);

    // The loaded player speaks: it has heard it, and a later load sends nothing.
    deliver({ type: TIME_MESSAGE, offsetMs: 12_000, totalMs: 45_000 });
    await expect.poll(currentItem).toBe("0:12Went to /checkout");
    frame.dispatchEvent(new Event("load"));
    expect(posted).toHaveLength(sent);
  });

  test("says which moments a long timeline leaves out", async () => {
    for (const [truncated, text] of [
      ["scrolls", "Some earlier scrolls are omitted. A timeline keeps 500 moments."],
      [
        "earliest",
        "All scrolls and the earliest moments are omitted. A timeline keeps the latest 500 moments.",
      ],
    ] as const) {
      installFakeApi({
        replayTimeline: (replayId) => {
          const answer = fakeReplayTimeline(replayId);
          return answer instanceof Response
            ? answer
            : { ...answer, timeline: { ...answer.timeline, truncated } };
        },
      });
      renderApp(`${REPLAYS}/${fakeReplayId(0)}`);
      await expect.element(page.getByText(text)).toBeVisible();
      document.body.replaceChildren();
    }
  });

  test("says when the replay is gone", async () => {
    installFakeApi();
    renderApp(`${REPLAYS}/bbbbbbbb-0000-4000-8000-000000000000`);
    await expect.element(page.getByText("No such replay")).toBeVisible();
    await expect.element(page.getByRole("link", { name: "All replays" })).toBeVisible();
  });
});

/** Ada's page, two of her events errors: one with its replay ready, one arriving. */
function installWithUserReplays(replays = [fakeReplay(0), fakeReplay(4)]) {
  return installFakeApi({
    user: (userId, query) => {
      const answer = fakeUser(userId, query);
      if (answer instanceof Response) return answer;
      const error = {
        type: "TypeError",
        message: "cart is undefined",
        fingerprint: ERROR_FINGERPRINTS.typeError,
      };
      const [first, second, ...rest] = answer.activity;
      if (first === undefined || second === undefined) throw new Error("Two events expected");
      const activity: Activity[] = [
        { ...first, name: "error", error, replay: { id: fakeReplayId(0), status: "ready" } },
        {
          ...second,
          name: "error",
          error,
          replay: { id: "cccccccc-0000-4000-8000-000000000001", status: "pending" },
        },
        ...rest,
      ];
      const result: UserActivity = { ...answer, activity, replays };
      return result;
    },
  });
}

describe("a user's replays", () => {
  test("an error with a replay links to it, and the page lists the user's replays", async () => {
    installWithUserReplays();
    renderApp(`/projects/${PROJECT.id}/users/ada`);

    const play = page.getByRole("link", {
      name: "Play the replay of the error at 16 Nov 2026, 16:00",
    });
    await expect.element(play).toHaveAttribute("href", `${REPLAYS}/${fakeReplayId(0)}`);
    await expect.element(page.getByText("Replay arriving…", { exact: false })).toBeVisible();

    const list = page.getByRole("list", { name: "The user's latest replays" });
    await expect.element(list).toBeVisible();
    const items = [...list.element().querySelectorAll("li")];
    expect(items.map((item) => item.textContent)).toEqual([
      "16 Nov 2026, 16:0045 sTypeError/cart → /checkout",
      "16 Nov 2026, 12:0012 sTypeError/pricing",
    ]);
    await expect
      .element(list.getByRole("link", { name: "16 Nov 2026, 12:00" }))
      .toHaveAttribute("href", `${REPLAYS}/${fakeReplayId(4)}`);

    await play.click();
    await expect
      .element(page.getByRole("heading", { name: "Replay at 16 Nov 2026, 16:00" }))
      .toBeVisible();
  });

  test("says when the user has none", async () => {
    installWithUserReplays([]);
    renderApp(`/projects/${PROJECT.id}/users/ada`);
    await expect
      .element(page.getByText(/^No session replay of this user's errors in production/))
      .toBeVisible();
  });
});
