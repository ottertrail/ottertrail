import { afterEach, describe, expect, test } from "vite-plus/test";
import { type Locator, page, userEvent } from "vite-plus/test/browser/context";

import {
  ALERT_RULE_IDS,
  FAKE_SPANS,
  FAKE_TRACE_ID,
  type FakeApi,
  fakeChecks,
  fakeReplayId,
  fakeUser,
  installFakeApi,
  PROJECT,
} from "./fake-api.ts";
import { renderApp } from "./render.tsx";

/*
 * The lists as workbenches (docs/design-system.md, "Workbench"): Replays,
 * Traces, Logs, Users, Uptime, and Alerts. For each: the summary while
 * nothing is selected, the selection in the address, the keys and where
 * focus goes, j after the selected item leaves the list, links in the
 * detail that stay on the workbench, the item's own page on a narrow
 * screen, and the fit at 390 and 1440. The screens' own tests cover what
 * each list and detail show.
 */

const P = `/projects/${PROJECT.id}`;
type Router = ReturnType<typeof renderApp>;

afterEach(async () => {
  await page.viewport(1280, 900);
});

const region = (label: string, part: "list" | "summary" | "selected" | "overview") =>
  page.getByRole("region", { name: `${label}, ${part}` });
const param = (router: Router, name: string) =>
  (router.state.location.search as Record<string, unknown>)[name];
const rowOf = (id: string) => document.querySelector(`[data-workbench-id="${CSS.escape(id)}"]`);
const focusedRow = () =>
  document.activeElement?.closest("[data-workbench-id]")?.getAttribute("data-workbench-id");
/** Waits long enough for a key's effect to show, before asserting it had none. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

/** A figure in the summary's stat strip, by its label. */
function figure(label: string, scope: Element): string | null | undefined {
  const term = [...scope.querySelectorAll("dt")].find((dt) => dt.textContent === label);
  return term?.nextElementSibling?.textContent;
}

/** Leaves any text field, as a click elsewhere would, so the keys act again. */
function leaveField() {
  (document.activeElement as HTMLElement | null)?.blur();
}

/** Nothing in the content panel or the page scrolls sideways. */
function expectNoSidewaysScroll(width: number) {
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  const panel = document.querySelector("[data-slot=app-content]");
  expect(panel?.scrollWidth).toBeLessThanOrEqual(panel?.clientWidth ?? 0);
}

/**
 * Every table in `scope` fits its container, and no figure spills out of its
 * cell (a cell's content wider than the cell shows in its scrollWidth).
 */
function expectTablesFit(scope: Element) {
  const containers = [...scope.querySelectorAll<HTMLElement>("[data-slot=table-container]")];
  for (const container of containers) {
    expect(
      container.scrollWidth,
      `a table (${container.querySelector("caption")?.textContent ?? "no caption"}) scrolls`,
    ).toBeLessThanOrEqual(container.clientWidth);
  }
  for (const cell of scope.querySelectorAll<HTMLElement>("td, th")) {
    if (cell.offsetParent === null) continue;
    expect(cell.scrollWidth, `"${cell.textContent ?? ""}" spills`).toBeLessThanOrEqual(
      cell.clientWidth + 1,
    );
  }
  for (const pane of scope.querySelectorAll<HTMLElement>(
    "[data-slot=workbench-list], [data-slot=workbench-detail]",
  )) {
    expect(pane.scrollWidth).toBeLessThanOrEqual(pane.clientWidth);
  }
}

/** A third check, so a deleted one leaves two to move through. */
const DOCS_CHECK = (() => {
  const [first] = fakeChecks();
  if (first === undefined) throw new Error("the fixtures changed");
  return { ...first, id: "cccccccc-cccc-4ccc-8ccc-000000000003", name: "Docs" };
})();

interface Screen {
  label: string;
  path: string;
  param: string;
  /** The first three items, in the list's order. */
  ids: [string, string, string];
  overrides?: Partial<FakeApi>;
  /** Text the detail shows for an item, once loaded. */
  shows: (id: string) => string | RegExp;
  /** The summary's heading and its "select" hint. */
  heading: string;
  hint: RegExp;
  /** The item's own page, which a narrow screen opens; none for a log record. */
  pageOf?: (id: string) => string;
  /** The detail's link to the item's own page, by its name. */
  openPage?: string;
  /**
   * Takes the second item out of the list while it is selected, and `j` then
   * selects `next`: deleted (Uptime, Alerts), the item after it; left out by a
   * new filter, the new list's first, as new filters start the list again.
   */
  leave: { act: (api: FakeApi, router: Router) => Promise<void>; next: string };
  /** A real text field on the screen, opened first when it is in a dialog. */
  field: () => Promise<Locator>;
  /** A link in the detail and what it leaves in the address, on the same path. */
  paneLink: {
    address: string;
    overrides?: Partial<FakeApi>;
    name: string;
    search: Record<string, unknown>;
  };
}

const traceId = (i: number) => (i === 0 ? FAKE_TRACE_ID : i.toString(16).padStart(32, "0"));
const logId = (i: number) => i.toString(16).padStart(32, "0");

