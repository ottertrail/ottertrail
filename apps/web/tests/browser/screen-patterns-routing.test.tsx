import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useRouter,
} from "@tanstack/react-router";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import "../../src/styles/globals.css";
import { SettingsSection } from "../../src/components/settings-section.tsx";
import { UnsavedChangesGuard } from "../../src/components/unsaved-changes-guard.tsx";
import { Workbench } from "../../src/components/workbench.tsx";
import { ignoreOrder, sameValues, useDirtyForm } from "../../src/hooks/use-dirty-form.ts";
import { deferred, installFakeApi, OTHER_PROJECT, PROJECT } from "./fake-api.ts";
import { trackMounted } from "./mounted.ts";
import { renderApp } from "./render.tsx";

/*
 * The shared blocks inside a small router of their own, where a test needs
 * real navigation: one form component kept mounted across projects, a
 * workbench with items that have their own pages, a save that waits.
 */

afterEach(async () => {
  await page.viewport(1280, 900);
});

interface Values {
  name: string;
  keep: string;
}

/** What the harness's Save sent, in order. */
let submitted: { projectId: string; values: Values }[] = [];
/** The server's values per project, which a test may change (a refetch). */
let server: Record<string, Values> = {};
/** Holds a save back until the test resolves it. */
let pendingSave: ReturnType<typeof deferred<void>> | undefined;

function ProjectForm({ projectId, useKey }: { projectId: string; useKey: boolean }) {
  // The harness's own routes are not the app's registered ones: plain history paths.
  const { history } = useRouter();
  const [, refetch] = React.useReducer((count: number) => count + 1, 0);
  const initial = server[projectId] ?? { name: projectId, keep: "forever" };
  const form = useDirtyForm(initial, useKey ? { key: projectId } : {});
  const [saving, setSaving] = React.useState(false);
  return (
    <>
      <SettingsSection
        title="Settings"
        form={form}
        saving={saving}
        onSave={(values) => {
          submitted.push({ projectId, values });
          if (pendingSave === undefined) {
            form.saved(values);
            return;
          }
          setSaving(true);
          void pendingSave.promise.then(() => {
            server[projectId] = values;
            form.saved(values);
            setSaving(false);
          });
        }}
      >
        <label>
          Name
          <input
            value={form.values.name}
            onChange={(event) => form.set("name", event.target.value)}
          />
        </label>
        <label>
          Keep
          <input
            value={form.values.keep}
            onChange={(event) => form.set("keep", event.target.value)}
          />
        </label>
      </SettingsSection>
      <button type="button" onClick={refetch}>
        Refetch
      </button>
      <button
        type="button"
        onClick={() => {
          // Save and leave in one handler, as a "Save and close" would.
          form.saved(form.values);
          history.push("/elsewhere");
        }}
      >
        Save and go
      </button>
      <button type="button" onClick={() => history.push("/p/b")}>
        Project b
      </button>
    </>
  );
}

const ITEMS = ["a", "b", "c"];

function ListPage() {
  const { history } = useRouter();
  return (
    <Workbench
      label="Items"
      className="h-96"
      ids={ITEMS}
      param="item"
      // Inline on purpose: a new function every render must not open a page again.
      onOpenPage={(id) => history.push(`/items/${id}`)}
      summary={<p>Nothing chosen</p>}
      renderDetail={(id) => (
        <div>
          <h2>Item {id}</h2>
          <button type="button">Act on {id}</button>
        </div>
      )}
      renderList={({ selected, select }) => (
        <ul>
          {ITEMS.map((id) => (
            <li key={id} data-workbench-id={id}>
              <button
                type="button"
                aria-current={id === selected ? "true" : undefined}
                onClick={() => select(id)}
              >
                Item {id}
              </button>
            </li>
          ))}
        </ul>
      )}
    />
  );
}

