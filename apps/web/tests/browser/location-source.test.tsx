import { describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { installFakeApi, PROJECT } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

const GENERAL = `/projects/${PROJECT.id}/settings?tab=general`;

const section = () => page.getByRole("form", { name: "Location data" });
const source = (name: string) => section().getByRole("radio", { name });
const header = (name: RegExp) => section().getByRole("textbox", { name });

describe("a project's location data", () => {
  test("uses the location database by default, with no header fields", async () => {
    installFakeApi();
    renderApp(GENERAL);

    await expect.element(source("Location database")).toBeChecked();
    await expect.element(source("Proxy headers")).not.toBeChecked();
    await expect.element(source("Off")).not.toBeChecked();
    await expect.element(header(/^Country header/)).not.toBeInTheDocument();
    await expect.element(section().getByText(/OTTERTRAIL_TRUSTED_PROXIES/)).not.toBeInTheDocument();
  });

  test("proxy headers: the header fields, the trust line, and Save sends lower-case names", async () => {
    const api = installFakeApi();
    renderApp(GENERAL);

    await source("Proxy headers").click();
    await expect
      .element(section().getByText(/read only from requests that come through a proxy/))
      .toBeVisible();
    await expect.element(header(/^Country header/)).toBeRequired();
    await header(/^Country header/).fill("X-Visitor-Country");
    await header(/^City header/).fill("x-visitor-city");
    await section().getByRole("button", { name: "Save location data" }).click();

    await expect.element(section().getByRole("status")).toHaveTextContent("No unsaved changes");
    expect(api.bodies.at(-1)).toEqual({
      method: "PATCH",
      path: `/api/projects/${PROJECT.id}`,
      body: {
        locationSource: "headers",
        locationHeaders: { country: "x-visitor-country", region: null, city: "x-visitor-city" },
      },
    });
    expect(api.projects[0]).toMatchObject({ locationSource: "headers" });
  });

  test("without the country header, Save does not send", async () => {
    const api = installFakeApi();
    renderApp(GENERAL);

    await source("Proxy headers").click();
    await section().getByRole("button", { name: "Save location data" }).click();
    expect(api.bodies).toEqual([]);
    await expect.element(section().getByRole("status")).toHaveTextContent("Unsaved changes");
  });

  test("off, saved; the header names stay for later", async () => {
    const api = installFakeApi({
      projects: [
        {
          ...PROJECT,
          locationSource: "headers",
          locationHeaders: { country: "x-visitor-country", region: null, city: null },
        },
      ],
    });
    renderApp(GENERAL);

    await expect.element(header(/^Country header/)).toHaveValue("x-visitor-country");
    await source("Off").click();
    await expect.element(header(/^Country header/)).not.toBeInTheDocument();
    await section().getByRole("button", { name: "Save location data" }).click();

    await expect.element(section().getByRole("status")).toHaveTextContent("No unsaved changes");
    expect(api.bodies.at(-1)?.body).toEqual({
      locationSource: "off",
      locationHeaders: { country: "x-visitor-country", region: null, city: null },
    });
  });

  test("an unsaved change marks the General tab", async () => {
    installFakeApi();
    renderApp(GENERAL);

    await source("Off").click();
    await expect.element(section().getByRole("status")).toHaveTextContent("Unsaved changes");
    await expect
      .element(page.getByRole("tab", { name: /^General\s*, unsaved changes$/ }))
      .toBeVisible();
  });
});