const SCREENS: Screen[] = [
  {
    label: "Replays",
    path: `${P}/replays`,
    param: "replay",
    ids: [fakeReplayId(0), fakeReplayId(1), fakeReplayId(2)],
    shows: (id) => `Replay at 16 Nov 2026, ${16 - Number(id.slice(-2))}:00`,
    heading: "This period",
    hint: /^Select a replay, or press/,
    field: async () => page.getByRole("searchbox", { name: "Path contains" }),
    pageOf: (id) => `${P}/replays/${id}`,
    openPage: "Open the replay's page",
    leave: {
      // Replay 1 visits /pricing only: listing paths with "checkout" leaves it out.
      act: async () => {
        await userEvent.type(
          page.getByRole("searchbox", { name: "Path contains" }),
          "checkout{Enter}",
        );
        await expect.poll(() => rowOf(fakeReplayId(1))).toBeNull();
        leaveField();
      },
      next: fakeReplayId(0),
    },
    paneLink: {
      address: `${P}/replays?replay=${fakeReplayId(99)}`,
      name: "All replays",
      search: {},
    },
  },
  {
    label: "Traces",
    path: `${P}/traces`,
    param: "trace",
    ids: [traceId(0), traceId(1), traceId(2)],
    shows: (id) => id,
    heading: "This period",
    hint: /^Select a trace, or press/,
    field: async () => page.getByRole("searchbox", { name: "Span name contains" }),
    pageOf: (id) => `${P}/traces/${id}`,
    openPage: "Open the trace's page",
    leave: {
      // Trace 1 is the worker's: the web service's list leaves it out.
      act: async () => {
        await page.getByRole("combobox", { name: "Service" }).click();
        await page.getByRole("option", { name: "web" }).click();
        await expect.poll(() => rowOf(traceId(1))).toBeNull();
        // The keys wait until the list of choices has closed, focus back on its button.
        await expect.element(page.getByRole("combobox", { name: "Service" })).toHaveFocus();
      },
      next: traceId(0),
    },
    paneLink: {
      address: `${P}/traces?trace=${FAKE_TRACE_ID}&span=${FAKE_SPANS.charge}`,
      name: `Open linked trace ${"f".repeat(32)}`,
      search: { trace: "f".repeat(32), span: "e".repeat(16) },
    },
  },
  {
    label: "Logs",
    path: `${P}/logs`,
    param: "log",
    ids: [logId(0), logId(1), logId(2)],
    shows: (id) => (id === logId(0) ? "Payment declined: card_declined" : /stack dump|^line \d+$/),
    heading: "This period",
    hint: /^Select a record, or press/,
    field: async () => page.getByRole("searchbox", { name: "Words in the message" }),
    leave: {
      // Record 1 is a stack dump: searching for "line" leaves it out ("declined" stays).
      act: async () => {
        await userEvent.type(
          page.getByRole("searchbox", { name: "Words in the message" }),
          "line{Enter}",
        );
        await expect.poll(() => rowOf(logId(1))).toBeNull();
        leaveField();
      },
      next: logId(0),
    },
    paneLink: { address: `${P}/logs?log=${"9".repeat(32)}`, name: "All logs", search: {} },
  },
  {
    label: "Users",
    path: `${P}/users`,
    param: "user",
    ids: ["user-1", "user-2", "user-3"],
    // Every user's activity is Ada's, so each detail loads.
    overrides: { user: (_userId, query) => fakeUser("ada", query) },
    shows: (id) => id,
    heading: "Known users",
    hint: /^Select a user, or press/,
    field: async () => page.getByRole("searchbox", { name: "Search by user ID" }),
    pageOf: (id) => `${P}/users/${id}`,
    openPage: "Open the user's page",
    leave: {
      act: async () => {
        await userEvent.type(page.getByRole("searchbox", { name: "Search by user ID" }), "user-1");
        await expect.poll(() => rowOf("user-2")).toBeNull();
        leaveField();
      },
      next: "user-1",
    },
    // No event has this ID: the detail's link goes back to the list.
    paneLink: {
      address: `${P}/users?user=nobody`,
      overrides: {},
      name: "See all users",
      search: {},
    },
  },
  {
    label: "Uptime",
    path: `${P}/uptime`,
    param: "check",
    ids: [
      "cccccccc-cccc-4ccc-8ccc-000000000001",
      "cccccccc-cccc-4ccc-8ccc-000000000002",
      DOCS_CHECK.id,
    ],
    overrides: { checks: [...fakeChecks(), DOCS_CHECK] },
    shows: (id) => (id === DOCS_CHECK.id ? "Docs" : id.endsWith("1") ? "Shop home" : "API health"),
    heading: "Checks now",
    hint: /^Select a check, or press/,
    field: async () => {
      await page.getByRole("button", { name: "Add check" }).click();
      return page.getByRole("dialog").getByLabelText("URL");
    },
    pageOf: (id) => `${P}/uptime/${id}`,
    openPage: "Open the check's page",
    leave: {
      // Deleted from its detail, the check gives way to the next; k and j move on from there.
      act: async (_api, router) => {
        await region("Uptime", "selected").getByRole("button", { name: "Delete" }).click();
        await page
          .getByRole("dialog", { name: "Delete the check “API health”?" })
          .getByRole("button", { name: "Delete check" })
          .click();
        await expect.poll(() => rowOf("cccccccc-cccc-4ccc-8ccc-000000000002")).toBeNull();
        await expect.poll(() => param(router, "check")).toBe(DOCS_CHECK.id);
        await userEvent.keyboard("k");
        await expect
          .poll(() => param(router, "check"))
          .toBe("cccccccc-cccc-4ccc-8ccc-000000000001");
      },
      next: DOCS_CHECK.id,
    },
    paneLink: {
      address: `${P}/uptime?check=cccccccc-cccc-4ccc-8ccc-999999999999`,
      name: "All checks",
      search: {},
    },
  },
  {
    label: "Alerts",
    path: `${P}/alerts`,
    param: "rule",
    ids: [ALERT_RULE_IDS.apiDown, ALERT_RULE_IDS.newErrors, ALERT_RULE_IDS.checkoutSpike],
    shows: (id) =>
      id === ALERT_RULE_IDS.apiDown
        ? "API down"
        : id === ALERT_RULE_IDS.newErrors
          ? "New errors"
          : "Checkout spike",
    heading: "Alerts now",
    hint: /^Select a rule, or press/,
    field: async () => {
      await page.getByRole("button", { name: "Add rule" }).click();
      return page.getByRole("dialog").getByLabelText("Name (optional)");
    },
    pageOf: (id) => `${P}/alerts/${id}`,
    openPage: "Open the rule's page",
    leave: {
      // Deleted from its detail, the rule gives way to the next; j moves on from there.
      act: async (_api, router) => {
        await region("Alerts", "selected").getByRole("button", { name: "Delete" }).click();
        await page
          .getByRole("dialog", { name: "Delete the rule “New errors”?" })
          .getByRole("button", { name: "Delete rule" })
          .click();
        await expect.poll(() => rowOf(ALERT_RULE_IDS.newErrors)).toBeNull();
        await expect.poll(() => param(router, "rule")).toBe(ALERT_RULE_IDS.checkoutSpike);
      },
      next: ALERT_RULE_IDS.certificates,
    },
    paneLink: {
      address: `${P}/alerts?rule=abababab-abab-4bab-8bab-000000000099`,
      name: "All rules",
      search: {},
    },
  },
];