function renderHarness(path: string | string[], { guard = true, useKey = true } = {}) {
  const root = createRootRoute({ component: Outlet });
  const projectRoute = createRoute({
    getParentRoute: () => root,
    path: "/p/$projectId",
    component: function ProjectPage() {
      const { projectId } = projectRoute.useParams();
      const content = <ProjectForm projectId={projectId} useKey={useKey} />;
      return guard ? <UnsavedChangesGuard>{content}</UnsavedChangesGuard> : content;
    },
  });
  const routes = [
    projectRoute,
    createRoute({ getParentRoute: () => root, path: "/elsewhere", component: () => "Elsewhere" }),
    createRoute({ getParentRoute: () => root, path: "/start", component: () => "Start" }),
    createRoute({ getParentRoute: () => root, path: "/list", component: ListPage }),
    createRoute({
      getParentRoute: () => root,
      path: "/items/$id",
      component: () => <h1>Item page</h1>,
    }),
  ];
  const entries = Array.isArray(path) ? path : [path];
  const router = createRouter({
    routeTree: root.addChildren(routes),
    history: createMemoryHistory({ initialEntries: entries, initialIndex: entries.length - 1 }),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const reactRoot = createRoot(container);
  reactRoot.render(<RouterProvider router={router} />);
  trackMounted(() => {
    reactRoot.unmount();
    container.remove();
  });
  return router;
}

/** The address the router shows, for the harness's router and the app's. */
const pathOf = (router: { state: { location: { href: string } } }) => router.state.location.href;

const nameField = () => page.getByRole("textbox", { name: "Name" });
const keepField = () => page.getByRole("textbox", { name: "Keep" });
const saveButton = () => page.getByRole("button", { name: /^Save changes|^Saving/ });

function reset() {
  submitted = [];
  server = {};
  pendingSave = undefined;
}

describe("a settings form kept mounted from one project to another", () => {
  test("leaving project a with edits for project b leaves nothing of a in b's form", async () => {
    reset();
    const router = renderHarness("/p/a");
    await nameField().fill("edited in a");

    await page.getByRole("button", { name: "Project b" }).click();
    await page.getByRole("button", { name: "Leave and discard" }).click();

    await expect.poll(() => pathOf(router)).toBe("/p/b");
    await expect.element(nameField()).toHaveValue("b");
    await expect.element(page.getByText("No unsaved changes")).toBeVisible();
    await expect.element(saveButton()).toHaveAttribute("aria-disabled", "true");
    // Enter in a field submits the form: still nothing to save.
    await nameField().click();
    await userEvent.keyboard("{Enter}");
    expect(submitted).toEqual([]);
  });

  test("a new key starts the form again from the new project's values", async () => {
    reset();
    // No guard: only the key resets the form.
    const router = renderHarness("/p/a", { guard: false });
    await nameField().fill("edited in a");

    await page.getByRole("button", { name: "Project b" }).click();

    await expect.poll(() => pathOf(router)).toBe("/p/b");
    await expect.element(nameField()).toHaveValue("b");
    await expect.element(page.getByText("No unsaved changes")).toBeVisible();
  });

  test("leaving anyway discards the edits, even without a key", async () => {
    reset();
    const router = renderHarness("/p/a", { useKey: false });
    await nameField().fill("edited in a");

    await page.getByRole("button", { name: "Project b" }).click();
    await page.getByRole("button", { name: "Leave and discard" }).click();

    await expect.poll(() => pathOf(router)).toBe("/p/b");
    await expect.element(nameField()).toHaveValue("b");
  });

  test("in the app, another project's pages mount afresh", async () => {
    installFakeApi({ projects: [PROJECT, OTHER_PROJECT] });
    const router = renderApp(`/projects/${PROJECT.id}/web-analytics`);
    // Local state on project a's page, which keeps its data on screen while b's loads.
    await page.getByRole("button", { name: "Show the numbers" }).click();
    await expect.element(page.getByRole("button", { name: "Hide the numbers" })).toBeVisible();

    await page.getByRole("button", { name: "Project: Main site. Switch project" }).click();
    await page.getByRole("menuitem", { name: "Docs" }).click();

    await expect.poll(() => pathOf(router)).toBe(`/projects/${OTHER_PROJECT.id}/web-analytics`);
    await expect.element(page.getByRole("button", { name: "Show the numbers" })).toBeVisible();
  });
});

describe("the form against the server", () => {
  test("a save keeps what was typed while it ran", async () => {
    reset();
    pendingSave = deferred<void>();
    renderHarness("/p/a");
    await nameField().fill("first");
    await saveButton().click();
    await expect.element(saveButton()).toHaveTextContent("Saving…");
    // Save stays focusable while it waits, so focus does not fall to the page.
    expect(document.activeElement?.textContent).toBe("Saving…");
    await expect.element(saveButton()).toHaveAttribute("aria-disabled", "true");

    await nameField().fill("second");
    pendingSave.resolve();

    await expect.element(saveButton()).toHaveTextContent("Save changes");
    await expect.element(nameField()).toHaveValue("second");
    await expect.element(page.getByText("Unsaved changes", { exact: true })).toBeVisible();
    await nameField().fill("first");
    await expect.element(page.getByText("No unsaved changes")).toBeVisible();
  });

  test("a refetch while editing updates the fields not edited, and Discard restores the latest", async () => {
    reset();
    renderHarness("/p/a");
    await nameField().fill("mine");

    server.a = { name: "a", keep: "90" };
    await page.getByRole("button", { name: "Refetch" }).click();

    await expect.element(keepField()).toHaveValue("90");
    await expect.element(nameField()).toHaveValue("mine");
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();

    await page.getByRole("button", { name: "Discard" }).click();
    await expect.element(nameField()).toHaveValue("a");
    await expect.element(keepField()).toHaveValue("90");
    await expect.element(page.getByText("No unsaved changes")).toBeVisible();
  });

  test("a field changed on the server and by the user keeps the user's value and says so", async () => {
    reset();
    renderHarness("/p/a");
    await nameField().fill("mine");

    server.a = { name: "theirs", keep: "forever" };
    await page.getByRole("button", { name: "Refetch" }).click();

    const notice = page.getByRole("alert");
    await expect.element(notice).toBeVisible();
    expect(notice.element().textContent).toContain(
      "This section changed on the server while you edited it.",
    );
    await expect.element(nameField()).toHaveValue("mine");

    await notice.getByRole("button", { name: "Load the new values" }).click();
    await expect.element(nameField()).toHaveValue("theirs");
    await expect.element(notice).not.toBeInTheDocument();
  });

  test("saving and leaving in one handler does not ask", async () => {
    reset();
    const router = renderHarness("/p/a");
    await nameField().fill("mine");

    await page.getByRole("button", { name: "Save and go" }).click();

    await expect.poll(() => pathOf(router)).toBe("/elsewhere");
    await expect
      .element(page.getByRole("dialog", { name: "Leave without saving?" }))
      .not.toBeInTheDocument();
  });
});

/** A form whose fields compare through normalisers. */
function Normalized() {
  const form = useDirtyForm<{ port: number | string; sites: string[] }>(
    { port: 5, sites: ["a.example", "b.example"] },
    { normalize: { port: Number, sites: ignoreOrder } },
  );
  return (
    <>
      <output>{form.dirty ? "dirty" : "clean"}</output>
      <button type="button" onClick={() => form.set("port", "5")}>
        Text five
      </button>
      <button type="button" onClick={() => form.set("sites", ["b.example", "a.example"])}>
        Reorder
      </button>
      <button type="button" onClick={() => form.set("port", "6")}>
        Six
      </button>
    </>
  );
}

describe("comparing values", () => {
  test("a missing key and undefined are the same, and order counts in lists", () => {
    expect(sameValues({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(sameValues({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(ignoreOrder(["b.example", "a.example"])).toEqual(["a.example", "b.example"]);
  });

  test("a field's normaliser decides what counts as a change", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    root.render(<Normalized />);
    trackMounted(() => {
      root.unmount();
      container.remove();
    });

    await page.getByRole("button", { name: "Text five" }).click();
    await page.getByRole("button", { name: "Reorder" }).click();
    await expect.element(page.getByRole("status")).toHaveTextContent("clean");
    await page.getByRole("button", { name: "Six" }).click();
    await expect.element(page.getByRole("status")).toHaveTextContent("dirty");
  });
});

describe("a workbench whose items have their own pages", () => {
  test("on a narrow screen, a link with a selection opens the item once, and Back returns to the list", async () => {
    await page.viewport(800, 900);
    const router = renderHarness(["/start", "/list?item=b"]);

    await expect.element(page.getByRole("heading", { name: "Item page" })).toBeVisible();
    expect(pathOf(router)).toBe("/items/b");

    router.history.back();
    await expect.poll(() => pathOf(router)).toBe("/list");
    await expect.element(page.getByRole("button", { name: "Item b" })).toBeVisible();
    // It stays on the list: nothing sends it back to the item.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(pathOf(router)).toBe("/list");

    router.history.back();
    await expect.poll(() => pathOf(router)).toBe("/start");
  });

  test("a window that narrows during a session leaves the list where it is, the item hidden", async () => {
    const router = renderHarness("/list?item=b");
    await expect.element(page.getByRole("heading", { name: "Item b" })).toBeVisible();

    await page.viewport(800, 900);
    await expect.element(page.getByRole("heading", { name: "Item b" })).not.toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(pathOf(router)).toBe("/list?item=b");
    // Hidden by CSS, not unmounted: widening shows it again as it was.
    const pane = document.querySelector("[data-workbench-pane=detail]");
    expect(pane === null ? null : getComputedStyle(pane).display).toBe("none");
    expect(pane?.textContent).toContain("Item b");

    // A choice made while narrow opens the page.
    await page.getByRole("button", { name: "Item c" }).click();
    await expect.poll(() => pathOf(router)).toBe("/items/c");
  });

  test("Back after moving with keys returns to where the list was opened, and forward to the last item", async () => {
    const router = renderHarness(["/start", "/list"]);
    await page.getByRole("button", { name: "Item a" }).click();
    await expect.poll(() => pathOf(router)).toBe("/list?item=a");

    await userEvent.keyboard("j");
    await userEvent.keyboard("j");
    await expect.poll(() => pathOf(router)).toBe("/list?item=c");

    router.history.back();
    await expect.poll(() => pathOf(router)).toBe("/list");
    router.history.forward();
    await expect.poll(() => pathOf(router)).toBe("/list?item=c");
  });

  test("focus follows the keys, and returns to the list when the selection clears", async () => {
    const router = renderHarness("/list");
    await expect.element(page.getByText("Nothing chosen")).toBeVisible();

    await userEvent.keyboard("j");
    await expect.poll(() => document.activeElement?.textContent).toBe("Item a");
    await userEvent.keyboard("j");
    await expect.poll(() => document.activeElement?.textContent).toBe("Item b");

    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByText("Nothing chosen")).toBeVisible();
    expect(document.activeElement?.textContent).toBe("Item b");

    // Focus in the detail, then the selection clears another way (Back): focus returns.
    await page.getByRole("button", { name: "Item c" }).click();
    await page.getByRole("button", { name: "Act on c" }).click();
    router.history.back();
    await expect.element(page.getByText("Nothing chosen")).toBeVisible();
    await expect.poll(() => document.activeElement?.textContent).toBe("Item c");
  });
});
