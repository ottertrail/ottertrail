import { afterEach, describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { AI_DOCS_URL } from "../../src/lib/docs.ts";
import { AI_LIST_CALLS, aiCallId, fakeAiCalls } from "./fake-ai-calls.ts";
import { type FakeApi, installFakeApi, memberAccess, PROJECT } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

/**
 * The AI calls list and its conversations (docs/ai-usage.md, "The calls
 * list"; features/ai/calls-page.tsx, call-view.tsx) against the fake API
 * (fake-ai-calls.ts): the rows, the filters in the address, a call's
 * detail with its price's source, trace, and conversation, the
 * Conversations view and its empty state, users hidden without the Users
 * area, the AI page's links here, and the fit at 390 and 1440 wide.
 * list-workbenches.test.tsx checks the workbench's keys, selection, and
 * narrow-screen pages.
 */

const P = `/projects/${PROJECT.id}`;
const CALLS = `${P}/ai/calls`;
type Router = ReturnType<typeof renderApp>;

afterEach(async () => {
  await page.viewport(1280, 900);
});

const region = (label: string, part: "list" | "summary" | "selected") =>
  page.getByRole("region", { name: `${label}, ${part}` });
const search = (router: Router) => router.state.location.search as Record<string, unknown>;
const rowOf = (id: string) => document.querySelector(`[data-workbench-id="${CSS.escape(id)}"]`);

/** The query of the latest GET request to a path ending in `path`. */
function lastQuery(api: FakeApi, path: string): Record<string, string> | undefined {
  const request = api.requests.findLast((item) => item.split("?")[0]?.endsWith(path));
  if (request === undefined) return undefined;
  const at = request.indexOf("?");
  return at === -1 ? {} : Object.fromEntries(new URLSearchParams(request.slice(at + 1)));
}

/** A fact in a detail: its value's text, by its label. */
function fact(label: string, scope: Element): string | null | undefined {
  const term = [...scope.querySelectorAll("dt")].find((dt) => dt.textContent === label);
  return term?.nextElementSibling?.textContent;
}

/** Nothing in the content panel or the page scrolls sideways. */
function expectNoSidewaysScroll(width: number) {
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  const panel = document.querySelector("[data-slot=app-content]");
  expect(panel?.scrollWidth).toBeLessThanOrEqual(panel?.clientWidth ?? 0);
}

/** Every table in `scope` fits its container, and no cell's content spills. */
function expectTablesFit(scope: Element) {
  for (const container of scope.querySelectorAll<HTMLElement>("[data-slot=table-container]")) {
    expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth);
  }
  for (const cell of scope.querySelectorAll<HTMLElement>("td, th")) {
    if (cell.offsetParent === null) continue;
    expect(cell.scrollWidth, `"${cell.textContent ?? ""}" spills`).toBeLessThanOrEqual(
      cell.clientWidth + 1,
    );
  }
}

