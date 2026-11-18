import { describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import {
  type FakeApi,
  fakeHostCharts,
  fakeHosts,
  installFakeApi,
  noHosts,
  PROJECT,
} from "./fake-api.ts";
import { renderApp } from "./render.tsx";

const HOSTS = `/projects/${PROJECT.id}/hosts`;

/** The query of the latest GET request to a path ending in `path`. */
function lastQuery(api: FakeApi, path: string): Record<string, string> {
  const request = api.requests.findLast((item) => item.split("?")[0]?.endsWith(path)) ?? "";
  const at = request.indexOf("?");
  return at === -1 ? {} : Object.fromEntries(new URLSearchParams(request.slice(at + 1)));
}

const sidebarLink = (name: string) =>
  page.getByRole("navigation", { name: "Project" }).getByRole("link", { name });

const cellsOf = (row: Element | undefined) =>
  [...(row?.querySelectorAll("td") ?? [])].map((cell) => cell.textContent);

/** The legend entries of the card titled `title`. */
const legendOf = (title: string) => {
  const card = page.getByRole("heading", { name: title }).element().closest("[data-slot=card]");
  return [...(card?.querySelectorAll("ul[aria-label=Legend] li") ?? [])].map(
    (item) => item.textContent,
  );
};

/** The y-axis labels of the card titled `title`: right-aligned, left of the plot. */
const axisOf = (title: string) => {
  const card = page.getByRole("heading", { name: title }).element().closest("[data-slot=card]");
  return [...(card?.querySelectorAll("svg text[text-anchor=end]") ?? [])]
    .filter((text) => Number(text.getAttribute("x")) < 100)
    .map((text) => text.textContent);
};

describe("the hosts page", () => {
  test("opens from the sidebar with each host's latest values and whether it is stale", async () => {
    const api = installFakeApi();
    const router = renderApp(`/projects/${PROJECT.id}/services`);
    await sidebarLink("Hosts").click();

    await expect.poll(() => router.state.location.pathname).toBe(HOSTS);
    const table = page.getByRole("table", { name: "Hosts, by name" });
    await expect.element(table).toBeVisible();
    expect(lastQuery(api, "/hosts")).toEqual({ period: "7d" });
    await expect.element(sidebarLink("Hosts")).toHaveAttribute("data-active");
    const rows = [...table.element().querySelectorAll("tbody tr")];
    expect(rows.map(cellsOf)).toEqual([
      ["db-1", "16 Nov 2026, 16:10:00.000Stale", "25%", "80%", "42% (/)", "2"],
      ["web-1", "16 Nov 2026, 16:19:00.000Reporting", "22.5%", "50%", "90% (/data)", "–"],
    ]);
    // Stale is said in words, with the badge's icon, not by color alone.
    await expect
      .element(page.getByText(/Stale: nothing arrived from the host in the last 5 minutes/))
      .toBeVisible();
    // A value not sent is a dash with a name.
    await expect.element(page.getByLabelText("Not sent")).toBeVisible();
  });

  test("shows a Collector's configuration while the project has sent no host metrics, without the secret key", async () => {
    installFakeApi({ hosts: noHosts });
    renderApp(HOSTS);

    await expect.element(page.getByText("No hosts yet")).toBeVisible();
    const config = document.querySelector("pre")?.textContent ?? "";
    for (const part of [
      "host_metrics:",
      "      cpu:",
      "      memory:",
      "      filesystem:",
      "      network:",
      "      disk:",
      "      load:",
      "detectors: [system]",
      "batch:",
      "otlp_http:",
      `endpoint: ${window.location.origin}`,
      "Authorization: Bearer sk_…",
      "processors: [resource_detection, batch]",
    ]) {
      expect(config).toContain(part);
    }
    expect(document.body.textContent).not.toContain(PROJECT.secretKey);
    await expect.element(page.getByRole("link", { name: "Project settings" })).toBeVisible();
    expect(page.getByRole("table").elements()).toEqual([]);
  });

  test("says when no host sent metrics in the period", async () => {
    installFakeApi({ hosts: (query) => ({ ...noHosts(query), received: true }) });
    renderApp(`${HOSTS}?env=staging`);
    await expect.element(page.getByText("No hosts in this period")).toBeVisible();
    await expect.element(page.getByText(/No host metrics arrived in staging/)).toBeVisible();
  });
});

describe("a host's page", () => {
  test("opens from the list with the period kept, and charts the host", async () => {
    const api = installFakeApi();
    const router = renderApp(`${HOSTS}?period=30d`);
    await page.getByRole("link", { name: "web-1" }).click();

    await expect.poll(() => router.state.location.pathname).toBe(`${HOSTS}/web-1`);
    expect(router.state.location.search).toEqual({ period: "30d" });
    await expect.element(page.getByRole("heading", { name: "CPU busy (%)" })).toBeVisible();
    expect(lastQuery(api, "/hosts/charts")).toEqual({ period: "30d", host: "web-1" });
    await expect.element(sidebarLink("Hosts")).toHaveAttribute("data-active");
    await expect.element(page.getByText("Reporting")).toBeVisible();

    const titles = [...document.querySelectorAll("[data-slot=card] h3")].map((h) => h.textContent);
    expect(titles).toEqual([
      "CPU busy (%)",
      "CPU time by state (%)",
      "Memory used (%)",
      "Memory used (bytes)",
      "Filesystem used by mount point (%)",
      "Network (bytes per second)",
      "Disk I/O (bytes per second)",
      "Load average",
    ]);
    // Percentages always run from 0 to 100.
    expect(axisOf("CPU busy (%)")).toEqual(["0%", "50%", "100%"]);
    // One line: no legend. Several: a legend, in the API's order, named in words.
    expect(legendOf("CPU busy (%)")).toEqual([]);
    expect(legendOf("CPU time by state (%)")).toEqual(["idle", "user", "system"]);
    expect(legendOf("Network (bytes per second)")).toEqual(["Sent", "Received"]);
    expect(legendOf("Filesystem used by mount point (%)")).toEqual(["/", "/data"]);
    expect(legendOf("Load average")).toEqual(["1 minute", "5 minutes"]);
    await expect
      .element(page.getByText("This host sent no system.disk.io in this period."))
      .toBeVisible();
    await expect
      .element(page.getByText(/The share of CPU time not idle, .* from system.cpu.time\./))
      .toBeVisible();

    // The keyboard reads the latest bucket, 19:00 in Singapore: 2,048 + 11 and 1,024 + 11 bytes.
    await expect
      .element(page.getByRole("slider", { name: "Network (bytes per second), web-1, per hour" }))
      .toHaveAttribute(
        "aria-valuetext",
        "Mon 16 Nov 2026, 19:00–20:00: Sent 2.01 KiB/s, Received 1.01 KiB/s",
      );
  });

  test("shows a chart's numbers as a table", async () => {
    installFakeApi();
    renderApp(`${HOSTS}/web-1`);
    await expect.element(page.getByRole("heading", { name: "Memory used (bytes)" })).toBeVisible();
    const card = page
      .getByRole("heading", { name: "Memory used (bytes)" })
      .element()
      .closest("[data-slot=card]");
    const button = [...(card?.querySelectorAll("button") ?? [])].find(
      (item) => item.textContent === "Show the numbers",
    );
    button?.click();
    const table = page.getByRole("table", { name: "Memory used (bytes)" });
    await expect.element(table).toBeVisible();
    const rows = [...table.element().querySelectorAll("tbody tr")];
    // 11 buckets with a value: the 4th has none.
    expect(rows).toHaveLength(11);
    expect(rows[0]?.textContent).toBe("Mon 16 Nov 2026, 08:00–09:004 GiB");
  });

  test("says when the host is stale", async () => {
    installFakeApi();
    renderApp(`${HOSTS}/db-1`);
    await expect.element(page.getByRole("heading", { name: "db-1" })).toBeVisible();
    await expect.element(page.getByText("Stale", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText("Nothing arrived from it in the last 5 minutes."))
      .toBeVisible();
  });

  test("says when the host sent nothing in the period", async () => {
    installFakeApi({
      hostCharts: (query) => ({
        ...fakeHostCharts(query),
        lastSeen: null,
        stale: true,
        charts: fakeHostCharts(query).charts.map((chart) => ({ ...chart, lines: [] })),
      }),
    });
    renderApp(`${HOSTS}/gone-1`);
    await expect
      .element(page.getByText("No host metrics from this host in this period"))
      .toBeVisible();
  });

  test("says nothing of staleness for a period that ended before now", async () => {
    installFakeApi({
      hosts: (query) => ({
        ...fakeHosts(query),
        hosts: fakeHosts(query).hosts.map((host) => ({ ...host, stale: null })),
      }),
    });
    renderApp(`${HOSTS}?from=2026-11-01&to=2026-11-02`);
    const table = page.getByRole("table", { name: "Hosts, by name" });
    await expect.element(table).toBeVisible();
    expect(cellsOf(table.element().querySelector("tbody tr") ?? undefined)[1]).toBe(
      "16 Nov 2026, 16:10:00.000",
    );
    expect(table.element().querySelector("[data-slot=status-badge]")).toBeNull();
  });

  test("never shows another host's charts while a host loads", async () => {
    let failing = false;
    installFakeApi({
      hostCharts: (query) =>
        failing
          ? new Response(JSON.stringify({ error: "reports_busy", message: "Busy." }), {
              status: 503,
            })
          : fakeHostCharts(query),
    });
    const router = renderApp(`${HOSTS}/web-1`);
    await expect.element(page.getByRole("heading", { name: "CPU busy (%)" })).toBeVisible();
    failing = true;
    await router.navigate({
      to: "/projects/$projectId/hosts/$host",
      params: { projectId: PROJECT.id, host: "db-1" },
    });
    // Not "could not refresh" over web-1's charts: db-1's never loaded.
    await expect.element(page.getByText("The host could not load")).toBeVisible();
    await expect
      .element(page.getByRole("heading", { name: "CPU busy (%)" }))
      .not.toBeInTheDocument();
  });

  test("says when the charts fail to load, with a retry", async () => {
    let fail = true;
    const api = installFakeApi({
      hostCharts: (query) =>
        fail
          ? new Response(
              JSON.stringify({ error: "query_timeout", message: "This took too long." }),
              { status: 503 },
            )
          : fakeHostCharts(query),
    });
    renderApp(`${HOSTS}/web-1`);
    await expect.element(page.getByText("The host could not load")).toBeVisible();
    // A 503 says the API is busy: the page asks once and offers Retry, not more requests.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(api.requests.filter((path) => path.includes("/hosts/charts"))).toHaveLength(1);
    fail = false;
    await page.getByRole("button", { name: "Retry" }).click();
    await expect.element(page.getByRole("heading", { name: "CPU busy (%)" })).toBeVisible();
  });
});
