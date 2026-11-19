import { afterEach, describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import {
  ERROR_FINGERPRINTS,
  fakeErrors,
  installFakeApi,
  memberAccess,
  PROJECT,
} from "./fake-api.ts";
import { renderApp } from "./render.tsx";

/*
 * The errors list as a workbench (docs/design-system.md, "Workbench"): the
 * summary while nothing is selected, the selection in the address, the
 * keys, and the error's own page on a narrow screen. errors.test.tsx covers
 * the list's contents and the error's detail.
 */

const ERRORS = `/projects/${PROJECT.id}/errors`;
const { typeError, referenceError } = ERROR_FINGERPRINTS;

afterEach(async () => {
  await page.viewport(1280, 900);
});

const list = () => page.getByRole("region", { name: "Errors, list" });
const summary = () => page.getByRole("region", { name: "Errors, summary" });
const detail = () => page.getByRole("region", { name: "Errors, selected" });
const selectedParam = (router: ReturnType<typeof renderApp>) =>
  (router.state.location.search as { error?: string }).error;

/** A figure in a stat strip, by its label. */
function figure(label: string): string | null | undefined {
  const term = [...document.querySelectorAll("dt")].find((dt) => dt.textContent === label);
  return term?.nextElementSibling?.textContent;
}

describe("the errors workbench", () => {
  test("with nothing selected, sums up the period and says how to start", async () => {
    installFakeApi();
    const router = renderApp(ERRORS);

    await expect.element(summary().getByRole("heading", { name: "This period" })).toBeVisible();
    // Nothing is selected on arrival.
    expect(selectedParam(router)).toBeUndefined();
    expect(figure("Unresolved")).toBe("2");
    expect(figure("New")).toBe("0");
    expect(figure("Regressed")).toBe("1");
    const top = summary().getByRole("table", { name: "Unresolved errors, most users first" });
    const rows = [...top.element().querySelectorAll("tbody tr")].map((row) =>
      [...row.querySelectorAll("th, td")].map((cell) => cell.textContent),
    );
    expect(rows).toEqual([
      ["TypeErrorCannot read properties of undefined (reading 'id')", "3", "1,234"],
      ["ReferenceErrorprocess is not defined", "0", "8"],
    ]);
    await expect.element(summary().getByText(/^Select an error, or press/)).toBeVisible();

    // A name in the summary selects its error.
    await top.getByRole("link", { name: "TypeError" }).click();
    await expect.poll(() => selectedParam(router)).toBe(typeError);
  });

  test("an empty period shows how errors are reported beside the list", async () => {
    installFakeApi({ errors: (query, api) => ({ ...fakeErrors(query, api), groups: [] }) });
    renderApp(ERRORS);

    await expect.element(page.getByText("Nothing unresolved in this period.")).toBeVisible();
    await expect.element(summary().getByText("No unresolved errors in this period")).toBeVisible();
    await expect.element(summary().getByRole("button", { name: "Copy the example" })).toBeVisible();
  });

  test("keeps the selection in the address, beside the list", async () => {
    installFakeApi();
    const router = renderApp(`${ERRORS}?error=${referenceError}`);

    await expect.element(detail().getByRole("heading", { name: "ReferenceError" })).toBeVisible();
    const row = document.querySelector(`[data-workbench-id="${referenceError}"]`);
    expect(row?.getAttribute("data-state")).toBe("selected");
    expect(row?.querySelector("a")?.getAttribute("aria-current")).toBe("true");
    // The detail links to the error's own page.
    await expect
      .element(detail().getByRole("link", { name: "Open the error's page" }))
      .toHaveAttribute("href", `${ERRORS}/${referenceError}`);

    await list()
      .getByRole("link", { name: /^TypeError/ })
      .click();
    await expect.poll(() => selectedParam(router)).toBe(typeError);
    await expect.element(detail().getByRole("heading", { name: "TypeError" })).toBeVisible();
    expect(router.state.location.pathname).toBe(ERRORS);
  });

  test("j and k move, Esc clears, and e resolves and reopens", async () => {
    const api = installFakeApi();
    const router = renderApp(ERRORS);
    await expect.element(summary()).toBeVisible();

    await userEvent.keyboard("j");
    await expect.poll(() => selectedParam(router)).toBe(typeError);
    await userEvent.keyboard("j");
    await expect.poll(() => selectedParam(router)).toBe(referenceError);
    await userEvent.keyboard("k");
    await expect.poll(() => selectedParam(router)).toBe(typeError);

    await expect.element(detail().getByRole("button", { name: "Resolve" })).toBeVisible();
    await userEvent.keyboard("e");
    await expect.poll(() => api.bodies.at(-1)?.body).toEqual({ status: "resolved" });
    expect(api.bodies.at(-1)?.path).toBe(`/api/projects/${PROJECT.id}/errors/${typeError}`);
    await expect.element(detail().getByRole("button", { name: "Reopen" })).toBeVisible();
    await userEvent.keyboard("e");
    await expect.poll(() => api.bodies.at(-1)?.body).toEqual({ status: "unresolved" });

    await userEvent.keyboard("{Escape}");
    await expect.poll(() => selectedParam(router)).toBeUndefined();
    await expect.element(summary()).toBeVisible();
  });

  test("lists the keys in the filter bar, from 64rem", async () => {
    installFakeApi();
    renderApp(ERRORS);

    await expect
      .element(page.getByRole("list", { name: "Keyboard shortcuts" }))
      .toHaveTextContent("jkmoveeresolve or reopenEscclear");
  });

  test("on a narrow screen, a selection in the address opens the error's own page", async () => {
    await page.viewport(800, 900);
    installFakeApi();
    const router = renderApp(`${ERRORS}?error=${typeError}`);

    await expect.poll(() => router.state.location.pathname).toBe(`${ERRORS}/${typeError}`);
    await expect.element(page.getByRole("heading", { name: "TypeError" })).toBeVisible();

    // Back returns to the list, without the selection.
    router.history.back();
    await expect.poll(() => router.state.location.pathname).toBe(ERRORS);
    expect(selectedParam(router)).toBeUndefined();
    // A row opens the page too.
    await list()
      .getByRole("link", { name: /^ReferenceError/ })
      .click();
    await expect.poll(() => router.state.location.pathname).toBe(`${ERRORS}/${referenceError}`);
  });
});

/** Nothing in the content panel or the page scrolls sideways. */
function expectNoSidewaysScroll(width: number) {
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  const panel = document.querySelector("[data-slot=app-content]");
  expect(panel?.scrollWidth).toBeLessThanOrEqual(panel?.clientWidth ?? 0);
}

describe("the errors page fits", () => {
  test("at 390 wide: the list alone, its filters wrapped, nothing sideways", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    renderApp(ERRORS);

    await expect.element(list().getByRole("link", { name: /^TypeError/ })).toBeVisible();
    await expect.element(page.getByRole("group", { name: "Status" })).toBeVisible();
    expectNoSidewaysScroll(390);
    // No room for the detail, nor for the key hints.
    expect(summary().elements()).toEqual([]);
    expect(page.getByRole("list", { name: "Keyboard shortcuts" }).elements()).toEqual([]);
  });

  test("at 1440 wide: the list and the summary side by side", async () => {
    await page.viewport(1440, 900);
    installFakeApi();
    renderApp(ERRORS);

    await expect.element(list().getByRole("link", { name: /^TypeError/ })).toBeVisible();
    await expect.element(summary()).toBeVisible();
    expectNoSidewaysScroll(1440);
    expect(list().element().getBoundingClientRect().right).toBeLessThanOrEqual(
      summary().element().getBoundingClientRect().left,
    );
  });
});