describe.each(SCREENS)("the $label workbench", (screen) => {
  const detail = () => region(screen.label, "selected");
  const showsItem = async (id: string) => {
    await expect.element(detail().getByText(screen.shows(id)).first()).toBeVisible();
  };

  test("with nothing selected, sums up the list and says how to start", async () => {
    installFakeApi(screen.overrides);
    const router = renderApp(screen.path);

    const summary = region(screen.label, "summary");
    await expect
      .element(summary.getByRole("heading", { name: screen.heading, exact: true }))
      .toBeVisible();
    expect(param(router, screen.param)).toBeUndefined();
    await expect.element(summary.getByText(screen.hint)).toBeVisible();
    await expect
      .element(page.getByRole("list", { name: "Keyboard shortcuts" }))
      .toHaveTextContent("jkmoveEscclear");
  });

  test("keeps the selection in the address, beside the list", async () => {
    installFakeApi(screen.overrides);
    const [first, second] = screen.ids;
    const router = renderApp(`${screen.path}?${screen.param}=${encodeURIComponent(second)}`);

    await showsItem(second);
    const row = rowOf(second);
    expect(row?.getAttribute("data-state")).toBe("selected");
    expect(row?.querySelector("a, button")?.getAttribute("aria-current")).toBe("true");

    // A plain click on another row selects it, on the same page.
    rowOf(first)?.querySelector<HTMLElement>("a, button")?.click();
    await expect.poll(() => param(router, screen.param)).toBe(first);
    await showsItem(first);
    expect(router.state.location.pathname).toBe(screen.path);
  });

  test("j and k move with focus on the row, and Esc clears back to the summary", async () => {
    installFakeApi(screen.overrides);
    const [first, second] = screen.ids;
    const router = renderApp(screen.path);
    await expect.element(region(screen.label, "summary")).toBeVisible();

    await userEvent.keyboard("j");
    await expect.poll(() => param(router, screen.param)).toBe(first);
    await expect.poll(focusedRow).toBe(first);
    await userEvent.keyboard("j");
    await expect.poll(() => param(router, screen.param)).toBe(second);
    await expect.poll(focusedRow).toBe(second);
    await showsItem(second);
    await userEvent.keyboard("k");
    await expect.poll(() => param(router, screen.param)).toBe(first);
    await expect.poll(focusedRow).toBe(first);

    await userEvent.keyboard("{Escape}");
    await expect.poll(() => param(router, screen.param)).toBeUndefined();
    await expect.element(region(screen.label, "summary")).toBeVisible();
    // Focus stays on the row that was chosen, not on the page.
    expect(focusedRow()).toBe(first);
  });

  test("keys typed in a field are text", async () => {
    installFakeApi(screen.overrides);
    const router = renderApp(screen.path);
    await expect.element(region(screen.label, "summary")).toBeVisible();

    const field = await screen.field();
    await field.click();
    await userEvent.keyboard("jk");
    await settle();
    await expect.element(field).toHaveValue("jk");
    expect(param(router, screen.param)).toBeUndefined();
  });

  test("after the selected item leaves the list, j moves on", async () => {
    const api = installFakeApi(screen.overrides);
    const [, second] = screen.ids;
    const router = renderApp(`${screen.path}?${screen.param}=${encodeURIComponent(second)}`);
    await showsItem(second);
    // Focus on the selected row, as after choosing it.
    rowOf(second)?.querySelector<HTMLElement>("a, button")?.focus();

    await screen.leave.act(api, router);
    await userEvent.keyboard("j");
    await expect.poll(() => param(router, screen.param)).toBe(screen.leave.next);
    await expect.poll(focusedRow).toBe(screen.leave.next);
  });

  test("a link in the detail stays on the workbench", async () => {
    installFakeApi(screen.paneLink.overrides ?? screen.overrides);
    const router = renderApp(screen.paneLink.address);

    await detail().getByRole("link", { name: screen.paneLink.name }).click();
    await expect.poll(() => router.state.location.search).toEqual(screen.paneLink.search);
    expect(router.state.location.pathname).toBe(screen.path);
  });

  test("at 1440, the list and the selected item fit side by side", async () => {
    await page.viewport(1440, 900);
    installFakeApi(screen.overrides);
    const [first] = screen.ids;
    renderApp(`${screen.path}?${screen.param}=${encodeURIComponent(first)}`);

    await showsItem(first);
    // What loads after the detail's first part: tables of incidents, history, attributes.
    await settle();
    const list = region(screen.label, "list").element();
    expect(list.getBoundingClientRect().right).toBeLessThanOrEqual(
      detail().element().getBoundingClientRect().left,
    );
    expectNoSidewaysScroll(1440);
    const workbench = document.querySelector("[data-slot=workbench]");
    if (workbench === null) throw new Error("no workbench");
    expect(workbench.querySelectorAll("[data-slot=table-container]").length).toBeGreaterThan(0);
    expectTablesFit(workbench);
  });

  test("at 390, the list alone fills the screen, its filters wrapped", async () => {
    await page.viewport(390, 844);
    installFakeApi(screen.overrides);
    renderApp(screen.path);

    const list = region(screen.label, "list");
    // A row to choose (a log record's list, which opens records in place, has no IDs).
    await expect.poll(() => list.element().querySelector("a[href], button")).not.toBeNull();
    expectNoSidewaysScroll(390);
    expect(region(screen.label, "summary").elements()).toEqual([]);
    expect(page.getByRole("list", { name: "Keyboard shortcuts" }).elements()).toEqual([]);
    // The list takes the content's whole width.
    const panel = document.querySelector("[data-slot=app-content]")?.getBoundingClientRect();
    expect(list.element().getBoundingClientRect().width).toBeGreaterThan((panel?.width ?? 0) - 2);
    const bar = document.querySelector<HTMLElement>("[data-slot=filter-bar]");
    expect(bar?.scrollWidth ?? 0).toBeLessThanOrEqual(bar?.clientWidth ?? 0);
    expectTablesFit(list.element());
  });
});

