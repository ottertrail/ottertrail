import { describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import type { Occurrence } from "../../src/lib/errors-api.ts";
import {
  deferred,
  ERROR_FINGERPRINTS,
  fakeError,
  fakeReplays,
  installFakeApi,
  json,
  PROJECT,
} from "./fake-api.ts";
import { renderApp } from "./render.tsx";

const TYPE_ERROR = `/projects/${PROJECT.id}/errors/${ERROR_FINGERPRINTS.typeError}`;
const SETTINGS = `/projects/${PROJECT.id}/settings`;
const REPLAYS_PATH = `/api/projects/${PROJECT.id}/replays`;
const REPLAY_ID = "aaaaaaaa-0000-4000-8000-000000000001";

/** The TypeError's page, its three occurrences with a replay ready, arriving, and missing. */
function installWithReplays() {
  return installFakeApi({
    error: (fingerprint, query, api) => {
      const detail = fakeError(fingerprint, query, api);
      if (detail instanceof Response) return detail;
      const [first, second] = detail.occurrences;
      if (first === undefined || second === undefined) throw new Error("Two occurrences expected");
      const occurrences: Occurrence[] = [
        { ...first, replay: { id: REPLAY_ID, status: "ready" } },
        { ...second, replay: { id: "bbbbbbbb-0000-4000-8000-000000000002", status: "pending" } },
        {
          ...second,
          eventId: "00000000-0000-4000-8000-000000000003",
          occurredAt: "2026-11-16T06:00:00.000Z",
          replay: { id: "cccccccc-0000-4000-8000-000000000003", status: "missing" },
        },
      ];
      return { ...detail, occurrences };
    },
  });
}

const occurrences = () => page.getByRole("table", { name: "Latest occurrences, newest first" });
/** The Replay column's cells, as text. */
const replayCells = () =>
  [...occurrences().element().querySelectorAll("tbody tr")].map(
    (row) => row.querySelectorAll("td")[6]?.textContent,
  );

describe("an occurrence's replay", () => {
  test("is offered to play when ready, arriving when pending, and none when missing", async () => {
    installWithReplays();
    renderApp(TYPE_ERROR);

    await expect.element(occurrences()).toBeVisible();
    expect(
      [...occurrences().element().querySelectorAll("thead th")].map((cell) => cell.textContent),
    ).toContain("Replay");
    expect(replayCells()).toEqual([
      "Play replay",
      "Arriving… The page sends its replay about 10 seconds after the error.",
      "—No replay",
    ]);
    const arriving = occurrences().getByText("Arriving…", { exact: false });
    await expect
      .element(arriving)
      .toHaveAttribute("title", "The page sends its replay about 10 seconds after the error.");
    // One button: only the ready replay plays.
    expect(occurrences().getByRole("button").all()).toHaveLength(1);
  });

  test("plays in a large dialog, a frame of the player page at the error's time", async () => {
    installWithReplays();
    renderApp(TYPE_ERROR);

    const button = page.getByRole("button", {
      name: "Play replay of the error at 16 Nov 2026, 16:00",
    });
    await button.click();

    const dialog = page.getByRole("dialog", { name: "Session replay" });
    await expect.element(dialog).toBeVisible();
    await expect
      .element(
        dialog.getByText(
          "Around the error at 16 Nov 2026, 16:00, in Asia/Singapore, on /checkout.",
        ),
      )
      .toBeVisible();
    const frame = dialog.element().querySelector("iframe");
    expect(frame?.getAttribute("src")).toBe(
      `${REPLAYS_PATH}/${REPLAY_ID}/player?errorAt=${Date.parse("2026-11-16T08:00:00.000Z")}`,
    );
    expect(frame?.title).toBe("Session replay around the error at 16 Nov 2026, 16:00");
    expect(frame?.getAttribute("referrerpolicy")).toBe("no-referrer");
    // Nothing loosened: the player page's own policy protects it.
    expect(frame?.hasAttribute("sandbox")).toBe(false);
    expect(frame?.hasAttribute("allow")).toBe(false);
    // Most of the screen.
    const box = dialog.element().getBoundingClientRect();
    expect(box.width).toBeGreaterThan(window.innerWidth * 0.8);
    expect(box.height).toBeGreaterThan(window.innerHeight * 0.8);

    await dialog.getByRole("button", { name: "Close" }).click();
    await expect.element(dialog).not.toBeInTheDocument();
    await expect.element(button).toHaveFocus();
  });
});

/** The Session replay card on the project's settings page. */
const card = () => {
  const heading = page.getByRole("heading", { name: "Session replay" }).element();
  const found = heading.closest("[data-slot=card]");
  if (!(found instanceof HTMLElement)) throw new Error("The Session replay card is missing");
  return found;
};

const off = () => page.getByRole("radio", { name: /^Off/ });
const aroundErrors = () => page.getByRole("radio", { name: /^Around errors/ });

describe("the project's Session replay card", () => {
  test("shows replays off, how a site turns them on, what stays private, and the use", async () => {
    installFakeApi();
    renderApp(SETTINGS);

    await expect.element(off()).toBeChecked();
    await expect.element(aroundErrors()).not.toBeChecked();
    const text = card().textContent;
    expect(text).toContain("Both switches are needed");
    await expect
      .element(page.getByRole("button", { name: "Copy the replay attribute" }))
      .toBeVisible();
    expect(text).toContain('data-replay="errors"');
    expect(text).toContain("masked in the visitor's browser");
    expect(text).toContain("never reaches Ottertrail");
    for (const option of [
      'data-replay-text="show"',
      'data-replay-media="show"',
      "data-ottertrail-mask",
      "data-ottertrail-block",
      "data-ottertrail-unmask",
    ]) {
      expect(text).toContain(option);
    }
    expect(text).toContain("3 replays, 1.5 MB in this project.");
    expect(text).toContain("2 MB of 5 GB used, by all projects together.");
    expect(text).toContain("Replays are kept 30 days");
  });

  test("turns replays on around errors, saving at once, and says so", async () => {
    const api = installFakeApi();
    const answer = deferred<void>();
    renderApp(SETTINGS);
    await expect.element(off()).toBeChecked();

    // Holds the save back, to see it saving.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (init?.method === "PATCH") await answer.promise;
      return realFetch(input, init);
    };
    try {
      await aroundErrors().click();
      await expect.element(page.getByText("Saving…")).toBeVisible();
      await expect.element(aroundErrors()).toBeChecked();
      await expect.element(aroundErrors()).toBeDisabled();
      answer.resolve();
      await expect
        .element(card().querySelector("output") ?? document.body)
        .toHaveTextContent("Saved.");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(api.bodies.at(-1)).toEqual({
      method: "PATCH",
      path: `/api/projects/${PROJECT.id}`,
      body: { replayMode: "errors" },
    });
    expect(api.projects[0]?.replayMode).toBe("errors");
    await expect.element(aroundErrors()).toBeChecked();
  });

  test("shows the saved choice again when saving fails", async () => {
    const api = installFakeApi();
    renderApp(SETTINGS);
    await expect.element(off()).toBeChecked();

    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) =>
      init?.method === "PATCH"
        ? json({ error: "internal", message: "The database is unavailable." }, 500)
        : realFetch(input, init);
    try {
      await aroundErrors().click();
      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent("The change was not saved: The database is unavailable.");
    } finally {
      globalThis.fetch = realFetch;
    }
    await expect.element(off()).toBeChecked();
    expect(api.projects[0]?.replayMode).toBe("off");
  });

  test("deletes all replays after a confirmation that says the errors stay", async () => {
    const api = installFakeApi();
    renderApp(SETTINGS);

    const button = page.getByRole("button", { name: "Delete all replays" });
    await button.click();
    const confirm = page.getByRole("dialog", { name: "Delete all replays?" });
    await expect
      .element(confirm.getByText(/^All 3 replays of the project are deleted for good/))
      .toBeVisible();
    await expect.element(confirm.getByText(/this cannot be undone/)).toBeVisible();
    await expect.element(confirm.getByText(/The errors stay/)).toBeVisible();

    // Cancelled: nothing sent, and focus back on the button, still there.
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect.element(confirm).not.toBeInTheDocument();
    expect(api.bodies).toEqual([]);
    expect(api.replays.count).toBe(3);
    await expect.element(button).toHaveFocus();

    await button.click();
    await confirm.getByRole("button", { name: "Delete all replays" }).click();

    await expect.element(confirm).not.toBeInTheDocument();
    expect(api.replays.count).toBe(0);
    await expect.poll(() => card().textContent).toContain("No replays in this project.");
    await expect.poll(() => card().textContent).toContain("512 KB of 5 GB used");
    // Nothing left to delete: the button goes, and focus goes to the card's heading.
    await expect
      .element(page.getByRole("button", { name: "Delete all replays" }))
      .not.toBeInTheDocument();
    await expect.element(page.getByRole("heading", { name: "Session replay" })).toHaveFocus();
  });

  test("offers no delete without replays", async () => {
    installFakeApi({ replays: { ...fakeReplays(), count: 0, bytes: 0 } });
    renderApp(SETTINGS);

    await expect.poll(() => card().textContent).toContain("No replays in this project.");
    await expect
      .element(page.getByRole("button", { name: "Delete all replays" }))
      .not.toBeInTheDocument();
  });

  test("on an install without an object store, says replays are off, and nothing else", async () => {
    installFakeApi({ replays: { ...fakeReplays(), configured: false } });
    renderApp(SETTINGS);

    await expect
      .element(page.getByText(/^Session replay is off on this install: it has no object store/))
      .toBeVisible();
    expect(card().textContent).toContain("OBJECT_STORE_URL");
    await expect.element(off()).not.toBeInTheDocument();
    expect(card().textContent).not.toContain("data-replay");
    expect(card().textContent).not.toContain("Delete all replays");
  });
});
