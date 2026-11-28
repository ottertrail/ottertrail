import { beforeEach, describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import { clickAt, hoverAt, leave, plotPoint, tapAt, tooltipOf } from "./chart-pointer.ts";
import { fakeAnnotations } from "./fake-annotations.ts";
import { FAKE_SHARE_TOKEN, installFakeApi, memberAccess, PROJECT } from "./fake-api.ts";
import { renderApp, renderShare } from "./render.tsx";

/*
 * Notes and release marks on the Web analytics chart (docs/web-analytics.md,
 * "Notes and releases on the chart"). The fake week runs from Tue 10 Nov to
 * Mon 16 Nov: a note on the 12th (point 2), a release on the 13th (3), and a
 * note and a release on the 15th (5).
 */

const ANALYTICS = `/projects/${PROJECT.id}/web-analytics`;

beforeEach(async () => {
  window.localStorage.removeItem("ottertrail.chart-marks.hidden");
  await page.viewport(1280, 900);
});

const chartElement = () => {
  const chart = document.querySelector("[data-slot=day-chart]");
  if (chart === null) throw new Error("The chart is missing");
  return chart;
};

/** Each drawn mark: its point, its notes and releases, and whether its line is dashed. */
const marks = () =>
  [...document.querySelectorAll("[data-slot=chart-marks] [data-mark-index]")].map((mark) => ({
    index: Number(mark.getAttribute("data-mark-index")),
    notes: Number(mark.getAttribute("data-notes")),
    releases: Number(mark.getAttribute("data-releases")),
    dashed: mark.querySelector("line")?.getAttribute("stroke-dasharray") === "3 3",
  }));

const DRAWN = [
  { index: 2, notes: 1, releases: 0, dashed: false },
  { index: 3, notes: 0, releases: 1, dashed: true },
  { index: 5, notes: 1, releases: 1, dashed: false },
];

async function openWithMarks(overrides: Parameters<typeof installFakeApi>[0] = {}) {
  const api = installFakeApi({ annotations: fakeAnnotations(), ...overrides });
  renderApp(ANALYTICS);
  await expect.element(page.getByRole("slider", { name: "Visitors per day" })).toBeInTheDocument();
  await expect.poll(marks).toEqual(DRAWN);
  return api;
}

/** `index` of the chart's 7 points, as a share of the plot. */
const at = (index: number) => index / 6;

describe("marks on the chart", () => {
  test("draw notes solid with a circle, and releases dashed with a diamond, for the range", async () => {
    const api = await openWithMarks();
    expect(api.annotations.requests.map((request) => request.path).toSorted()).toEqual([
      `/api/projects/${PROJECT.id}/annotations?from=2026-11-10&to=2026-11-16&environment=production`,
      `/api/projects/${PROJECT.id}/release-marks?from=2026-11-10&to=2026-11-16&environment=production`,
    ]);
    const both = document.querySelector('[data-mark-index="5"]');
    expect(both?.querySelector("circle")).not.toBeNull();
    expect(both?.querySelector("path")).not.toBeNull();
    // Two on one point show their count.
    expect(both?.querySelector("text")?.textContent).toBe("2");
    // Under the lines: the marks come before the areas in the drawing.
    const layer = document.querySelector("[data-slot=chart-marks]");
    const area = chartElement().querySelector(".recharts-area");
    expect(
      layer !== null &&
        area !== null &&
        Boolean(layer.compareDocumentPosition(area) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
  });

  test("show each point's notes and releases under the pointer", async () => {
    await openWithMarks();
    const chart = chartElement();
    expect(await hoverAt(chart, at(2))).toContain(
      "Launched the pricing page Ada Owner · Thu 12 Nov",
    );
    const both = await hoverAt(chart, at(5));
    expect(both).toContain("Newsletter sent Mark Eting · Sun 15 Nov, 09:30");
    expect(both).toContain("Release 1.5.0 first seen Sun 15 Nov, 14:00");
    expect(await hoverAt(chart, at(4))).not.toContain("Release");
  });

  test("read them out from the keyboard, and list them in the table", async () => {
    await openWithMarks();
    const slider = page.getByRole("slider", { name: "Visitors per day" });
    slider.element().focus();
    await userEvent.keyboard("{ArrowLeft}");
    await expect
      .element(slider)
      .toHaveAttribute(
        "aria-valuetext",
        "Sun 15 Nov: 103 Visitors, 95 Visitors, previous period, 110 Visits, 239 Pageviews. " +
          "Note: Newsletter sent (Mark Eting · Sun 15 Nov, 09:30). " +
          "Release 1.5.0, first seen Sun 15 Nov, 14:00",
      );
    // The tooltip shows the focused point's marks too.
    await expect.poll(() => tooltipOf(chartElement())?.textContent).toContain("Newsletter sent");

    await page.getByRole("button", { name: "Show the numbers" }).click();
    const table = document.querySelector("table");
    expect([...(table?.tHead?.rows[0]?.cells ?? [])].at(-1)?.textContent).toBe(
      "Notes and releases",
    );
    const cells = [...(table?.tBodies[0]?.rows ?? [])].map(
      (row) => row.cells[row.cells.length - 1]?.textContent,
    );
    expect(cells).toEqual([
      "",
      "",
      "Launched the pricing page Ada Owner · Thu 12 Nov",
      "Release 1.4.2 first seen Fri 13 Nov, 10:00",
      "",
      "Newsletter sent Mark Eting · Sun 15 Nov, 09:30Release 1.5.0 first seen Sun 15 Nov, 14:00",
      "",
    ]);
  });

  test("hide and show each kind, remembered in this browser", async () => {
    const api = await openWithMarks();
    await page.getByRole("button", { name: "Show notes" }).click();
    await expect.poll(marks).toEqual([
      { index: 3, notes: 0, releases: 1, dashed: true },
      { index: 5, notes: 0, releases: 1, dashed: true },
    ]);
    await expect
      .element(page.getByRole("button", { name: "Show notes" }))
      .toHaveAttribute("aria-pressed", "false");
    await page.getByRole("button", { name: "Show releases" }).click();
    await expect.poll(marks).toEqual([]);
    expect(window.localStorage.getItem("ottertrail.chart-marks.hidden")).toBe("notes,releases");

    // Hidden kinds are not read on the next visit.
    document.body.innerHTML = "";
    api.annotations.requests = [];
    renderApp(ANALYTICS);
    await expect
      .element(page.getByRole("button", { name: "Show releases" }))
      .toHaveAttribute("aria-pressed", "false");
    expect(marks()).toEqual([]);
    expect(api.annotations.requests).toEqual([]);
    await page.getByRole("button", { name: "Show notes" }).click();
    await expect.poll(marks).toEqual([
      { index: 2, notes: 1, releases: 0, dashed: false },
      { index: 5, notes: 1, releases: 0, dashed: false },
    ]);
  });
});

describe("notes", () => {
  test("are added from the Add note button, on the last day", async () => {
    const api = await openWithMarks();
    await page.getByRole("button", { name: "Add note" }).click();
    const dialog = page.getByRole("dialog", { name: "Add a note" });
    await expect.element(dialog).toBeVisible();
    await expect.element(dialog.getByText("Mon 16 Nov")).toBeVisible();
    await dialog.getByRole("button", { name: "Add note" }).click();
    await expect.element(dialog.getByText("Write the note.")).toBeVisible();

    await dialog.getByLabelText("Note").fill("Price change");
    await dialog.getByRole("checkbox", { name: "Show in every environment" }).click();
    await dialog.getByRole("button", { name: "Add note" }).click();

    await expect.element(dialog).not.toBeInTheDocument();
    expect(api.annotations.requests.find((request) => request.method === "POST")?.body).toEqual({
      day: "2026-11-16",
      time: null,
      text: "Price change",
      environment: "production",
    });
    await expect.poll(marks).toContainEqual({ index: 6, notes: 1, releases: 0, dashed: false });
  });

  test("are listed, changed, and deleted from a point of the chart", async () => {
    const api = await openWithMarks();
    await clickAt(chartElement(), plotPoint(chartElement(), at(5)));
    const dialog = page.getByRole("dialog", { name: "Notes" });
    await expect.element(dialog).toBeVisible();
    await expect.element(dialog.getByText("Release 1.5.0")).toBeVisible();

    await dialog.getByRole("button", { name: "Edit the note Newsletter sent" }).click();
    const edit = page.getByRole("dialog", { name: "Edit the note" });
    await expect.element(edit.getByLabelText("Note")).toHaveValue("Newsletter sent");
    await expect.element(edit.getByLabelText("Time (optional)")).toHaveValue("09:30");
    await edit.getByLabelText("Note").fill("Newsletter sent to 4,000 people");
    await edit.getByRole("button", { name: "Save note" }).click();
    await expect.element(dialog.getByText("Newsletter sent to 4,000 people")).toBeVisible();
    const put = api.annotations.requests.find((request) => request.method === "PUT");
    expect(put?.body).toEqual({
      day: "2026-11-15",
      time: "09:30",
      text: "Newsletter sent to 4,000 people",
      environment: null,
    });

    await dialog
      .getByRole("button", { name: "Delete the note Newsletter sent to 4,000 people" })
      .click();
    await dialog.getByRole("button", { name: "Delete note" }).click();
    await expect
      .element(dialog.getByText("Newsletter sent to 4,000 people"))
      .not.toBeInTheDocument();
    expect(api.annotations.requests.some((request) => request.method === "DELETE")).toBe(true);
    await userEvent.keyboard("{Escape}");
    await expect.poll(marks).toContainEqual({ index: 5, notes: 0, releases: 1, dashed: true });
  });

  test("open the form from Enter on a point without marks", async () => {
    await openWithMarks();
    const slider = page.getByRole("slider", { name: "Visitors per day" });
    slider.element().focus();
    await userEvent.keyboard("{Home}{Enter}");
    const dialog = page.getByRole("dialog", { name: "Add a note" });
    await expect.element(dialog.getByText("Tue 10 Nov")).toBeVisible();
  });

  test("are read-only without product analytics at manage", async () => {
    const api = await openWithMarks({
      access: memberAccess({ web_analytics: "view", product_analytics: "view" }),
    });
    await expect.element(page.getByRole("button", { name: "Show notes" })).toBeVisible();
    expect(page.getByRole("button", { name: "Add note" }).query()).toBeNull();
    await clickAt(chartElement(), plotPoint(chartElement(), at(5)));
    leave(chartElement());
    await expect.poll(() => tooltipOf(chartElement())).toBeNull();
    expect(await hoverAt(chartElement(), at(2))).toContain("Launched the pricing page");
    expect(page.getByRole("dialog").query()).toBeNull();
    expect(api.annotations.requests.every((request) => request.method === "GET")).toBe(true);
  });
});

describe("on a phone", () => {
  test("the controls wrap, the marks draw, and a tap shows the tooltip without the form", async () => {
    await page.viewport(390, 844);
    await openWithMarks();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    await expect.element(page.getByRole("button", { name: "Add note" })).toBeVisible();
    await tapAt(chartElement(), plotPoint(chartElement(), at(5)));
    await expect.poll(() => tooltipOf(chartElement())?.textContent).toContain("Release 1.5.0");
    expect(page.getByRole("dialog").query()).toBeNull();
  });
});

describe("a shared link", () => {
  test("shows no notes or releases, and never asks for them", async () => {
    const api = installFakeApi({ signedIn: false, annotations: fakeAnnotations() });
    renderShare(`/share/${FAKE_SHARE_TOKEN}`);
    await expect
      .element(page.getByRole("slider", { name: "Visitors per day" }))
      .toBeInTheDocument();
    expect(page.getByRole("button", { name: "Show notes" }).query()).toBeNull();
    expect(document.querySelector("[data-slot=chart-marks]")).toBeNull();
    expect(api.annotations.requests).toEqual([]);
  });
});
