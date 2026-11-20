import { describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import type { SavedFunnel } from "../../src/lib/funnels-api.ts";
import type { FunnelStep } from "../../src/lib/product-api.ts";
import { type FakeApi, installFakeApi, PROJECT } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

const FUNNEL = `/projects/${PROJECT.id}/product/funnel`;
const FUNNELS_PATH = `/api/projects/${PROJECT.id}/funnels`;
const TEAM_TRIAL = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const PRICING = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";
/** Team trial's version as first loaded: a change names it. */
const TEAM_TRIAL_READ = "2026-11-02T00:00:00.000Z";

/** Team trial's steps as the address holds them. */
const TEAM_STEPS: FunnelStep[] = [
  { type: "event", name: "signup", filter: { key: "plan", value: "team" } },
  { type: "event", name: "purchase" },
];

const SHOWN: FunnelStep[] = [
  { type: "page", path: "/" },
  { type: "event", name: "purchase" },
];

/** The funnel page's address for these steps, and whatever else is given. */
const funnelAddress = (steps: FunnelStep[], rest = "") =>
  `${FUNNEL}?steps=${encodeURIComponent(JSON.stringify(steps))}${rest}`;

/** The query of the latest request for a funnel's counts. */
function lastFunnelQuery(api: FakeApi): Record<string, string> {
  const request = api.requests.findLast((item) => item.split("?")[0]?.endsWith("/funnel")) ?? "";
  const at = request.indexOf("?");
  return at === -1 ? {} : Object.fromEntries(new URLSearchParams(request.slice(at + 1)));
}

/** Each saved funnel's row as its cells' text: name, steps, and who it counts for how long. */
function savedRows(): string[][] {
  const table = [...document.querySelectorAll("table")].find(
    (item) => item.caption?.textContent === "Saved funnels, by name",
  );
  return [...(table?.tBodies[0]?.rows ?? [])].map((row) =>
    [...row.cells].slice(0, 3).map((cell) => cell.textContent ?? ""),
  );
}

const savedHeading = () => page.getByRole("heading", { name: "Saved funnels" });
const stepsHeading = () => page.getByRole("heading", { name: "Steps", exact: true });
/** The Steps card's word on the saved funnel open (the page has other status regions). */
const status = () =>
  page.getByRole("status").filter({ hasText: /^(Saved as|Changed from the saved funnel)/ });

/** n saved funnels of visitors within a day. */
const manyFunnels = (n: number): SavedFunnel[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `dddddddd-dddd-4ddd-8ddd-${String(i).padStart(12, "0")}`,
    name: `Funnel ${String(i + 1).padStart(2, "0")}`,
    steps: [
      { type: "page", path: `/page-${i + 1}` },
      { type: "event", name: "signup" },
    ],
    count: "visitors",
    window: 86_400,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  }));

