import { afterEach, describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import {
  ERROR_FINGERPRINTS,
  fakeAssignments,
  installFakeApi,
  memberAccess,
  PROJECT,
} from "./fake-api.ts";
import { currentPath, renderApp } from "./render.tsx";

/*
 * Assigning error groups (docs/errors.md, "Assignment"): the assignee on
 * the list's rows, the Everyone, Assigned to me and Unassigned filter, and
 * the Assignee field with "Assign to me" on the error's page and in the
 * workbench's detail.
 */

const ERRORS = `/projects/${PROJECT.id}/errors`;
const { typeError, referenceError } = ERROR_FINGERPRINTS;

afterEach(async () => {
  await page.viewport(1280, 900);
});

const rowOf = (fingerprint: string) =>
  document.querySelector<HTMLElement>(`[data-workbench-id="${fingerprint}"]`);

describe("the errors list", () => {
  test("shows each row's assignee, by initials and name", async () => {
    installFakeApi({ assignments: fakeAssignments() });
    renderApp(ERRORS);
    await expect.element(page.getByText("Ada Admin")).toBeVisible();
    const row = rowOf(typeError);
    expect(row?.querySelector("[data-slot=avatar]")?.textContent).toBe("AA");
    expect(row?.textContent).toContain("Assigned to Ada Admin");
    expect(rowOf(referenceError)?.querySelector("[data-slot=avatar]")).toBeNull();
  });

  test("filters by assignee, kept in the address with the other filters", async () => {
    const api = installFakeApi();
    api.assignments = { [referenceError]: { id: "user-1", name: "Test Owner", avatarUrl: null } };
    const router = renderApp(`${ERRORS}?period=30d`);
    await expect.element(page.getByRole("group", { name: "Assignee" })).toBeVisible();
    await page.getByRole("button", { name: "Assigned to me" }).click();
    await expect.poll(() => currentPath(router)).toBe(`${ERRORS}?period=30d&assignee=me`);
    await expect.poll(() => rowOf(referenceError) !== null && rowOf(typeError) === null).toBe(true);
    expect(api.requests.at(-1)).toContain("assignee=me");

    await page.getByRole("button", { name: "Unassigned" }).click();
    await expect.poll(() => currentPath(router)).toBe(`${ERRORS}?period=30d&assignee=none`);
    await expect.poll(() => rowOf(typeError) !== null && rowOf(referenceError) === null).toBe(true);

    await page.getByRole("button", { name: "Everyone" }).click();
    await expect.poll(() => currentPath(router)).toBe(`${ERRORS}?period=30d`);
  });

  test("an empty filter says so", async () => {
    installFakeApi();
    renderApp(`${ERRORS}?assignee=me`);
    await expect
      .element(page.getByText("No errors assigned to you in this period").first())
      .toBeVisible();
  });
});

describe("the Assignee field", () => {
  test("chooses anyone who sees the errors, or Unassigned, on the error's page", async () => {
    const api = installFakeApi({ assignments: fakeAssignments() });
    renderApp(`${ERRORS}/${typeError}`);
    const field = page.getByRole("combobox", { name: "Assignee" });
    await expect.element(field).toHaveValue("Ada Admin");
    await page.getByRole("button", { name: "Show people" }).click();
    const options = page.getByRole("option");
    await expect.element(options.first()).toBeVisible();
    expect(options.elements().map((option) => option.textContent)).toEqual([
      "Unassigned",
      "AAAda Admin",
      "MMMia Member",
      "TOTest Owner",
    ]);
    await page.getByRole("option", { name: "Mia Member" }).click();
    await expect.poll(() => api.assignments[typeError]?.name).toBe("Mia Member");
    await expect.element(field).toHaveValue("Mia Member");
    expect(api.bodies.at(-1)).toEqual({
      method: "PUT",
      path: `/api/projects/${PROJECT.id}/errors/${typeError}/assignee`,
      body: { assignee: "user-3" },
    });

    await page.getByRole("button", { name: "Show people" }).click();
    await page.getByRole("option", { name: "Unassigned" }).click();
    await expect.poll(() => api.assignments[typeError]).toBeUndefined();
    await expect.element(field).toHaveValue("Unassigned");
  });

  test("Assign to me, in the workbench's detail, then gone once it is mine", async () => {
    const api = installFakeApi();
    renderApp(`${ERRORS}?error=${referenceError}`);
    const detail = page.getByRole("region", { name: "Errors, selected" });
    await expect
      .element(detail.getByRole("combobox", { name: "Assignee" }))
      .toHaveValue("Unassigned");
    await detail.getByRole("button", { name: "Assign to me" }).click();
    await expect.poll(() => api.assignments[referenceError]?.id).toBe("user-1");
    await expect
      .element(detail.getByRole("combobox", { name: "Assignee" }))
      .toHaveValue("Test Owner");
    await expect
      .element(detail.getByRole("button", { name: "Assign to me" }))
      .not.toBeInTheDocument();
    // The list's row shows it too.
    await expect.poll(() => rowOf(referenceError)?.textContent).toContain("Assigned to Test Owner");
  });

  test("by keyboard: type to filter, Enter to choose", async () => {
    const api = installFakeApi();
    renderApp(`${ERRORS}/${referenceError}`);
    const field = page.getByRole("combobox", { name: "Assignee" });
    await field.fill("mia");
    await expect.element(page.getByRole("option", { name: "Mia Member" })).toBeVisible();
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => api.assignments[referenceError]?.id).toBe("user-3");
  });

  test("a member who views errors sees the assignee, without the field", async () => {
    const api = installFakeApi({
      access: memberAccess({ errors: "view" }),
      assignments: fakeAssignments(),
    });
    renderApp(`${ERRORS}/${typeError}`);
    await expect.element(page.getByText("Ada Admin")).toBeVisible();
    await expect.element(page.getByRole("combobox", { name: "Assignee" })).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Assign to me" }))
      .not.toBeInTheDocument();
    expect(api.requests.some((path) => path.includes("error-assignees"))).toBe(false);
  });

  test("fits a phone", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    renderApp(`${ERRORS}/${typeError}`);
    await expect.element(page.getByRole("combobox", { name: "Assignee" })).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  });
});