describe.each(SCREENS.filter((screen) => screen.pageOf !== undefined))(
  "the $label workbench's own pages",
  (screen) => {
    const pageOf = (id: string) => screen.pageOf?.(id) ?? "";

    test("the detail links to the item's own page", async () => {
      installFakeApi(screen.overrides);
      const [first] = screen.ids;
      renderApp(`${screen.path}?${screen.param}=${encodeURIComponent(first)}`);
      await expect
        .element(region(screen.label, "selected").getByRole("link", { name: screen.openPage }))
        .toHaveAttribute("href", expect.stringMatching(`^${pageOf(first)}`));
    });

    test("on a narrow screen, a selection in the address opens the item's page", async () => {
      await page.viewport(800, 900);
      installFakeApi(screen.overrides);
      const [first] = screen.ids;
      const router = renderApp(`${screen.path}?${screen.param}=${encodeURIComponent(first)}`);

      await expect.poll(() => router.state.location.pathname).toBe(pageOf(first));
      // Back returns to the list, without the selection.
      router.history.back();
      await expect.poll(() => router.state.location.pathname).toBe(screen.path);
      expect(param(router, screen.param)).toBeUndefined();
      expect(region(screen.label, "summary").elements()).toEqual([]);
    });
  },
);

test("on a narrow screen, a log record in the address opens in place, having no page", async () => {
  await page.viewport(800, 900);
  installFakeApi();
  const router = renderApp(`${P}/logs?log=${logId(0)}`);

  await expect.poll(() => param(router, "log")).toBeUndefined();
  expect(router.state.location.pathname).toBe(`${P}/logs`);
  await expect
    .element(
      page
        .getByRole("list", { name: "Log records, newest first" })
        .getByRole("button", { name: /Payment declined/ }),
    )
    .toHaveAttribute("aria-expanded", "true");
  expect(region("Logs", "summary").elements()).toEqual([]);
});