describe("the errors workbench, after review", () => {
  test("at 1440 the latest occurrences fit the detail pane, every column in view", async () => {
    await page.viewport(1440, 900);
    installFakeApi();
    renderApp(`${ERRORS}?error=${typeError}`);

    const table = detail().getByRole("table", { name: "Latest occurrences, newest first" });
    await expect.element(table).toBeVisible();
    const container = table.element().closest<HTMLElement>("[data-slot=table-container]");
    expect(container).not.toBeNull();
    expect(container?.scrollWidth).toBeLessThanOrEqual(container?.clientWidth ?? 0);
    // The pane is narrow: each occurrence stacks, its release and replay in view.
    await expect.element(table.getByText("1.4.2", { exact: true })).toBeVisible();
    await expect.element(table.getByText("No replay").first()).toBeVisible();
  });

  test("a list cut at 1,000 says its figures are at least these, and ranks the latest", async () => {
    installFakeApi({
      errors: (query, api) => ({ ...fakeErrors(query, api), truncated: true }),
    });
    renderApp(ERRORS);

    await expect.element(summary()).toBeVisible();
    expect(figure("Unresolved")).toBe("2+");
    expect(figure("Regressed")).toBe("1+");
    await expect
      .element(summary().getByText(/these figures count the 1,000 seen most recently/))
      .toBeVisible();
    await expect
      .element(summary().getByText(/most known users first, among the 1,000 seen most recently/))
      .toBeVisible();
  });

  test("the resolved list sums up only resolved groups", async () => {
    installFakeApi();
    renderApp(`${ERRORS}?status=resolved`);

    await expect.element(summary()).toBeVisible();
    const labels = [...summary().element().querySelectorAll("dt")].map((dt) => dt.textContent);
    expect(labels).toEqual(["Resolved", "New"]);
    expect(figure("Resolved")).toBe("1");
  });

  test("after e takes the error out of the list, j moves on to the next one", async () => {
    const extra = "4-0123456789abcdef0123";
    const api = installFakeApi({
      errors: (query, fake) => {
        const listed = fakeErrors(query, fake);
        const [first] = listed.groups;
        // A third unresolved group, after the two the fixtures have.
        return listed.status === "unresolved" && first !== undefined
          ? {
              ...listed,
              groups: [
                ...listed.groups,
                { ...first, fingerprint: extra, type: "RangeError", message: "Invalid date" },
              ],
            }
          : listed;
      },
    });
    const router = renderApp(ERRORS);
    await expect.element(summary()).toBeVisible();

    await userEvent.keyboard("j");
    await userEvent.keyboard("j");
    await expect.poll(() => selectedParam(router)).toBe(referenceError);
    await expect.element(detail().getByRole("button", { name: "Resolve" })).toBeVisible();
    await userEvent.keyboard("e");
    await expect.poll(() => api.bodies.at(-1)?.body).toEqual({ status: "resolved" });
    // Resolved, it leaves the Unresolved list.
    await expect
      .poll(() => document.querySelector(`[data-workbench-id="${referenceError}"]`))
      .toBeNull();

    await userEvent.keyboard("j");
    await expect.poll(() => selectedParam(router)).toBe(extra);
  });

  test("a name chosen in the summary takes focus to its row", async () => {
    installFakeApi();
    const router = renderApp(ERRORS);

    await summary().getByRole("link", { name: "TypeError" }).click();
    await expect.poll(() => selectedParam(router)).toBe(typeError);
    await expect
      .poll(() =>
        document.activeElement?.closest("[data-workbench-id]")?.getAttribute("data-workbench-id"),
      )
      .toBe(typeError);
  });

  test("an error with no occurrence in the period keeps its links on the list", async () => {
    installFakeApi();
    const missing = "9-0123456789abcdef0123";
    const router = renderApp(`${ERRORS}?period=30d&error=${missing}`);

    await expect.element(detail().getByText("No occurrence in this period")).toBeVisible();
    await detail().getByRole("link", { name: "Show the last 12 months" }).click();
    await expect
      .poll(() => router.state.location.search)
      .toEqual({ period: "12m", error: missing });
    expect(router.state.location.pathname).toBe(ERRORS);

    await detail().getByRole("link", { name: "All errors" }).click();
    await expect.poll(() => router.state.location.search).toEqual({ period: "12m" });
    expect(router.state.location.pathname).toBe(ERRORS);
  });

  test("e does nothing, and is not offered, without the right to resolve", async () => {
    const api = installFakeApi({ access: memberAccess({ errors: "view" }) });
    const router = renderApp(ERRORS);
    await expect
      .element(page.getByRole("list", { name: "Keyboard shortcuts" }))
      .toHaveTextContent("jkmoveEscclear");

    await userEvent.keyboard("j");
    await expect.poll(() => selectedParam(router)).toBe(typeError);
    await expect.element(detail().getByRole("heading", { name: "TypeError" })).toBeVisible();
    expect(detail().getByRole("button", { name: "Resolve" }).elements()).toEqual([]);
    await userEvent.keyboard("e");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(api.bodies).toEqual([]);
  });

  test("e typed in a text field is text, not a resolve", async () => {
    const api = installFakeApi();
    const router = renderApp(`${ERRORS}?error=${typeError}`);
    await expect.element(detail().getByRole("button", { name: "Resolve" })).toBeVisible();

    const field = document.createElement("input");
    field.setAttribute("aria-label", "A text field");
    document.body.append(field);
    try {
      field.focus();
      await expect.element(page.getByRole("textbox", { name: "A text field" })).toHaveFocus();
      await userEvent.keyboard("ejk");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(field.value).toBe("ejk");
      expect(api.bodies).toEqual([]);
      expect(selectedParam(router)).toBe(typeError);
    } finally {
      field.remove();
    }
  });
});