describe("saved funnels", () => {
  test("lists them by name, with their steps, and who they count for how long", async () => {
    installFakeApi();
    renderApp(FUNNEL);

    await expect.element(savedHeading()).toBeVisible();
    await expect.poll(savedRows).toEqual([
      ["pricing to signup", "/pricing → signup", "Visitors, within 1 day"],
      ["Team trial", "signup where plan = team → purchase", "Users, within 7 days"],
    ]);
    await expect.element(page.getByText("2 of 50 saved")).toBeVisible();
    // No funnel is shown yet, so there is nothing to save: Save is disabled, and stays focusable.
    await expect
      .element(page.getByRole("button", { name: "Save funnel" }))
      .toHaveAttribute("aria-disabled", "true");
  });

  test("opens one from its link, keeping the period and the environment", async () => {
    const api = installFakeApi();
    const router = renderApp(`${FUNNEL}?period=30d&env=staging`);

    await page.getByRole("link", { name: "Team trial" }).click();

    await expect
      .poll(() => router.state.location.search)
      .toEqual({
        period: "30d",
        env: "staging",
        funnel: TEAM_TRIAL,
        steps: TEAM_STEPS,
        count: "users",
        window: 604_800,
      });
    await expect
      .poll(() => lastFunnelQuery(api))
      .toEqual({
        period: "30d",
        environment: "staging",
        steps: JSON.stringify(TEAM_STEPS),
        count: "users",
        window: "604800",
      });
    await expect
      .element(page.getByRole("link", { name: "Team trial" }))
      .toHaveAttribute("aria-current");
    await expect
      .element(page.getByRole("link", { name: "pricing to signup" }))
      .not.toHaveAttribute("aria-current");
    await expect.element(status()).toHaveTextContent("Saved as “Team trial”.");
    // Shown as it was saved: nothing new to save.
    await expect
      .element(page.getByRole("button", { name: "Save changes" }))
      .toHaveAttribute("aria-disabled", "true");
    await expect.element(page.getByRole("button", { name: "Save funnel" })).not.toBeInTheDocument();
  });

  test("keeps only a UUID as the saved funnel in the address", async () => {
    installFakeApi();
    const router = renderApp(funnelAddress(SHOWN, "&funnel=not-a-uuid"));

    await expect.element(page.getByRole("button", { name: "Save funnel" })).toBeVisible();
    expect(router.state.location.search).toEqual({ steps: SHOWN });
  });

  test("saves the funnel shown, not the editor's unshown draft, and opens it", async () => {
    const api = installFakeApi();
    const router = renderApp(funnelAddress(SHOWN, "&count=users&window=3600"));
    await expect.element(page.getByRole("button", { name: "Save funnel" })).toBeVisible();
    // A change in the editor, not shown yet.
    await page
      .getByRole("group", { name: "Step 2" })
      .getByRole("combobox", { name: "Event name" })
      .fill("refund");

    await page.getByRole("button", { name: "Save funnel" }).click();
    const dialog = page.getByRole("dialog", { name: "Save the funnel" });
    await expect.element(dialog).toBeVisible();
    await expect.element(dialog.getByRole("textbox", { name: "Name" })).toHaveFocus();
    // What is saved, and what is not.
    await expect.element(dialog.getByText("/ → purchase")).toBeVisible();
    await expect.element(dialog.getByText("Users, within 1 hour")).toBeVisible();
    await expect
      .element(dialog.getByText(/Uses the current period and environment when reopened/))
      .toBeVisible();

    await dialog.getByRole("textbox", { name: "Name" }).fill("  Home to purchase ");
    await dialog.getByRole("button", { name: "Save funnel" }).click();

    await expect.element(dialog).not.toBeInTheDocument();
    expect(api.bodies).toContainEqual({
      method: "POST",
      path: FUNNELS_PATH,
      body: { name: "Home to purchase", steps: SHOWN, count: "users", window: 3600 },
    });
    const saved = api.savedFunnels.find((funnel) => funnel.name === "Home to purchase");
    await expect
      .poll(() => router.state.location.search)
      .toEqual({ funnel: saved?.id, steps: SHOWN, count: "users", window: 3600 });
    await expect.element(status()).toHaveTextContent("Saved as “Home to purchase”.");
    await expect.element(stepsHeading()).toHaveFocus();
    await expect
      .poll(savedRows)
      .toContainEqual(["Home to purchase", "/ → purchase", "Users, within 1 hour"]);
    await expect.element(page.getByText("3 of 50 saved")).toBeVisible();
  });

  test("checks the name before sending", async () => {
    const api = installFakeApi();
    renderApp(funnelAddress(SHOWN));

    await page.getByRole("button", { name: "Save funnel" }).click();
    const dialog = page.getByRole("dialog", { name: "Save the funnel" });
    await dialog.getByRole("button", { name: "Save funnel" }).click();
    await expect.element(dialog.getByText("Name the funnel.")).toBeVisible();
    await expect
      .element(dialog.getByRole("textbox", { name: "Name" }))
      .toHaveAttribute("aria-invalid", "true");

    await dialog.getByRole("textbox", { name: "Name" }).fill("🎉".repeat(101));
    await expect
      .element(dialog.getByText("A funnel's name has at most 100 characters."))
      .toBeVisible();
    expect(api.bodies.filter((body) => body.path === FUNNELS_PATH)).toEqual([]);

    // Cancelled, focus goes back to the button, which is still there.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect.element(dialog).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Save funnel" })).toHaveFocus();
  });

  test("an open funnel shown with other settings can be saved over, or as a new one", async () => {
    const api = installFakeApi();
    const router = renderApp(
      funnelAddress(TEAM_STEPS, `&funnel=${TEAM_TRIAL}&count=users&window=3600`),
    );

    await expect.element(status()).toHaveTextContent("Changed from the saved funnel “Team trial”.");
    await expect
      .element(page.getByRole("link", { name: "Team trial" }))
      .toHaveAttribute("aria-current", "true");

    await page.getByRole("button", { name: "Save changes" }).click();

    await expect.element(status()).toHaveTextContent("Saved as “Team trial”.");
    expect(api.bodies).toContainEqual({
      method: "PUT",
      path: `${FUNNELS_PATH}/${TEAM_TRIAL}`,
      body: {
        name: "Team trial",
        steps: TEAM_STEPS,
        count: "users",
        window: 3600,
        updatedAt: TEAM_TRIAL_READ,
      },
    });
    await expect
      .poll(savedRows)
      .toContainEqual([
        "Team trial",
        "signup where plan = team → purchase",
        "Users, within 1 hour",
      ]);
    // Focus stays on Save changes, now disabled and still focusable.
    await expect.element(page.getByRole("button", { name: "Save changes" })).toHaveFocus();
    await expect
      .element(page.getByRole("button", { name: "Save changes" }))
      .toHaveAttribute("aria-disabled", "true");
    expect(router.state.location.search).toMatchObject({ funnel: TEAM_TRIAL });

    // Another window, saved as a new funnel instead.
    await page.getByRole("combobox", { name: "Conversion window" }).click();
    await page.getByRole("option", { name: "30 days", exact: true }).click();
    await expect.element(status()).toHaveTextContent("Changed from the saved funnel “Team trial”.");
    await page.getByRole("button", { name: "Save as new funnel" }).click();
    const dialog = page.getByRole("dialog", { name: "Save as a new funnel" });
    await dialog.getByRole("textbox", { name: "Name" }).fill("Team trial, a month");
    await dialog.getByRole("button", { name: "Save funnel" }).click();

    await expect.element(dialog).not.toBeInTheDocument();
    expect(api.bodies).toContainEqual({
      method: "POST",
      path: FUNNELS_PATH,
      body: { name: "Team trial, a month", steps: TEAM_STEPS, count: "users", window: 2_592_000 },
    });
    const created = api.savedFunnels.find((funnel) => funnel.name === "Team trial, a month");
    await expect.poll(() => router.state.location.search).toMatchObject({ funnel: created?.id });
    await expect.element(status()).toHaveTextContent("Saved as “Team trial, a month”.");
    // The first one is as it was saved.
    expect(api.savedFunnels.find((funnel) => funnel.id === TEAM_TRIAL)?.window).toBe(3600);
  });

  test("says when Save changes fails", async () => {
    const api = installFakeApi();
    renderApp(funnelAddress(TEAM_STEPS, `&funnel=${TEAM_TRIAL}&count=users&window=3600`));
    await expect.element(page.getByRole("button", { name: "Save changes" })).toBeVisible();
    // Deleted in another tab.
    api.savedFunnels = api.savedFunnels.filter((funnel) => funnel.id !== TEAM_TRIAL);

    await page.getByRole("button", { name: "Save changes" }).click();

    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(
        "The changes could not be saved. The project has no saved funnel with this ID.",
      );
    // The list is read again: it is gone, so it can only be saved anew.
    await expect
      .poll(savedRows)
      .toEqual([["pricing to signup", "/pricing → signup", "Visitors, within 1 day"]]);
    await page.getByRole("button", { name: "Save funnel" }).click();
    const dialog = page.getByRole("dialog", { name: "Save the funnel" });
    await dialog.getByRole("textbox", { name: "Name" }).fill("Team trial again");
    await dialog.getByRole("button", { name: "Save funnel" }).click();
    await expect.element(status()).toHaveTextContent("Saved as “Team trial again”.");
    // The failure was for the funnel deleted, not for this one.
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  });

  test("does not undo a change made in another tab: says so, and loads it", async () => {
    const api = installFakeApi();
    renderApp(funnelAddress(TEAM_STEPS, `&funnel=${TEAM_TRIAL}&count=users&window=3600`));
    await expect.element(status()).toHaveTextContent("Changed from the saved funnel “Team trial”.");
    // Another tab renames it.
    api.savedFunnels = api.savedFunnels.map((funnel) =>
      funnel.id === TEAM_TRIAL
        ? { ...funnel, name: "Team trial (renamed)", updatedAt: "2026-11-10T00:00:00.000Z" }
        : funnel,
    );

    await page.getByRole("button", { name: "Save changes" }).click();

    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(
        "The changes could not be saved. The funnel changed elsewhere. The saved version has been reloaded; review it before saving again.",
      );
    await expect
      .element(status())
      .toHaveTextContent("Changed from the saved funnel “Team trial (renamed)”.");
    expect(api.savedFunnels.find((funnel) => funnel.id === TEAM_TRIAL)?.window).toBe(604_800);

    // Seen, and saved again: from the version loaded, keeping its new name.
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect.element(status()).toHaveTextContent("Saved as “Team trial (renamed)”.");
    expect(api.bodies.filter((body) => body.method === "PUT").at(-1)).toEqual({
      method: "PUT",
      path: `${FUNNELS_PATH}/${TEAM_TRIAL}`,
      body: {
        name: "Team trial (renamed)",
        steps: TEAM_STEPS,
        count: "users",
        window: 3600,
        updatedAt: "2026-11-10T00:00:00.000Z",
      },
    });
  });

  test("renames one, keeping its definition", async () => {
    const api = installFakeApi();
    renderApp(FUNNEL);

    await page.getByRole("button", { name: "Rename the funnel Team trial" }).click();
    const dialog = page.getByRole("dialog", { name: "Rename the funnel “Team trial”" });
    await expect.element(dialog.getByRole("textbox", { name: "Name" })).toHaveValue("Team trial");
    await dialog.getByRole("textbox", { name: "Name" }).fill("A team trial");
    await dialog.getByRole("button", { name: "Rename funnel" }).click();

    await expect.element(dialog).not.toBeInTheDocument();
    expect(api.bodies).toContainEqual({
      method: "PUT",
      path: `${FUNNELS_PATH}/${TEAM_TRIAL}`,
      body: {
        name: "A team trial",
        steps: TEAM_STEPS,
        count: "users",
        window: 604_800,
        updatedAt: TEAM_TRIAL_READ,
      },
    });
    await expect.poll(savedRows).toEqual([
      ["A team trial", "signup where plan = team → purchase", "Users, within 7 days"],
      ["pricing to signup", "/pricing → signup", "Visitors, within 1 day"],
    ]);
    // Its row stays, so focus goes back to its button.
    await expect
      .element(page.getByRole("button", { name: "Rename the funnel A team trial" }))
      .toHaveFocus();
  });

  test("shows the API's refusal in the dialog: a name already taken", async () => {
    const api = installFakeApi();
    renderApp(funnelAddress(SHOWN));

    await page.getByRole("button", { name: "Save funnel" }).click();
    const dialog = page.getByRole("dialog", { name: "Save the funnel" });
    await dialog.getByRole("textbox", { name: "Name" }).fill("Team trial");
    await dialog.getByRole("button", { name: "Save funnel" }).click();

    await expect
      .element(dialog.getByRole("alert"))
      .toHaveTextContent("The project already has a funnel with this name.");
    await expect
      .element(dialog.getByRole("textbox", { name: "Name" }))
      .toHaveAttribute("aria-invalid", "true");

    // Another name clears it, and the funnel is saved.
    await dialog.getByRole("textbox", { name: "Name" }).fill("Home to purchase");
    await expect.element(dialog.getByRole("alert")).not.toBeInTheDocument();
    await dialog.getByRole("button", { name: "Save funnel" }).click();
    await expect.element(dialog).not.toBeInTheDocument();
    expect(api.bodies.filter((body) => body.path === FUNNELS_PATH)).toHaveLength(2);
  });

  test("shows the limit refused by the API in the dialog", async () => {
    // 49 shown, but another tab saved the 50th.
    const api = installFakeApi({ savedFunnels: manyFunnels(49) });
    renderApp(funnelAddress(SHOWN));
    await page.getByRole("button", { name: "Save funnel" }).click();
    api.savedFunnels = manyFunnels(50);
    const dialog = page.getByRole("dialog", { name: "Save the funnel" });
    await dialog.getByRole("textbox", { name: "Name" }).fill("One more");
    await dialog.getByRole("button", { name: "Save funnel" }).click();

    await expect
      .element(dialog.getByRole("alert"))
      .toHaveTextContent("A project has at most 50 saved funnels.");
    await expect.element(dialog).toBeVisible();
  });

  test("at 50 saved, saving another is disabled with the reason", async () => {
    installFakeApi({ savedFunnels: manyFunnels(50) });
    renderApp(funnelAddress(SHOWN));

    await expect.element(page.getByText("50 of 50 saved")).toBeVisible();
    const save = page.getByRole("button", { name: "Save funnel" });
    await expect.element(save).toBeDisabled();
    await expect
      .element(save)
      .toHaveAccessibleDescription(
        "A project has at most 50 saved funnels. Delete one to save another.",
      );
  });

  test("deletes one after a confirmation that says the events stay", async () => {
    const api = installFakeApi();
    const router = renderApp(funnelAddress(SHOWN));

    await page.getByRole("button", { name: "Delete the funnel Team trial" }).click();
    const confirm = page.getByRole("dialog", { name: "Delete the funnel “Team trial”?" });
    await expect.element(confirm.getByText(/Your events are kept/)).toBeVisible();
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect.element(confirm).not.toBeInTheDocument();
    expect(api.requests.some((path) => path.startsWith(`${FUNNELS_PATH}/`))).toBe(false);
    await expect
      .element(page.getByRole("button", { name: "Delete the funnel Team trial" }))
      .toHaveFocus();

    await page.getByRole("button", { name: "Delete the funnel Team trial" }).click();
    await confirm.getByRole("button", { name: "Delete funnel" }).click();

    await expect.element(confirm).not.toBeInTheDocument();
    expect(api.requests).toContain(`${FUNNELS_PATH}/${TEAM_TRIAL}`);
    await expect
      .poll(savedRows)
      .toEqual([["pricing to signup", "/pricing → signup", "Visitors, within 1 day"]]);
    await expect.element(savedHeading()).toHaveFocus();
    expect(router.state.location.search).toEqual({ steps: SHOWN });
  });

  test("deleting the open funnel keeps the steps shown, now unsaved", async () => {
    const api = installFakeApi();
    const steps: FunnelStep[] = [
      { type: "page", path: "/pricing" },
      { type: "event", name: "signup" },
    ];
    const router = renderApp(funnelAddress(steps, `&funnel=${PRICING}`));
    await expect.element(status()).toHaveTextContent("Saved as “pricing to signup”.");
    const requests = api.requests.length;

    await page.getByRole("button", { name: "Delete the funnel pricing to signup" }).click();
    await page
      .getByRole("dialog", { name: "Delete the funnel “pricing to signup”?" })
      .getByRole("button", { name: "Delete funnel" })
      .click();

    await expect.poll(() => router.state.location.search).toEqual({ steps });
    await expect.element(page.getByRole("button", { name: "Save funnel" })).toBeVisible();
    await expect.element(savedHeading()).toHaveFocus();
    // The funnel shown is the same, so it is not asked for again.
    expect(api.requests.slice(requests).some((path) => path.includes("/funnel?"))).toBe(false);
  });

  test("without saved funnels, says how to save one", async () => {
    installFakeApi({ savedFunnels: [] });
    renderApp(FUNNEL);

    await expect
      .element(page.getByText(/Set the steps, then choose Show funnel and Save funnel/))
      .toBeVisible();
    await expect.element(page.getByText("0 of 50 saved")).toBeVisible();
    expect(savedRows()).toEqual([]);
  });
});