describe("what each summary counts", () => {
  test("replays: only those loaded, marked as at least, and the period's errors", async () => {
    installFakeApi();
    renderApp(`${P}/replays`);
    const summary = region("Replays", "summary");
    await expect.element(summary.getByText(/so each is at least that many/)).toBeVisible();
    const scope = summary.element();
    expect(figure("Replays", scope)).toBe("50+");
    expect(figure("Cut short", scope)).toBe("1+");
    expect(figure("Known users", scope)).toBe("1+");
    expect(figure("Errors", scope)).toBe("2+");
    await expect
      .element(summary.getByText(/In this period and environment, whatever the other filters/))
      .toBeVisible();
  });

  test("traces: those loaded as at least, the period's services whole, the slowest", async () => {
    installFakeApi();
    const router = renderApp(`${P}/traces`);
    const summary = region("Traces", "summary");
    await expect.element(summary.getByText(/so each is at least that many/)).toBeVisible();
    const scope = summary.element();
    expect(figure("Traces", scope)).toBe("100+");
    expect(figure("With errors", scope)).toBe("10+");
    expect(figure("Services", scope)).toBe("2");

    // A trace chosen in the summary takes focus to its row.
    await summary.getByRole("link", { name: "POST /orders/{id}/charge" }).click();
    await expect.poll(() => param(router, "trace")).toBe(FAKE_TRACE_ID);
    await expect.poll(focusedRow).toBe(FAKE_TRACE_ID);
  });

  test("logs: a whole list has no plus, and a severity filter hides what it cannot list", async () => {
    installFakeApi();
    renderApp(`${P}/logs?q=declined`);
    const summary = region("Logs", "summary");
    await expect.element(summary.getByText(/count every record in the list/)).toBeVisible();
    expect(figure("Records", summary.element())).toBe("1");
    expect(figure("Warnings", summary.element())).toBe("1");
  });

  test("logs: at error and above, no warnings figure", async () => {
    installFakeApi();
    renderApp(`${P}/logs?severity=error`);
    const summary = region("Logs", "summary");
    await expect.element(summary.getByRole("heading", { name: "This period" })).toBeVisible();
    const labels = [...summary.element().querySelectorAll("dt")].map((dt) => dt.textContent);
    expect(labels).toEqual(["Records", "Errors or worse", "Services"]);
  });

  test("users: those loaded as at least; a name chosen takes focus to its row", async () => {
    installFakeApi();
    const router = renderApp(`${P}/users`);
    const summary = region("Users", "summary");
    await expect.element(summary.getByRole("heading", { name: "Most events" })).toBeVisible();
    expect(figure("Users", summary.element())).toBe("50+");

    const link = summary.getByRole("table").getByRole("link").first();
    const id = link.element().textContent;
    await link.click();
    await expect.poll(() => param(router, "user")).toBe(id);
    await expect.poll(focusedRow).toBe(id);
  });

  test("uptime: every check by state, and each one's uptime", async () => {
    installFakeApi();
    const router = renderApp(`${P}/uptime`);
    const summary = region("Uptime", "summary");
    await expect
      .element(summary.getByRole("table", { name: "Uptime of each check" }))
      .toBeVisible();
    const scope = summary.element();
    expect(figure("Checks", scope)).toBe("2 of 50");
    expect(figure("Up", scope)).toBe("1");
    expect(figure("Down", scope)).toBe("1");
    expect(figure("Paused", scope)).toBe("0");

    await summary.getByRole("link", { name: "API health" }).click();
    await expect.poll(() => param(router, "check")).toBe("cccccccc-cccc-4ccc-8ccc-000000000002");
    await expect.poll(focusedRow).toBe("cccccccc-cccc-4ccc-8ccc-000000000002");
  });

  test("alerts: every rule by state, what fires now, and the recent alerts", async () => {
    installFakeApi();
    renderApp(`${P}/alerts`);
    const summary = region("Alerts", "summary");
    await expect.element(summary.getByRole("list", { name: "Firing now" })).toBeVisible();
    const scope = summary.element();
    expect(figure("Rules", scope)).toBe("4 of 50");
    expect(figure("Firing", scope)).toBe("1");
    expect(figure("Quiet", scope)).toBe("1");
    expect(figure("Off", scope)).toBe("2");
    await expect
      .element(summary.getByRole("table", { name: "Recent alerts, newest first" }))
      .toBeVisible();
  });
});

