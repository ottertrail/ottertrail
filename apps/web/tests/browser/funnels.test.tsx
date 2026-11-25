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
/** The funnel view's heading: the saved funnel's name, or "Unsaved funnel". */
const funnelHeading = (name: string) => page.getByRole("heading", { name, exact: true });
/** The save actions' word on the saved funnel open (the page has other status regions). */
const status = () =>
  page.getByRole("status").filter({ hasText: /^(No unsaved changes|Unsaved changes)$/ });
const allFunnels = () => page.getByRole("link", { name: "All funnels" });
/** The dialog that builds a new funnel or changes the shown one's steps. */
const newFunnelDialog = () => page.getByRole("dialog", { name: "New funnel" });
const editDialog = () => page.getByRole("dialog", { name: "Edit the funnel's steps" });

/** Picks an option of one of the dialog's selects. */
async function choose(combobox: string, option: string) {
  await page.getByRole("combobox", { name: combobox }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

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
    await expect.element(page.getByRole("button", { name: "New funnel" })).toBeVisible();
    // No funnel is shown, so there is nothing to save, and no build prompt beside the list.
    expect(page.getByRole("button", { name: "Save funnel" }).elements()).toEqual([]);
    expect(page.getByText("No funnels yet").elements()).toEqual([]);
    expect(page.getByRole("button", { name: "Try this example" }).elements()).toEqual([]);
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
    // The funnel view, named, with its definition in a line.
    await expect.element(funnelHeading("Team trial")).toBeVisible();
    await expect
      .element(
        page.getByText("signup where plan = team → purchase · Users, within 7 days", {
          exact: true,
        }),
      )
      .toBeVisible();
    await expect.element(savedHeading()).not.toBeInTheDocument();
    await expect.element(status()).toHaveTextContent("No unsaved changes");
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
    await expect.element(funnelHeading("Unsaved funnel")).toBeVisible();
    // A change in the editor, cancelled: never shown.
    await page.getByRole("button", { name: "Edit steps" }).click();
    await editDialog()
      .getByRole("group", { name: "Step 2" })
      .getByRole("combobox", { name: "Event name" })
      .fill("refund");
    await editDialog().getByRole("button", { name: "Cancel" }).click();
    await expect.element(editDialog()).not.toBeInTheDocument();

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
    await expect.element(status()).toHaveTextContent("No unsaved changes");
    // The trigger is gone, so focus goes to the heading, now the funnel's name.
    await expect.element(funnelHeading("Home to purchase")).toHaveFocus();

    // Listed with the others.
    await allFunnels().click();
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

    await expect.element(funnelHeading("Team trial")).toBeVisible();
    await expect.element(status()).toHaveTextContent("Unsaved changes");

    await page.getByRole("button", { name: "Save changes" }).click();

    await expect.element(status()).toHaveTextContent("No unsaved changes");
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
    // Focus stays on Save changes, now disabled and still focusable.
    await expect.element(page.getByRole("button", { name: "Save changes" })).toHaveFocus();
    await expect
      .element(page.getByRole("button", { name: "Save changes" }))
      .toHaveAttribute("aria-disabled", "true");
    expect(router.state.location.search).toMatchObject({ funnel: TEAM_TRIAL });

    // Another window, saved as a new funnel instead.
    await page.getByRole("button", { name: "Edit steps" }).click();
    await choose("Conversion window", "30 days");
    await editDialog().getByRole("button", { name: "Show funnel" }).click();
    await expect.element(status()).toHaveTextContent("Unsaved changes");
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
    await expect.element(funnelHeading("Team trial, a month")).toBeVisible();
    await expect.element(status()).toHaveTextContent("No unsaved changes");
    // The first one is as it was saved.
    expect(api.savedFunnels.find((funnel) => funnel.id === TEAM_TRIAL)?.window).toBe(3600);
    await allFunnels().click();
    await expect.poll(savedRows).toEqual([
      ["pricing to signup", "/pricing → signup", "Visitors, within 1 day"],
      ["Team trial", "signup where plan = team → purchase", "Users, within 1 hour"],
      ["Team trial, a month", "signup where plan = team → purchase", "Users, within 30 days"],
    ]);
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
    // The list is read again: it is gone, so the funnel shown is unsaved and can only be saved anew.
    await expect.element(funnelHeading("Unsaved funnel")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Save changes" }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "Save funnel" }).click();
    const dialog = page.getByRole("dialog", { name: "Save the funnel" });
    await dialog.getByRole("textbox", { name: "Name" }).fill("Team trial again");
    await dialog.getByRole("button", { name: "Save funnel" }).click();
    await expect.element(funnelHeading("Team trial again")).toBeVisible();
    await expect.element(status()).toHaveTextContent("No unsaved changes");
    // The failure was for the funnel deleted, not for this one.
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  });

  test("does not undo a change made in another tab: says so, and loads it", async () => {
    const api = installFakeApi();
    renderApp(funnelAddress(TEAM_STEPS, `&funnel=${TEAM_TRIAL}&count=users&window=3600`));
    await expect.element(status()).toHaveTextContent("Unsaved changes");
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
    await expect.element(funnelHeading("Team trial (renamed)")).toBeVisible();
    await expect.element(status()).toHaveTextContent("Unsaved changes");
    expect(api.savedFunnels.find((funnel) => funnel.id === TEAM_TRIAL)?.window).toBe(604_800);

    // Seen, and saved again: from the version loaded, keeping its new name.
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect.element(status()).toHaveTextContent("No unsaved changes");
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

    const save = page.getByRole("button", { name: "Save funnel" });
    await expect.element(save).toBeDisabled();
    await expect
      .element(save)
      .toHaveAccessibleDescription(
        "A project has at most 50 saved funnels. Delete one to save another.",
      );
    // The list says how many, and a new funnel can still be built and shown.
    await allFunnels().click();
    await expect.element(page.getByText("50 of 50 saved")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "New funnel" })).toBeEnabled();
  });

  test("deletes one after a confirmation that says the events stay", async () => {
    const api = installFakeApi();
    const router = renderApp(`${FUNNEL}?period=30d`);

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
    expect(router.state.location.search).toEqual({ period: "30d" });
  });

  test("a funnel deleted while open keeps its steps shown, now unsaved", async () => {
    const api = installFakeApi();
    const steps: FunnelStep[] = [
      { type: "page", path: "/pricing" },
      { type: "event", name: "signup" },
    ];
    const router = renderApp(funnelAddress(steps, `&funnel=${PRICING}`));
    await expect.element(funnelHeading("pricing to signup")).toBeVisible();
    await expect.element(status()).toHaveTextContent("No unsaved changes");

    // Deleted from the list, then back to its address: the funnel is no longer saved.
    await allFunnels().click();
    await page.getByRole("button", { name: "Delete the funnel pricing to signup" }).click();
    await page
      .getByRole("dialog", { name: "Delete the funnel “pricing to signup”?" })
      .getByRole("button", { name: "Delete funnel" })
      .click();
    await expect
      .poll(savedRows)
      .toEqual([["Team trial", "signup where plan = team → purchase", "Users, within 7 days"]]);
    expect(api.savedFunnels.some((funnel) => funnel.id === PRICING)).toBe(false);
    router.history.back();

    await expect.element(funnelHeading("Unsaved funnel")).toBeVisible();
    await expect
      .element(page.getByText("/pricing → signup · Visitors, within 1 day", { exact: true }))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Save funnel" })).toBeVisible();
    await expect.element(status()).not.toBeInTheDocument();
  });

  test("without saved funnels, says what a funnel is and how to start one", async () => {
    installFakeApi({ savedFunnels: [] });
    renderApp(FUNNEL);

    await expect.element(page.getByText("No funnels yet")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "New funnel" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Try this example" })).toBeVisible();
    expect(page.getByText("0 of 50 saved").elements()).toEqual([]);
    expect(savedRows()).toEqual([]);
  });
});