describe("the AI calls list", () => {
  test("opens from the AI page, filtered as it was, with the AI item marked current", async () => {
    installFakeApi();
    const router = renderApp(`${P}/ai?model=claude-sonnet-4-6&period=30d`);
    await expect
      .element(
        page.getByRole("region", { name: "Latest calls" }).getByRole("link", { name: "All calls" }),
      )
      .toBeVisible();
    // The title row's action and the latest calls' link both carry the AI page's filters.
    const links = page.getByRole("link", { name: "All calls" }).elements();
    expect(links).toHaveLength(2);
    for (const element of links) {
      expect(element.getAttribute("href")).toBe(`${CALLS}?period=30d&model=claude-sonnet-4-6`);
    }
    (links[0] as HTMLElement | undefined)?.click();
    await expect.poll(() => router.state.location.pathname).toBe(CALLS);
    await expect
      .element(
        page
          .getByRole("navigation", { name: "Project" })
          .getByRole("link", { name: "AI", exact: true }),
      )
      .toHaveAttribute("data-active");
  });

  test("lists each call: model and provider, when, feature, user, failure, tokens, cost, duration", async () => {
    installFakeApi();
    renderApp(CALLS);
    const list = region("AI calls", "list");
    await expect.element(list.getByRole("link", { name: "gpt-5-mini" })).toBeVisible();
    const rows = [...list.element().querySelectorAll("tbody tr")].map((row) => row.textContent);
    expect(rows[0]).toBe(
      "claude-sonnet-4-6anthropic16 Nov 2026, 15:38support-chatUser user_8f2a1,520 in380 out$0.00782.14 s",
    );
    expect(rows[1]).toContain("FailedRateLimitError");
    expect(rows[1]).toContain("Unlabeled");
    // A model without a price: a dash named "No price".
    const unpriced = rowOf(aiCallId(3));
    expect(unpriced?.querySelector("[title='No price']")?.textContent).toBe("–No price");
  });

  test("the summary counts the period's calls whole, with the estimate", async () => {
    installFakeApi();
    renderApp(CALLS);
    const summary = region("AI calls", "summary");
    await expect.element(summary.getByRole("heading", { name: "This period" })).toBeVisible();
    const figures = [...summary.element().querySelectorAll("[data-slot=stat]")].map(
      (stat) => stat.textContent,
    );
    expect(figures).toEqual(["Calls6", "Estimated cost (USD)$0.045", "Failed17%"]);
    await expect
      .element(
        summary.getByText(
          "Every call with these filters in this period and environment. 1 call had no price and is not in the cost. Cost is an estimate from token counts and model prices.",
        ),
      )
      .toBeVisible();
  });

  test("keeps its filters in the address, and the API gets them", async () => {
    const api = installFakeApi();
    const router = renderApp(
      `${CALLS}?model=claude-sonnet-4-6&status=failed&user=user_8f2a&conversation=chat-41&provider=anthropic`,
    );
    await expect.element(region("AI calls", "summary")).toBeVisible();
    expect(lastQuery(api, "/ai/call-list")).toEqual({
      period: "7d",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      user: "user_8f2a",
      conversation: "chat-41",
      status: "failed",
    });
    await expect.element(page.getByRole("searchbox", { name: "User ID" })).toHaveValue("user_8f2a");
    await expect
      .element(page.getByRole("button", { name: "Failed" }))
      .toHaveAttribute("aria-pressed", "true");

    // The conversation filter shows as a chip that takes it away.
    await page.getByRole("button", { name: "Remove the filter conversation chat-41" }).click();
    await expect.poll(() => search(router).conversation).toBeUndefined();
    await page.getByRole("button", { name: "All", exact: true }).click();
    await expect.poll(() => search(router).status).toBeUndefined();
    await page.getByRole("combobox", { name: "Feature" }).click();
    await page.getByRole("option", { name: "Unlabeled" }).click();
    await expect.poll(() => search(router).feature).toBe("");
    expect(search(router).model).toBe("claude-sonnet-4-6");
  });

  test("a call's detail: every field, the price's source, its trace, and its conversation", async () => {
    installFakeApi();
    renderApp(`${CALLS}?call=${aiCallId(0)}`);
    const detail = region("AI calls", "selected");
    await expect.element(detail.getByRole("heading", { name: "claude-sonnet-4-6" })).toBeVisible();
    const scope = detail.element();
    expect(fact("Status", scope)).toBe("OK");
    expect(fact("Estimated cost", scope)).toBe("$0.0078");
    expect(fact("Duration", scope)).toBe("2.14 s");
    expect(fact("Time to first chunk", scope)).toBe("590 ms");
    expect(fact("Input tokens", scope)).toBe("1,520");
    expect(fact("Cache read tokens", scope)).toBe("900");
    expect(fact("Reasoning tokens", scope)).toBe("64");
    expect(fact("Provider", scope)).toBe("anthropic");
    expect(fact("Operation", scope)).toBe("chat");
    expect(fact("Feature", scope)).toBe("support-chat");
    expect(fact("Service", scope)).toBe("support-api");
    expect(fact("Environment", scope)).toBe("production");
    expect(fact("Release", scope)).toBe("2.14.0");
    expect(fact("Started", scope)).toBe("16 Nov 2026, 15:38:12.345");
    expect(fact("Finish reasons", scope)).toBe("end_turn");
    await expect
      .element(detail.getByRole("link", { name: "user_8f2a" }))
      .toHaveAttribute("href", `${P}/users/user_8f2a`);
    await expect
      .element(detail.getByText("$0.0078 from Built-in price, checked 22 Nov 2026"))
      .toBeVisible();
    await expect
      .element(
        detail.getByText(
          "$3.00 input, $15.00 output, $0.30 cache read, $3.75 cache write, per million tokens",
        ),
      )
      .toBeVisible();
    await expect
      .element(detail.getByRole("link", { name: "Open its trace" }))
      .toHaveAttribute(
        "href",
        `${P}/traces/5c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f?at=2026-11-16T07%3A38%3A12.345Z&span=a1b2c3d4e5f60718`,
      );
    await expect
      .element(detail.getByRole("link", { name: "List its calls" }))
      .toHaveAttribute("href", `${CALLS}?conversation=chat-41`);
  });

  test("without monitoring, a call's trace ID shows as text, with no link", async () => {
    installFakeApi({ access: memberAccess({ ai: "view" }) });
    renderApp(`${CALLS}?call=${aiCallId(0)}`);
    const detail = region("AI calls", "selected");
    await expect.element(detail.getByText("5c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f")).toBeVisible();
    expect(detail.getByRole("link", { name: "Open its trace" }).elements()).toEqual([]);
  });

  test("a call's trace past the spans' retention, one without a trace, and one without a price", async () => {
    installFakeApi();
    const router = renderApp(`${CALLS}?call=${aiCallId(5)}`);
    const detail = region("AI calls", "selected");
    await expect
      .element(
        detail.getByText(
          "Traces are kept 30 days, so this call's trace is gone. The call is kept as long as the project's events.",
        ),
      )
      .toBeVisible();
    expect(detail.getByRole("link", { name: "Open its trace" }).elements()).toEqual([]);

    rowOf(aiCallId(4))?.querySelector<HTMLElement>("a")?.click();
    await expect.poll(() => search(router).call).toBe(aiCallId(4));
    await expect.element(detail.getByText("Sent over HTTP without a trace.")).toBeVisible();
    await expect.element(detail.getByText("Not part of a conversation.")).toBeVisible();
    await expect.element(detail.getByText(/from Price as text-embedding-3-large/)).toBeVisible();

    rowOf(aiCallId(3))?.querySelector<HTMLElement>("a")?.click();
    await expect
      .element(
        detail.getByText(
          /^acme-support-ft-2026-10 has no price, so this call is not in the cost\./,
        ),
      )
      .toBeVisible();
    await expect
      .element(detail.getByRole("link", { name: "Set prices in Settings" }))
      .toBeVisible();

    rowOf(aiCallId(1))?.querySelector<HTMLElement>("a")?.click();
    await expect.element(detail.getByText(/from Custom price from 1 Nov 2026/)).toBeVisible();
    expect(fact("Error type", detail.element())).toBe("RateLimitError");
  });

  test("a call's own page, for narrow screens and links, names it in the header", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    renderApp(`${CALLS}/${aiCallId(2)}?at=2026-11-16T07:34:00.500Z&period=30d`);
    await expect
      .element(page.getByRole("heading", { level: 1, name: "claude-sonnet-4-6" }))
      .toBeVisible();
    await expect.element(page.getByText("Cut off")).toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "All calls" }))
      .toHaveAttribute("href", `${CALLS}?period=30d`);
    expectNoSidewaysScroll(390);
  });

  test("a call no project has says so", async () => {
    installFakeApi();
    renderApp(`${CALLS}/${aiCallId(99)}`);
    await expect.element(page.getByText("No AI call with this ID")).toBeVisible();
  });

  test("without the Users area, a user filter from a link is refused, and its chip removes it", async () => {
    installFakeApi({ access: memberAccess({ ai: "view" }) });
    const router = renderApp(`${CALLS}?user=user_8f2a`);
    await expect.element(page.getByText("The AI calls could not load")).toBeVisible();
    await page.getByRole("button", { name: "Remove the filter user user_8f2a" }).click();
    await expect.poll(() => search(router).user).toBeUndefined();
    await expect.element(region("AI calls", "summary")).toBeVisible();
    expect(page.getByRole("button", { name: /Remove the filter user/ }).elements()).toEqual([]);
  });

  test("without the Users area: no user filter, and no call names its user", async () => {
    installFakeApi({ access: memberAccess({ ai: "view" }) });
    renderApp(`${CALLS}?call=${aiCallId(0)}`);
    const detail = region("AI calls", "selected");
    await expect.element(detail.getByRole("heading", { name: "claude-sonnet-4-6" })).toBeVisible();
    expect(page.getByRole("searchbox", { name: "User ID" }).elements()).toEqual([]);
    expect(region("AI calls", "list").element().textContent).not.toContain("user_8f2a");
    expect(fact("User", detail.element())).toBeUndefined();
  });

  test("before any AI call, says how to send them", async () => {
    installFakeApi({ aiCalls: { ...fakeAiCalls(), calls: [], received: false } });
    renderApp(CALLS);
    await expect.element(page.getByText("No AI calls yet")).toBeVisible();
    await expect
      .element(page.getByRole("link", { name: /How to send AI calls/ }))
      .toHaveAttribute("href", AI_DOCS_URL);
  });

  test("with none matching, says which filters to change", async () => {
    installFakeApi({ aiCalls: { ...fakeAiCalls(), calls: [] } });
    renderApp(`${CALLS}?model=gpt-5-mini`);
    await expect
      .element(region("AI calls", "summary").getByText("No call matches these filters"))
      .toBeVisible();
  });

  test("a list that cannot load says so, with Retry", async () => {
    installFakeApi({
      aiCalls: {
        ...fakeAiCalls(),
        list: () =>
          new Response(JSON.stringify({ error: "busy", message: "This took too long." }), {
            status: 503,
          }),
      },
    });
    renderApp(CALLS);
    await expect.element(page.getByText("The AI calls could not load")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  test("loads older calls a page at a time", async () => {
    installFakeApi({ aiCalls: { ...fakeAiCalls(), pageSize: 4 } });
    renderApp(CALLS);
    const list = region("AI calls", "list");
    await expect.element(list.getByRole("button", { name: "Load older calls" })).toBeVisible();
    expect(list.element().querySelectorAll("tbody tr")).toHaveLength(4);
    await list.getByRole("button", { name: "Load older calls" }).click();
    await expect.poll(() => list.element().querySelectorAll("tbody tr").length).toBe(6);
    expect(list.getByRole("button", { name: "Load older calls" }).elements()).toEqual([]);
  });
});

describe("the Conversations view", () => {
  test("switches in the address, and lists conversations by their last call", async () => {
    const api = installFakeApi();
    const router = renderApp(`${CALLS}?model=claude-sonnet-4-6`);
    await page.getByRole("button", { name: "Conversations" }).click();
    await expect.poll(() => search(router).view).toBe("conversations");
    expect(search(router).model).toBe("claude-sonnet-4-6");
    const list = region("Conversations", "list");
    await expect.element(list.getByRole("link", { name: "chat-41" })).toBeVisible();
    expect(lastQuery(api, "/ai/conversations")).toEqual({
      period: "7d",
      model: "claude-sonnet-4-6",
    });
    const rows = [...list.element().querySelectorAll("tbody tr")].map((row) =>
      row.getAttribute("data-workbench-id"),
    );
    expect(rows).toEqual(["chat-41", "chat-40"]);
    // The conversation filter has no field here: choosing a conversation is the selection.
    expect(page.getByRole("button", { name: /Remove the filter conversation/ }).elements()).toEqual(
      [],
    );
    const summary = region("Conversations", "summary");
    await expect
      .element(summary.getByText(/These count every conversation in the list/))
      .toBeVisible();
    await expect
      .element(summary.getByText("Select a conversation, or press j to start at the top."))
      .toBeVisible();
  });

  test("a conversation's calls in order, with its figures; a turn opens in the Calls view", async () => {
    installFakeApi();
    const router = renderApp(`${CALLS}?view=conversations&conversation=chat-41`);
    const detail = region("Conversations", "selected");
    await expect.element(detail.getByRole("heading", { name: "chat-41" })).toBeVisible();
    await expect.element(detail.getByRole("table")).toBeVisible();
    const scope = detail.element();
    expect(fact("Turns", scope)).toBe("2");
    expect(fact("Estimated cost", scope)).toBe("$0.039");
    expect(fact("Failed turns", scope)).toBe("0");
    expect(fact("Input tokens", scope)).toBe("6,720");
    expect(fact("Total duration", scope)).toBe("9.95 s");
    expect(fact("Started", scope)).toBe("16 Nov 2026, 15:34:00.500");
    expect(fact("Last call", scope)).toBe("16 Nov 2026, 15:38:12.345");
    expect(fact("Users", scope)).toBe("ada@example.com, user_8f2a");
    expect(fact("Features", scope)).toBe("summarize-ticket, support-chat");
    const turns = [...scope.querySelectorAll("tbody tr")].map((row) => row.textContent);
    expect(turns).toEqual([
      "115:34:00claude-sonnet-4-65,200 in1,024 out$0.0317.81 sCut off",
      "215:38:12claude-sonnet-4-61,520 in380 out$0.00782.14 sOK",
    ]);

    await detail.getByRole("link", { name: /^Turn 2,/ }).click();
    await expect.poll(() => search(router).call).toBe(aiCallId(0));
    expect(search(router)).toMatchObject({ conversation: "chat-41" });
    expect(search(router).view).toBeUndefined();
    await expect
      .element(page.getByRole("button", { name: "Remove the filter conversation chat-41" }))
      .toBeVisible();
  });

  test("without conversation IDs, says how to set them", async () => {
    installFakeApi({
      aiCalls: {
        ...fakeAiCalls(),
        calls: AI_LIST_CALLS.map((call) => ({ ...call, conversationId: "" })),
      },
    });
    renderApp(`${CALLS}?view=conversations`);
    const summary = region("Conversations", "summary");
    await expect.element(summary.getByText("No conversations in this period")).toBeVisible();
    await expect
      .element(
        summary.getByText(
          "Only calls with a conversation ID are in this view. Set the span attribute gen_ai.conversation.id, or conversationId when you send calls over HTTP.",
        ),
      )
      .toBeVisible();
    await expect
      .element(summary.getByRole("link", { name: /How to set it/ }))
      .toHaveAttribute("href", AI_DOCS_URL);
  });

  test("on a narrow screen, a conversation opens its own page", async () => {
    await page.viewport(800, 900);
    installFakeApi();
    const router = renderApp(`${CALLS}?view=conversations&period=30d`);
    const link = region("Conversations", "list").getByRole("link", { name: "chat-40" });
    await link.click();
    await expect.poll(() => router.state.location.pathname).toBe(`${P}/ai/conversations/chat-40`);
    expect(search(router)).toEqual({ period: "30d" });
    await expect.element(page.getByRole("heading", { level: 1, name: "chat-40" })).toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "All conversations" }))
      .toHaveAttribute("href", `${CALLS}?period=30d&view=conversations`);
  });

  test("fits at 1440 beside the selected conversation", async () => {
    await page.viewport(1440, 900);
    installFakeApi();
    renderApp(`${CALLS}?view=conversations&conversation=chat-40`);
    await expect.element(region("Conversations", "selected").getByRole("table")).toBeVisible();
    expectNoSidewaysScroll(1440);
    const workbench = document.querySelector("[data-slot=workbench]");
    if (workbench === null) throw new Error("no workbench");
    expectTablesFit(workbench);
  });

  test("fits alone at 390", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    renderApp(`${CALLS}?view=conversations`);
    await expect
      .element(region("Conversations", "list").getByRole("link", { name: "chat-41" }))
      .toBeVisible();
    expectNoSidewaysScroll(390);
    expectTablesFit(region("Conversations", "list").element());
  });
});