describe("the workbenches' details", () => {
  test("a trace's span chosen beside the list stays in the address", async () => {
    installFakeApi();
    const router = renderApp(`${P}/traces?trace=${FAKE_TRACE_ID}`);
    await region("Traces", "selected")
      .getByRole("button", { name: "Level 2: charge card" })
      .click();
    await expect.poll(() => param(router, "span")).toBe(FAKE_SPANS.charge);
    expect(router.state.location.pathname).toBe(`${P}/traces`);
    await expect
      .element(region("Traces", "selected").getByRole("heading", { name: "Span: charge card" }))
      .toBeVisible();
  });

  test("a rule's detail shows only its own firing alerts and history", async () => {
    const api = installFakeApi();
    renderApp(`${P}/alerts?rule=${ALERT_RULE_IDS.newErrors}`);
    const detail = region("Alerts", "selected");
    await expect
      .element(detail.getByRole("table", { name: "The rule's alerts, newest first" }))
      .toBeVisible();
    expect(api.requests).toContain(
      `/api/projects/${PROJECT.id}/alert-rules/${ALERT_RULE_IDS.newErrors}/history`,
    );
    const rows = [...detail.getByRole("table").element().querySelectorAll("tbody tr")].map(
      (row) => row.querySelector("td")?.textContent,
    );
    expect(rows).toEqual(["16 Nov 2026, 06:10"]);
    await expect.element(detail.getByText("Nothing is firing.")).toBeVisible();
  });

  test("a check's period changes beside the list, the selection kept", async () => {
    const api = installFakeApi();
    const id = "cccccccc-cccc-4ccc-8ccc-000000000001";
    const router = renderApp(`${P}/uptime?check=${id}`);
    await region("Uptime", "selected").getByRole("combobox", { name: "Period" }).click();
    await page.getByRole("option", { name: "Last 30 days" }).click();
    await expect.poll(() => router.state.location.search).toEqual({ period: "30d", check: id });
    await expect
      .poll(() => api.requests)
      .toContain(`/api/projects/${PROJECT.id}/checks/${id}/results?period=30d`);
  });
});

/**
 * An alerts table stacked on a phone: no table scrolls sideways, each row is
 * a block, and what happened has the row's whole width (300px or more at 390),
 * its words whole.
 */
function expectStacked(table: Element) {
  const container = table.closest<HTMLElement>("[data-slot=table-container]");
  expect(container?.scrollWidth).toBeLessThanOrEqual(container?.clientWidth ?? 0);
  const rows = [...table.querySelectorAll<HTMLElement>("tbody tr")];
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(getComputedStyle(row).display).toBe("grid");
    const message = row.querySelector<HTMLElement>("[data-column=message]");
    expect(message?.getBoundingClientRect().width ?? 0).toBeGreaterThanOrEqual(300);
  }
  expect(container?.parentElement?.querySelector("[data-slot=scroll-hint]") ?? null).toBeNull();
}

/** A table that scrolls sideways on a phone: its scroller, first cell, and fade. */
async function scrollingTable(caption: string | RegExp) {
  const table = page.getByRole("table", { name: caption });
  await expect.element(table).toBeVisible();
  const container = table.element().closest<HTMLElement>("[data-slot=table-container]");
  if (container === null) throw new Error("no container");
  const first = table.element().querySelector<HTMLElement>("tbody tr > :first-child");
  const fade = () => container.parentElement?.querySelector("[data-slot=scroll-hint]") ?? null;
  return { container, pinned: first === null ? "" : getComputedStyle(first).position, fade };
}

describe("tables that scroll on a phone", () => {
  test("a trace's waterfall, the span's name pinned", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    renderApp(`${P}/traces/${FAKE_TRACE_ID}`);
    const { container, pinned, fade } = await scrollingTable(/^Spans appear under their parents/);
    expect(container.scrollWidth).toBeGreaterThan(container.clientWidth);
    expect(pinned).toBe("sticky");
    await expect.poll(fade).not.toBeNull();
    // Scrolled to the end, the fade goes.
    container.scrollLeft = container.scrollWidth;
    await expect.poll(fade).toBeNull();
    expectNoSidewaysScroll(390);
  });

  test("a rule's alerts stack: when, then what happened at full width", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    renderApp(`${P}/alerts/${ALERT_RULE_IDS.apiDown}`);
    const table = page.getByRole("table", { name: "The rule's alerts, newest first" });
    await expect.element(table).toBeVisible();
    expectStacked(table.element());
    expectNoSidewaysScroll(390);
  });
});

/*
 * Under 64rem a workbench shows its list alone. What the old pages showed
 * beside each row, or under the list, must still be on the screen or one
 * step away on the item's page.
 */
