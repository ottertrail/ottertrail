import { describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import type { ResolvedFrame, StackSourceMaps } from "../../src/lib/errors-api.ts";
import {
  ERROR_FINGERPRINTS,
  FAKE_STACK,
  fakeError,
  fakeFrames,
  fakeSourceMaps,
  installFakeApi,
  PROJECT,
} from "./fake-api.ts";
import { renderApp } from "./render.tsx";

const TYPE_ERROR = `/projects/${PROJECT.id}/errors/${ERROR_FINGERPRINTS.typeError}`;
const SETTINGS = `/projects/${PROJECT.id}/settings`;
const SOURCE_MAPS_PATH = `/api/projects/${PROJECT.id}/source-maps`;

/** The fake stack's frames, none of them mapped. */
const unmappedFrames = (): ResolvedFrame[] =>
  fakeFrames().map((frame) => ({ ...frame, original: null }));

/** The TypeError's page, with the stack mapped as `sourceMaps` says. */
function installWithSourceMaps(sourceMaps: StackSourceMaps, frames = unmappedFrames()) {
  return installFakeApi({
    error: (fingerprint, query, api) => {
      const detail = fakeError(fingerprint, query, api);
      return detail instanceof Response ? detail : { ...detail, frames, sourceMaps };
    },
  });
}

const rawStackButton = () =>
  page.getByRole("button", { name: /the stack as the browser reported it$/ });

describe("an error's stack", () => {
  test("shows mapped frames with their source, the error's line marked", async () => {
    installFakeApi();
    renderApp(TYPE_ERROR);

    await expect
      .element(
        page.getByText("Mapped to your original files with the source maps of release 1.4.2."),
      )
      .toBeVisible();
    const frames = page.getByRole("list", { name: "Frames, top first" });
    await expect.element(frames).toBeVisible();

    // The top frame: its original place, the source around it, and where it ran. Not
    // the map's name at that position, which is often not the enclosing function's.
    await expect
      .element(frames.getByText("src/checkout/submit.ts:42:18", { exact: true }))
      .toBeVisible();
    expect(frames.element().querySelector("p")?.textContent).toBe("src/checkout/submit.ts:42:18");
    const figure = page.getByRole("figure", { name: "Lines 39 to 45 of src/checkout/submit.ts" });
    await expect.element(figure).toBeVisible();
    const lines = [...figure.element().querySelectorAll("code > *")];
    expect(lines).toHaveLength(7);
    expect(lines[0]?.textContent).toBe("39export function submitOrder(cart: Cart) {");
    // Line 42, marked by more than color: a marker, and words for screen readers.
    const marked = figure.element().querySelectorAll("mark");
    expect(marked).toHaveLength(1);
    expect(marked[0]?.textContent).toBe(
      "The error happened on this line: ▶42  const id = cart.address.id;",
    );
    await expect
      .element(frames.getByText("https://example.com/assets/app.js:1:2345"))
      .toBeVisible();

    // A mapped frame without source shown.
    await expect.element(frames.getByText("src/checkout/form.tsx:17:5")).toBeVisible();

    // The library's three frames are folded.
    const fold = page.getByRole("button", { name: "Show 3 more frames, without a source map" });
    await expect.element(fold).toHaveAttribute("aria-expanded", "false");
    await expect
      .element(frames.getByText("https://example.com/assets/vendor.js:2:100"))
      .not.toBeVisible();
    await fold.click();
    await expect
      .element(page.getByRole("button", { name: "Hide 3 frames without a source map" }))
      .toHaveAttribute("aria-expanded", "true");
    await expect
      .element(frames.getByText("https://example.com/assets/vendor.js:2:100"))
      .toBeVisible();
  });

  test("shows the stack as the browser reported it on request", async () => {
    installFakeApi();
    renderApp(TYPE_ERROR);

    const button = rawStackButton();
    await expect.element(button).toHaveTextContent("Show the stack as the browser reported it");
    await expect.element(button).toHaveAttribute("aria-expanded", "false");
    const raw = document.getElementById(button.element().getAttribute("aria-controls") ?? "");
    expect(raw?.textContent).toBe(FAKE_STACK);
    expect(raw?.hidden).toBe(true);

    await button.click();

    await expect.element(button).toHaveTextContent("Hide the stack as the browser reported it");
    await expect.element(button).toHaveAttribute("aria-expanded", "true");
    expect(raw?.hidden).toBe(false);
  });

  test("without a release, says how the site sets one, and shows the stack as reported", async () => {
    installWithSourceMaps({ status: "no_release", release: null, paths: [] });
    renderApp(TYPE_ERROR);

    await expect
      .element(
        page.getByText(/^This occurrence has no release, so no source map can be chosen for it/),
      )
      .toBeVisible();
    await expect.element(page.getByText('data-release="1.4.2"')).toBeVisible();
    // Nothing mapped: the stack as the browser reported it, without a button.
    expect(document.querySelector("pre")?.textContent).toBe(FAKE_STACK);
    await expect.element(rawStackButton()).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("list", { name: "Frames, top first" }))
      .not.toBeInTheDocument();
  });

  test("without maps for its files, names them and links to the settings", async () => {
    installWithSourceMaps({
      status: "no_maps",
      release: "1.4.2",
      paths: ["/assets/app.js", "/assets/vendor.js"],
    });
    const router = renderApp(TYPE_ERROR);

    await expect
      .element(page.getByText(/^No source maps of release 1\.4\.2 cover the files of this stack/))
      .toBeVisible();
    await expect.element(page.getByText("/assets/app.js", { exact: true })).toBeVisible();
    await expect.element(page.getByText("/assets/vendor.js", { exact: true })).toBeVisible();
    expect(document.querySelector("pre")?.textContent).toBe(FAKE_STACK);

    await page.getByRole("link", { name: "Source maps settings" }).click();

    await expect.poll(() => router.state.location.pathname).toBe(SETTINGS);
    expect(router.state.location.hash).toBe("source-maps");
    await expect.element(page.getByRole("heading", { name: "Source maps" })).toBeVisible();
  });

  test("with maps that cover none of the frames, says they may be another build's", async () => {
    installWithSourceMaps({ status: "not_mapped", release: "1.4.2", paths: ["/assets/app.js"] });
    renderApp(TYPE_ERROR);

    await expect
      .element(page.getByText(/^Release 1\.4\.2 has source maps for these files, but none covers/))
      .toBeVisible();
    await expect.element(page.getByText("/assets/app.js", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("link", { name: "Source maps settings" })).toBeVisible();
  });

  test("when no frame is in a file, says so, with no list of files", async () => {
    installWithSourceMaps({ status: "no_files", release: "1.4.2", paths: [] });
    renderApp(TYPE_ERROR);

    await expect
      .element(page.getByText(/^No frame of this stack is in a file a source map could be for/))
      .toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Source maps settings" }))
      .not.toBeInTheDocument();
    expect(document.querySelector("pre")?.textContent).toBe(FAKE_STACK);
  });

  test("on an install without an object store, says source maps are off", async () => {
    installWithSourceMaps({ status: "not_configured", release: "1.4.2", paths: [] });
    renderApp(TYPE_ERROR);

    await expect
      .element(page.getByText(/^Source maps are off on this install: it has no object store/))
      .toBeVisible();
    await expect.element(page.getByText("OBJECT_STORE_URL")).toBeVisible();
    expect(document.querySelector("pre")?.textContent).toBe(FAKE_STACK);
  });

  test("when the maps cannot be read, says the stack is shown as reported", async () => {
    installWithSourceMaps({ status: "unavailable", release: "1.4.2", paths: [] });
    renderApp(TYPE_ERROR);

    await expect
      .element(
        page.getByText(
          /^The source maps could not be read just now, so the stack is shown as the browser reported it/,
        ),
      )
      .toBeVisible();
    expect(document.querySelector("pre")?.textContent).toBe(FAKE_STACK);
  });

  test("without a stack, says so and nothing about source maps", async () => {
    installFakeApi();
    renderApp(`/projects/${PROJECT.id}/errors/${ERROR_FINGERPRINTS.referenceError}`);

    await expect
      .element(page.getByText("The browser gave no stack trace for this error."))
      .toBeVisible();
    await expect.element(page.getByText(/source map/i)).not.toBeInTheDocument();
    await expect.element(rawStackButton()).not.toBeInTheDocument();
  });
});

/** The Source maps card on the project's settings page. */
const card = () => {
  const heading = page.getByRole("heading", { name: "Source maps" }).element();
  const found = heading.closest("[data-slot=card]");
  if (!(found instanceof HTMLElement)) throw new Error("The Source maps card is missing");
  return found;
};

const releasesTable = (order: "newest" | "oldest" = "newest") =>
  page.getByRole("table", { name: `Releases with source maps, ${order} upload first` });

/** The releases table's rows, as their cells' text. */
const releaseRows = (order: "newest" | "oldest" = "newest") =>
  [...(releasesTable(order).query()?.querySelectorAll("tbody tr") ?? [])].map((row) =>
    [...row.querySelectorAll("th, td")].slice(0, 3).map((cell) => cell.textContent),
  );

describe("the project's Source maps card", () => {
  test("lists the releases, latest upload first, and the organization's use", async () => {
    installFakeApi();
    renderApp(SETTINGS);

    await expect.element(releasesTable()).toBeVisible();
    expect(releaseRows()).toEqual([
      ["1.4.2", "2", "2.5 MB"],
      ["1.4.1", "1", "1.9 MB"],
    ]);
    // 10 MB of other projects', and this project's 4.4 MB.
    expect(card().textContent).toContain(
      "14 MB of 1 GB used, by all the organization's projects together.",
    );
    // The instructions are there, folded.
    await expect
      .element(page.getByRole("button", { name: "Show how to upload" }))
      .toHaveAttribute("aria-expanded", "false");
  });

  test("lists the oldest releases first on request, the ones to delete for room", async () => {
    const api = installFakeApi();
    renderApp(SETTINGS);
    await expect.element(releasesTable()).toBeVisible();

    const oldest = page.getByRole("button", { name: "Oldest first" });
    await expect.element(oldest).toHaveAttribute("aria-pressed", "false");
    await oldest.click();

    await expect.element(releasesTable("oldest")).toBeVisible();
    expect(releaseRows("oldest")).toEqual([
      ["1.4.1", "1", "1.9 MB"],
      ["1.4.2", "2", "2.5 MB"],
    ]);
    await expect.element(oldest).toHaveAttribute("aria-pressed", "true");
    expect(api.requests).toContain(`${SOURCE_MAPS_PATH}?order=oldest`);
  });

  test("shows a release's files in a dialog", async () => {
    const api = installFakeApi();
    renderApp(SETTINGS);

    const button = page.getByRole("button", { name: "Show the files of release 1.4.2" });
    await button.click();

    const dialog = page.getByRole("dialog", { name: "Release 1.4.2" });
    const files = dialog.getByRole("table", { name: "Files of release 1.4.2, by path" });
    await expect.element(files).toBeVisible();
    expect(
      [...files.element().querySelectorAll("tbody tr")].map((row) =>
        [...row.querySelectorAll("th, td")].map((cell) => cell.textContent),
      ),
    ).toEqual([
      ["/assets/app-4f3a.js", "2 MB"],
      ["/assets/vendor-9c1d.js", "512 KB"],
    ]);
    expect(api.requests).toContain(`${SOURCE_MAPS_PATH}/files?release=1.4.2`);

    await dialog.getByRole("button", { name: "Close" }).first().click();
    await expect.element(dialog).not.toBeInTheDocument();
    await expect.element(button).toHaveFocus();
  });

  test("deletes a release's maps after a confirmation that says the errors stay", async () => {
    const api = installFakeApi();
    renderApp(SETTINGS);

    const button = page.getByRole("button", { name: "Delete the source maps of release 1.4.2" });
    await button.click();
    const confirm = page.getByRole("dialog", {
      name: "Delete the source maps of release 1.4.2?",
    });
    await expect
      .element(confirm.getByText(/^The maps of its 2 files are deleted for good/))
      .toBeVisible();
    await expect.element(confirm.getByText(/Your errors are kept/)).toBeVisible();
    await expect.element(confirm.getByText(/show minified code again/)).toBeVisible();

    // Cancelled: nothing sent, and focus back on the button, still there.
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect.element(confirm).not.toBeInTheDocument();
    expect(api.requests).not.toContain(`${SOURCE_MAPS_PATH}?release=1.4.2`);
    await expect.element(button).toHaveFocus();

    await button.click();
    await confirm.getByRole("button", { name: "Delete source maps" }).click();

    await expect.element(confirm).not.toBeInTheDocument();
    expect(api.requests).toContain(`${SOURCE_MAPS_PATH}?release=1.4.2`);
    expect(api.sourceMaps.files.map((file) => file.release)).toEqual(["1.4.1"]);
    await expect.poll(() => releaseRows()).toEqual([["1.4.1", "1", "1.9 MB"]]);
    await expect.poll(() => card().textContent).toContain("12 MB of 1 GB used");
    // Its row is gone: focus goes to the card's heading.
    await expect.element(page.getByRole("heading", { name: "Source maps" })).toHaveFocus();
  });

  test("on an install without an object store, says source maps are off, and nothing else", async () => {
    installFakeApi({ sourceMaps: { ...fakeSourceMaps(), configured: false } });
    renderApp(SETTINGS);

    await expect
      .element(page.getByText(/^Source maps are off on this install: it has no object store/))
      .toBeVisible();
    expect(card().textContent).toContain("OBJECT_STORE_URL");
    await expect.element(releasesTable()).not.toBeInTheDocument();
    expect(card().textContent).not.toContain("used, by all");
    expect(card().textContent).not.toContain("npx");
  });

  test("without maps, says how to upload them, the secret key as a placeholder", async () => {
    installFakeApi({ sourceMaps: { ...fakeSourceMaps(), files: [] } });
    renderApp(SETTINGS);

    await expect.element(page.getByText("No source maps are uploaded yet.")).toBeVisible();
    await expect.element(releasesTable()).not.toBeInTheDocument();
    const text = card().textContent;
    expect(text).toContain(
      `OTTERTRAIL_SECRET_KEY=sk_… npx @ottertrail/sourcemaps upload dist \\\n  --release 1.4.2 --url-prefix / --host ${window.location.origin}`,
    );
    expect(text).toContain(
      "until it is published, run it from this repository's packages/sourcemaps",
    );
    expect(text).toContain(
      `curl -X PUT "${window.location.origin}/api/source-maps?release=1.4.2&path=/assets/index-4f3a.js"`,
    );
    expect(text).toContain("Authorization: Bearer $OTTERTRAIL_SECRET_KEY");
    expect(text).toContain("shown under “Your server” above");
    expect(text).toContain("must match the data-release on the tracker's script tag");
    expect(text).toContain('build.sourcemap: "hidden"');
    // Never the real key.
    expect(text).not.toContain(PROJECT.secretKey);
    await expect
      .element(page.getByRole("button", { name: "Copy the upload command" }))
      .toBeVisible();
  });
});