describe("the list and the funnel view", () => {
  test("All funnels goes back to the list, keeping the period and the environment", async () => {
    installFakeApi();
    const router = renderApp(
      funnelAddress(
        TEAM_STEPS,
        `&funnel=${TEAM_TRIAL}&count=users&window=604800&period=30d&env=staging`,
      ),
    );
    await expect.element(funnelHeading("Team trial")).toBeVisible();

    await allFunnels().click();

    await expect
      .poll(() => router.state.location.search)
      .toEqual({ period: "30d", env: "staging" });
    await expect.element(savedHeading()).toBeVisible();
    await expect.poll(savedRows).toHaveLength(2);
    await expect.element(allFunnels()).not.toBeInTheDocument();
  });

  test("New funnel after a saved one starts empty, and what it shows is unsaved", async () => {
    const api = installFakeApi();
    const router = renderApp(FUNNEL);
    await page.getByRole("link", { name: "Team trial" }).click();
    await expect.element(status()).toHaveTextContent("No unsaved changes");
    await allFunnels().click();

    await page.getByRole("button", { name: "New funnel" }).click();
    const dialog = newFunnelDialog();
    await expect.element(dialog).toBeVisible();
    // Two empty steps, counted the default way: nothing of Team trial.
    const name = (n: number) =>
      dialog
        .getByRole("group", { name: `Step ${n}` })
        .getByRole("combobox", { name: "Event name" });
    await expect.element(name(1)).toHaveValue("");
    await expect.element(name(2)).toHaveValue("");
    await expect.element(dialog.getByRole("group", { name: "Step 3" })).not.toBeInTheDocument();
    await expect
      .element(dialog.getByRole("combobox", { name: "Count by" }))
      .toMatchTextContent(/Visitors/);
    await expect
      .element(dialog.getByRole("combobox", { name: "Conversion window" }))
      .toMatchTextContent(/1 day/);

    await name(1).fill("signup");
    await name(2).fill("purchase");
    await dialog.getByRole("button", { name: "Show funnel" }).click();

    const steps: FunnelStep[] = [
      { type: "event", name: "signup" },
      { type: "event", name: "purchase" },
    ];
    await expect.element(dialog).not.toBeInTheDocument();
    await expect.poll(() => router.state.location.search).toEqual({ steps });
    await expect.element(funnelHeading("Unsaved funnel")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Save funnel" })).toBeVisible();
    expect(page.getByRole("button", { name: "Save changes" }).elements()).toEqual([]);
    expect(
      page
        .getByRole("status")
        .filter({ hasText: /unsaved changes/i })
        .elements(),
    ).toEqual([]);
    await expect
      .poll(() => lastFunnelQuery(api))
      .toEqual({ period: "7d", steps: JSON.stringify(steps), count: "visitors", window: "86400" });
  });

  test("New funnel never keeps a saved funnel's ID left in the address", async () => {
    installFakeApi();
    // A saved funnel's ID with no steps: the list.
    const router = renderApp(`${FUNNEL}?funnel=${TEAM_TRIAL}`);
    await expect.element(savedHeading()).toBeVisible();

    await page.getByRole("button", { name: "New funnel" }).click();
    const dialog = newFunnelDialog();
    await dialog
      .getByRole("group", { name: "Step 1" })
      .getByRole("combobox", { name: "Event name" })
      .fill("signup");
    await dialog
      .getByRole("group", { name: "Step 2" })
      .getByRole("combobox", { name: "Event name" })
      .fill("purchase");
    await dialog.getByRole("button", { name: "Show funnel" }).click();

    await expect.poll(() => router.state.location.search).not.toHaveProperty("funnel");
    await expect.element(funnelHeading("Unsaved funnel")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Save funnel" })).toBeVisible();
  });

  test("Edit steps starts from the funnel shown and keeps the saved funnel open", async () => {
    installFakeApi();
    const router = renderApp(
      funnelAddress(TEAM_STEPS, `&funnel=${TEAM_TRIAL}&count=users&window=604800`),
    );
    await expect.element(status()).toHaveTextContent("No unsaved changes");

    await page.getByRole("button", { name: "Edit steps" }).click();
    const dialog = editDialog();
    const step1 = dialog.getByRole("group", { name: "Step 1" });
    await expect.element(step1.getByRole("combobox", { name: "Event name" })).toHaveValue("signup");
    await expect.element(step1.getByRole("textbox", { name: "Property" })).toHaveValue("plan");
    await expect.element(step1.getByRole("textbox", { name: "Value" })).toHaveValue("team");
    await expect
      .element(dialog.getByRole("combobox", { name: "Count by" }))
      .toMatchTextContent(/Users/);
    await expect
      .element(dialog.getByRole("combobox", { name: "Conversion window" }))
      .toMatchTextContent(/7 days/);

    await choose("Conversion window", "1 hour");
    await dialog.getByRole("button", { name: "Show funnel" }).click();

    await expect
      .poll(() => router.state.location.search)
      .toEqual({ funnel: TEAM_TRIAL, steps: TEAM_STEPS, count: "users", window: 3600 });
    await expect.element(funnelHeading("Team trial")).toBeVisible();
    await expect.element(status()).toHaveTextContent("Unsaved changes");
  });

  test("the dialog's Cancel leaves the page as it was", async () => {
    const api = installFakeApi();
    const address = funnelAddress(SHOWN, "&count=users&window=3600");
    const router = renderApp(address);
    await expect.element(funnelHeading("Unsaved funnel")).toBeVisible();
    await expect.poll(() => lastFunnelQuery(api).steps).toBe(JSON.stringify(SHOWN));
    const search = router.state.location.search;
    const funnelRequests = api.requests.filter((item) => item.includes("/funnel?")).length;

    // Steps, who is counted, and the window all changed, then cancelled.
    await page.getByRole("button", { name: "Edit steps" }).click();
    const dialog = editDialog();
    await dialog
      .getByRole("group", { name: "Step 2" })
      .getByRole("combobox", { name: "Event name" })
      .fill("refund");
    await dialog.getByRole("button", { name: "Add a step" }).click();
    await choose("Count by", "Visitors");
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await expect.element(dialog).not.toBeInTheDocument();
    expect(router.state.location.search).toEqual(search);
    await expect
      .element(page.getByText("/ → purchase · Users, within 1 hour", { exact: true }))
      .toBeVisible();
    expect(api.requests.filter((item) => item.includes("/funnel?"))).toHaveLength(funnelRequests);
    await expect.element(page.getByRole("button", { name: "Edit steps" })).toHaveFocus();

    // Opened again, it starts from the funnel shown, not the cancelled draft.
    await page.getByRole("button", { name: "Edit steps" }).click();
    await expect
      .element(
        editDialog()
          .getByRole("group", { name: "Step 2" })
          .getByRole("combobox", { name: "Event name" }),
      )
      .toHaveValue("purchase");
    await expect
      .element(editDialog().getByRole("group", { name: "Step 3" }))
      .not.toBeInTheDocument();
    await expect
      .element(editDialog().getByRole("combobox", { name: "Count by" }))
      .toMatchTextContent(/Users/);
    await editDialog().getByRole("button", { name: "Cancel" }).click();

    // On the list, New funnel's Cancel changes nothing either.
    await allFunnels().click();
    await expect.element(savedHeading()).toBeVisible();
    const listSearch = router.state.location.search;
    await page.getByRole("button", { name: "New funnel" }).click();
    await newFunnelDialog()
      .getByRole("group", { name: "Step 1" })
      .getByRole("combobox", { name: "Event name" })
      .fill("signup");
    await newFunnelDialog().getByRole("button", { name: "Cancel" }).click();
    await expect.element(newFunnelDialog()).not.toBeInTheDocument();
    expect(router.state.location.search).toEqual(listSearch);
    await expect.element(savedHeading()).toBeVisible();
  });
});