describe("at 390, what the old pages showed is still reachable", () => {
  test("replays: a row opens the replay's page, with its error, user, environment, and browser", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    const router = renderApp(`${P}/replays`);
    await region("Replays", "list")
      .getByRole("link", { name: "Replay at 16 Nov 2026, 16:00" })
      .click();
    await expect.poll(() => router.state.location.pathname).toBe(`${P}/replays/${fakeReplayId(0)}`);
    await expect
      .element(page.getByRole("link", { name: "TypeError: cart is undefined" }))
      .toBeVisible();
    await expect.element(page.getByRole("link", { name: "ada" })).toBeVisible();
    await expect.element(page.getByText("production", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Firefox, Linux, desktop")).toBeVisible();
  });

  test("traces: each row keeps its name, service, start, status, duration, and spans", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    renderApp(`${P}/traces`);
    await expect.poll(() => rowOf(FAKE_TRACE_ID)).not.toBeNull();
    const row = rowOf(FAKE_TRACE_ID);
    expect(row?.textContent).toBe(
      "POST /orders/{id}/chargeweb16 Nov 2026, 16:00:00.000Error182 ms5",
    );
    const cells = [...(row?.querySelectorAll<HTMLElement>("td") ?? [])];
    // Every cell in view, none cut by the screen's edge.
    for (const cell of cells) {
      expect(cell.getBoundingClientRect().right).toBeLessThanOrEqual(390);
    }
  });

  test("logs: a record opens in place, with its attributes and its trace", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    renderApp(`${P}/logs`);
    const list = page.getByRole("list", { name: "Log records, newest first" });
    await list.getByRole("button", { name: /Payment declined/ }).click();
    await expect.element(list.getByRole("table", { name: "Attributes" })).toBeVisible();
    await expect
      .element(list.getByRole("link", { name: `Open trace ${FAKE_TRACE_ID}` }))
      .toHaveAttribute("href", expect.stringMatching(`^${P}/traces/${FAKE_TRACE_ID}`));
  });

  test("logs: a linked record the list does not hold says so", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    renderApp(`${P}/logs?log=${"9".repeat(32)}`);
    await expect.element(page.getByText("The linked log record is not in the list")).toBeVisible();
  });

  test("users: a row opens the user's page, with first seen", async () => {
    await page.viewport(390, 844);
    installFakeApi({ user: (_userId, query) => fakeUser("ada", query) });
    const router = renderApp(`${P}/users`);
    await region("Users", "list").getByRole("link", { name: "user-1", exact: true }).click();
    await expect.poll(() => router.state.location.pathname).toBe(`${P}/users/user-1`);
    await expect.element(page.getByText("First seen", { exact: true })).toBeVisible();
  });

  test("uptime: every check's uptime and latest run follow the list, to compare", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    const router = renderApp(`${P}/uptime`);
    const overview = region("Uptime", "overview");
    const table = overview.getByRole("table", { name: "Uptime of each check" });
    await expect.element(table).toBeVisible();
    const head = [...table.element().querySelectorAll("thead th")].map((th) => th.textContent);
    expect(head).toEqual(["Check", "24 hours", "7 days", "30 days", "Latest", "Last checked"]);
    await expect
      .element(overview.getByText(/^Uptime is the share of the time not inside an incident/))
      .toBeVisible();
    // The table scrolls inside itself, the check's name pinned.
    const container = table.element().closest<HTMLElement>("[data-slot=table-container]");
    expect(container?.scrollWidth ?? 0).toBeGreaterThan(container?.clientWidth ?? 0);
    expectNoSidewaysScroll(390);
    // A name there opens the check's page: there is no pane to show it in.
    await overview.getByRole("link", { name: "API health" }).click();
    await expect
      .poll(() => router.state.location.pathname)
      .toBe(`${P}/uptime/cccccccc-cccc-4ccc-8ccc-000000000002`);
  });

  test("alerts: what fires now, the recent alerts, the hourly cap, and the channels follow the list", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    renderApp(`${P}/alerts`);
    const overview = region("Alerts", "overview");
    await expect.element(overview.getByRole("list", { name: "Firing now" })).toBeVisible();
    await expect
      .element(overview.getByRole("table", { name: "Recent alerts, newest first" }))
      .toBeVisible();
    await expect
      .element(overview.getByText(/Each rule sends at most 20 notifications an hour/))
      .toBeVisible();
    await expect
      .element(overview.getByRole("link", { name: "Channels are in Settings" }))
      .toHaveAttribute("href", "/settings?tab=channels");
    // Each alert stacks, what happened at full width, the held-back badge kept.
    const recent = overview.getByRole("table", { name: "Recent alerts, newest first" });
    expectStacked(recent.element());
    await expect.element(recent.getByText("Held back")).toBeVisible();
    expectNoSidewaysScroll(390);
  });

  test("alerts: older alerts load under the list", async () => {
    await page.viewport(390, 844);
    const api = installFakeApi();
    const [first] = api.alerts.history;
    if (first === undefined) throw new Error("the fixtures changed");
    // Twenty-one alerts: the history answers twenty at a time.
    api.alerts.history = Array.from({ length: 21 }, (_, i) => ({ ...first, id: `alert-${i}` }));
    renderApp(`${P}/alerts`);
    const overview = region("Alerts", "overview");
    const rows = () =>
      overview
        .getByRole("table", { name: "Recent alerts, newest first" })
        .element()
        .querySelectorAll("tbody tr").length;
    await expect.poll(rows).toBe(20);
    await overview.getByRole("button", { name: "Show older alerts" }).click();
    await expect.poll(rows).toBe(21);
    expectStacked(overview.getByRole("table", { name: "Recent alerts, newest first" }).element());
    expectNoSidewaysScroll(390);
    expect(api.requests).toContain(`/api/projects/${PROJECT.id}/alerts?before=alert-19`);
  });
});

