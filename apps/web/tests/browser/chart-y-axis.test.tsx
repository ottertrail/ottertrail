import { afterEach, describe, expect, test } from "vite-plus/test";
import { commands, page } from "vite-plus/test/browser/context";

import { emulateColorScheme } from "./color-scheme.ts";
import { installFakeApi, PROJECT } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

async function emulateReducedMotion(reduce: boolean) {
  const command: unknown = Reflect.get(commands, "emulateReducedMotion");
  if (typeof command !== "function") {
    throw new TypeError("The emulateReducedMotion command is missing from vite.config.ts");
  }
  await command.call(commands, reduce);
}

/** The chart that shows: the metric tabs keep the others hidden. */
const shownChart = (slot: string) =>
  [...document.querySelectorAll<HTMLElement>(`[data-slot=${slot}]`)].find(
    (chart) => chart.offsetParent !== null,
  );

/** Each label of the chart's y axis, and how far its text starts inside the chart's SVG. */
function yLabels(slot: string): { text: string | null; inside: number }[] {
  const svg = shownChart(slot)?.querySelector("svg.recharts-surface");
  if (svg === null || svg === undefined) return [];
  const left = svg.getBoundingClientRect().left;
  return [...svg.querySelectorAll(".recharts-yAxis-tick-labels text")].map((text) => ({
    text: text.textContent,
    inside: Math.floor(text.getBoundingClientRect().left - left),
  }));
}

const xLabels = (slot: string) =>
  [...(shownChart(slot)?.querySelectorAll("svg .recharts-xAxis-tick-labels text") ?? [])].map(
    (text) => text.textContent,
  );

/** Long enough for a late measurement, such as the web font's, to have moved the axes. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 1000));

const TEAM_SIGNUP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";

afterEach(async () => {
  await emulateReducedMotion(false);
});

// Recharts measures labels differently with motion reduced, where both bugs showed every time.
describe("a chart's x axis", () => {
  test.each([
    ["", "/web-analytics"],
    [" beside a narrow y axis (a goal's small counts)", `/web-analytics?goal=${TEAM_SIGNUP}`],
  ])(
    "names the first day under the Web analytics chart%s, with motion reduced",
    async (_name, path) => {
      await emulateColorScheme("dark");
      await emulateReducedMotion(true);
      await page.viewport(1440, 1000);
      installFakeApi();
      renderApp(`/projects/${PROJECT.id}${path}`);
      await expect.element(page.getByRole("slider").first()).toBeInTheDocument();
      await settle();
      expect(xLabels("day-chart")).toEqual([
        "10 Nov",
        "11 Nov",
        "12 Nov",
        "13 Nov",
        "14 Nov",
        "15 Nov",
        "16 Nov",
      ]);
    },
  );
});

describe("a chart's y axis", () => {
  test.each([
    ["the Web analytics chart", "day-chart", `/projects/${PROJECT.id}/web-analytics`],
    ["the Logs chart", "stacked-bar-chart", `/projects/${PROJECT.id}/logs`],
  ])("keeps its labels whole inside %s, with motion reduced too", async (_name, slot, path) => {
    for (const reduce of [false, true]) {
      await emulateReducedMotion(reduce);
      await page.viewport(1440, 1000);
      installFakeApi();
      renderApp(path);
      await expect.element(page.getByRole("slider").first()).toBeInTheDocument();
      await settle();
      const labels = yLabels(slot);
      expect(labels.length).toBeGreaterThan(1);
      for (const label of labels) {
        expect({ reduce, ...label, whole: label.inside >= 0 }).toMatchObject({ whole: true });
      }
    }
  });
});