describe("the users summary's windows", () => {
  const HOUR = 3_600_000;
  /** 120 users, one an hour back from now, half of them new this week. */
  const recentUsers = (more: boolean) => (query: URLSearchParams) => {
    const now = Date.now();
    const offset = Number(query.get("offset") ?? 0);
    const all = Array.from({ length: more ? 120 : 50 }, (_, i) => ({
      userId: `user-${i + 1}`,
      firstSeenAt: new Date(now - (i % 2 === 0 ? 30 * 24 : 24) * HOUR - i * HOUR).toISOString(),
      lastSeenAt: new Date(now - i * HOUR - 60_000).toISOString(),
      events: 10,
    }));
    return {
      timeZone: "Asia/Singapore",
      environment: "production",
      environments: ["production"],
      users: all.slice(offset, offset + 50),
      hasMore: offset + 50 < all.length,
    };
  };

  test("a window the loaded users reach past is whole; one they do not is at least", async () => {
    installFakeApi({ users: recentUsers(true) });
    renderApp(`${P}/users`);
    const summary = region("Users", "summary");
    await expect.element(summary.getByRole("heading", { name: "Most events" })).toBeVisible();
    const scope = summary.element();
    expect(figure("Users", scope)).toBe("50+");
    // The 50 loaded span 50 hours: the last day is whole, the last week is not.
    expect(figure("Seen in 24 hours", scope)).toBe("24");
    expect(figure("Seen in 7 days", scope)).toBe("50+");
    expect(figure("New in 7 days", scope)).toBe("25+");
  });

  test("a whole list has no plus", async () => {
    installFakeApi({ users: recentUsers(false) });
    renderApp(`${P}/users`);
    const summary = region("Users", "summary");
    await expect.element(summary.getByRole("heading", { name: "Most events" })).toBeVisible();
    const scope = summary.element();
    expect(figure("Users", scope)).toBe("50");
    expect(figure("Seen in 7 days", scope)).toBe("50");
    expect(figure("New in 7 days", scope)).toBe("25");
  });
});

describe("a trace's selection and what belongs to it", () => {
  const STALE_AT = "2026-11-01T00:00:00.000Z";
  const FAKE_START = new Date(Date.UTC(2026, 10, 16, 8, 0)).toISOString();

  test("a row chosen sets its own start and drops the span of the trace before", async () => {
    const api = installFakeApi();
    const router = renderApp(
      `${P}/traces?trace=${traceId(1)}&span=${FAKE_SPANS.charge}&at=${encodeURIComponent(STALE_AT)}`,
    );
    await region("Traces", "list").getByRole("link", { name: "POST /orders/{id}/charge" }).click();
    await expect
      .poll(() => router.state.location.search)
      .toEqual({ trace: FAKE_TRACE_ID, at: FAKE_START });
    await expect
      .element(region("Traces", "selected").getByRole("link", { name: "Open the trace's page" }))
      .toHaveAttribute("href", `${P}/traces/${FAKE_TRACE_ID}?at=${encodeURIComponent(FAKE_START)}`);

    // A filter that leaves the trace out keeps it, still looked for at its own start.
    await page.getByRole("combobox", { name: "Service" }).click();
    await page.getByRole("option", { name: "worker" }).click();
    await expect.poll(() => rowOf(FAKE_TRACE_ID)).toBeNull();
    expect(router.state.location.search).toMatchObject({ trace: FAKE_TRACE_ID, at: FAKE_START });
    await expect
      .element(
        region("Traces", "selected").getByRole("heading", { name: "POST /orders/{id}/charge" }),
      )
      .toBeVisible();
    const lookups = api.requests.filter((request) =>
      request.startsWith(`/api/projects/${PROJECT.id}/traces/${FAKE_TRACE_ID}?`),
    );
    expect(lookups.every((request) => request.includes(encodeURIComponent(FAKE_START)))).toBe(true);
    expect(lookups.length).toBeGreaterThan(0);
  });

  test("j sets the next trace's start, and Esc clears it with the span", async () => {
    installFakeApi();
    const router = renderApp(`${P}/traces?trace=${FAKE_TRACE_ID}&span=${FAKE_SPANS.charge}`);
    await expect
      .element(region("Traces", "selected").getByRole("heading", { name: "Span: charge card" }))
      .toBeVisible();
    await page.getByRole("button", { name: "Level 2: charge card" }).click();
    await userEvent.keyboard("j");
    await expect
      .poll(() => router.state.location.search)
      .toEqual({
        trace: traceId(1),
        at: new Date(Date.UTC(2026, 10, 16, 7, 59)).toISOString(),
      });
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => router.state.location.search).toEqual({});
  });
});

test("the sidebar marks Alerts on a rule's own page", async () => {
  installFakeApi();
  renderApp(`${P}/alerts/${ALERT_RULE_IDS.apiDown}`);
  await expect
    .element(
      page.getByRole("navigation", { name: "Project" }).getByRole("link", { name: "Alerts" }),
    )
    .toHaveAttribute("data-active");
});
