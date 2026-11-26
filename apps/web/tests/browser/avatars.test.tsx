import { describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import { installFakeApi, PROJECT } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

/*
 * Avatars (docs/dashboard.md, "Avatars"): the instance's icon, the user's
 * avatar, and a project's icon, each a field under the save rule, and
 * where they show: the sidebar's head, the user menu, the project switcher.
 */

const ANALYTICS = `/projects/${PROJECT.id}/web-analytics`;
const form = (name: string) => page.getByRole("form", { name });
const saveBar = (name: string) => form(name).getByRole("status").last();
/** The image a square shows inside `root`, or null while it shows the initial. */
const imageIn = (root: Element | null) =>
  root?.querySelector("[data-slot=avatar] img")?.getAttribute("src") ?? null;
const instanceHead = () => document.querySelector("[data-slot=instance-name]");

/** A PNG (or another type) the browser drew, `width`×`height`, as a chosen file. */
async function imageFile(
  type = "image/png",
  width = 300,
  height = 200,
  color = "#000",
): Promise<File> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context !== null) context.fillStyle = color;
  context?.fillRect(0, 0, width, height);
  const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, type));
  return new File([blob ?? new Blob()], "picture", { type });
}

/** The PNG's width and height, from its IHDR. */
async function sizeOf(dataUrl: string): Promise<[number, number]> {
  const bytes = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), (char) =>
    char.charCodeAt(0),
  );
  const view = new DataView(bytes.buffer);
  return [view.getUint32(16), view.getUint32(20)];
}

describe("the instance's icon", () => {
  test("choosing an image previews it as an unsaved change; Discard puts the initial back", async () => {
    const api = installFakeApi();
    renderApp("/settings");
    const instance = form("General");
    await expect.element(saveBar("General")).toHaveTextContent("No unsaved changes");
    expect(imageIn(instance.element())).toBeNull();

    await userEvent.upload(
      page.getByLabelText("Instance icon, choose image"),
      await imageFile("image/jpeg", 400, 100),
    );
    await expect.poll(() => imageIn(instance.element())).toMatch(/^data:image\/png;base64,/);
    await expect.element(saveBar("General")).toHaveTextContent("Unsaved changes");
    // Cropped to its centre and made 256×256, as a PNG, whatever it was.
    expect(await sizeOf(imageIn(instance.element()) ?? "")).toEqual([256, 256]);

    await instance.getByRole("button", { name: "Discard" }).click();
    await expect.poll(() => imageIn(instance.element())).toBeNull();
    await expect.element(saveBar("General")).toHaveTextContent("No unsaved changes");
    expect(api.avatarRequests).toEqual([]);
  });

  test("Save sends the PNG; the sidebar's head shows it; Remove takes it away", async () => {
    const api = installFakeApi();
    renderApp("/settings");
    const instance = form("General");
    await expect.element(saveBar("General")).toHaveTextContent("No unsaved changes");
    await userEvent.upload(page.getByLabelText("Instance icon, choose image"), await imageFile());
    await instance.getByRole("button", { name: "Save instance settings" }).click();

    await expect.element(saveBar("General")).toHaveTextContent("No unsaved changes");
    expect(api.avatarRequests).toEqual([
      { path: "/api/settings/avatar", method: "PUT", type: "image/png", bytes: expect.any(Number) },
    ]);
    // Only the icon changed: the name and timezone are not sent.
    expect(api.bodies.filter((body) => body.path === "/api/settings")).toEqual([]);
    await expect.poll(() => imageIn(instanceHead())).toBe(api.settings.avatarUrl);

    await instance.getByRole("button", { name: "Remove" }).click();
    await expect.element(saveBar("General")).toHaveTextContent("Unsaved changes");
    await instance.getByRole("button", { name: "Save instance settings" }).click();
    await expect.element(saveBar("General")).toHaveTextContent("No unsaved changes");
    expect(api.avatarRequests.at(-1)).toMatchObject({
      path: "/api/settings/avatar",
      method: "DELETE",
    });
    await expect.poll(() => imageIn(instanceHead())).toBeNull();
    await expect.element(instance.getByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });

  test("a failed upload says why above the bar and keeps every edit", async () => {
    const api = installFakeApi({
      avatarRefusal: new Response(
        JSON.stringify({
          error: "storage_unavailable",
          message: "The image could not be stored. Try again in a minute.",
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      ),
    });
    renderApp("/settings");
    const instance = form("General");
    await expect.element(saveBar("General")).toHaveTextContent("No unsaved changes");
    await userEvent.upload(page.getByLabelText("Instance icon, choose image"), await imageFile());
    await instance.getByRole("textbox", { name: "Instance name" }).fill("Acme Labs");
    await instance.getByRole("button", { name: "Save instance settings" }).click();

    await expect
      .element(instance.getByText("The image could not be stored. Try again in a minute."))
      .toBeVisible();
    await expect.element(saveBar("General")).toHaveTextContent("Unsaved changes");
    await expect
      .element(instance.getByRole("textbox", { name: "Instance name" }))
      .toHaveValue("Acme Labs");
    expect(imageIn(instance.element())).toMatch(/^data:image\/png/);
    // The rest waits for the icon: nothing else was sent.
    expect(api.bodies.filter((body) => body.path === "/api/settings")).toEqual([]);
  });

  test("a file the browser cannot read says so, and changes nothing", async () => {
    installFakeApi();
    renderApp("/settings");
    await expect.element(saveBar("General")).toHaveTextContent("No unsaved changes");
    const broken = new File(["not really a picture"], "broken.png", { type: "image/png" });
    await userEvent.upload(page.getByLabelText("Instance icon, choose image"), broken);
    await expect
      .element(
        page.getByText("This file can't be read as an image. Choose a PNG, JPEG, WebP, or GIF."),
      )
      .toBeVisible();
    await expect.element(saveBar("General")).toHaveTextContent("No unsaved changes");
  });

  test("without object storage, the field is disabled and says why", async () => {
    installFakeApi({ avatarUploads: false });
    renderApp("/settings");
    const choose = form("General").getByRole("button", { name: "Instance icon, choose image" });
    await expect.element(choose).toBeDisabled();
    await expect
      .element(page.getByText("Uploads need object storage. Set OBJECT_STORE_URL on the server."))
      .toBeVisible();
    await expect.element(choose).toHaveAccessibleDescription(/Uploads need object storage/);
  });
});

describe("the user's avatar", () => {
  test("chosen in Profile, saved with the name, and shown in the user menu", async () => {
    const api = installFakeApi();
    renderApp("/account");
    const profile = form("Profile");
    await expect.element(saveBar("Profile")).toHaveTextContent("No unsaved changes");
    await userEvent.upload(
      page.getByLabelText("Avatar, choose image"),
      await imageFile("image/webp"),
    );
    await profile.getByRole("textbox", { name: "Name" }).fill("Test Person");
    await expect.element(saveBar("Profile")).toHaveTextContent("Unsaved changes");
    await profile.getByRole("button", { name: "Save profile" }).click();

    await expect.element(saveBar("Profile")).toHaveTextContent("No unsaved changes");
    expect(api.avatarRequests).toEqual([
      { path: "/api/account/avatar", method: "PUT", type: "image/png", bytes: expect.any(Number) },
    ]);
    expect(api.account.name).toBe("Test Person");
    const userButton = page.getByRole("button", { name: /Account menu$/ });
    await expect.poll(() => imageIn(userButton.element())).toBe(api.userAvatarUrl);
  });

  test("saving twice in a row uploads each image once; then the name alone sends no image", async () => {
    const api = installFakeApi();
    renderApp("/account");
    const profile = form("Profile");
    const save = profile.getByRole("button", { name: "Save profile" });
    await expect.element(saveBar("Profile")).toHaveTextContent("No unsaved changes");

    await userEvent.upload(page.getByLabelText("Avatar, choose image"), await imageFile());
    await save.click();
    await expect.element(saveBar("Profile")).toHaveTextContent("No unsaved changes");
    // The field holds the address the server answered, not the picture sent.
    await expect.poll(() => imageIn(profile.element())).toBe(api.userAvatarUrl);

    await userEvent.upload(
      page.getByLabelText("Avatar, choose image"),
      // Another picture: the fake's address for the first is that PNG itself.
      await imageFile("image/jpeg", 50, 80, "#c00"),
    );
    await expect.element(saveBar("Profile")).toHaveTextContent("Unsaved changes");
    await save.click();
    await expect.element(saveBar("Profile")).toHaveTextContent("No unsaved changes");
    expect(api.avatarRequests.map(({ method }) => method)).toEqual(["PUT", "PUT"]);

    await profile.getByRole("textbox", { name: "Name" }).fill("Renamed Owner");
    await save.click();
    await expect.element(saveBar("Profile")).toHaveTextContent("No unsaved changes");
    expect(api.account.name).toBe("Renamed Owner");
    expect(api.avatarRequests).toHaveLength(2);
    expect(imageIn(profile.element())).toBe(api.userAvatarUrl);
  });

  test("Remove, then Save, deletes it; the initials come back", async () => {
    const api = installFakeApi();
    api.userAvatarUrl = `data:image/png;base64,${btoa("x")}`;
    renderApp("/account");
    const profile = form("Profile");
    await profile.getByRole("button", { name: "Remove" }).click();
    await expect.element(saveBar("Profile")).toHaveTextContent("Unsaved changes");
    await profile.getByRole("button", { name: "Save profile" }).click();
    await expect.element(saveBar("Profile")).toHaveTextContent("No unsaved changes");
    expect(api.avatarRequests).toEqual([
      { path: "/api/account/avatar", method: "DELETE", type: null, bytes: 0 },
    ]);
    await expect
      .element(page.getByRole("button", { name: /Account menu$/ }))
      .toMatchTextContent("TO");
  });
});

describe("a project's icon", () => {
  test("saved in the project's General settings, and shown in the project switcher", async () => {
    const api = installFakeApi();
    renderApp(`/projects/${PROJECT.id}/settings?tab=general`);
    const general = form("General");
    await expect.element(saveBar("General")).toHaveTextContent("No unsaved changes");
    await userEvent.upload(
      page.getByLabelText("Icon, choose image"),
      await imageFile("image/gif", 64, 64),
    );
    await expect.element(saveBar("General")).toHaveTextContent("Unsaved changes");
    await general.getByRole("button", { name: "Save changes" }).click();
    await expect.element(saveBar("General")).toHaveTextContent("No unsaved changes");
    expect(api.avatarRequests).toEqual([
      {
        path: `/api/projects/${PROJECT.id}/avatar`,
        method: "PUT",
        type: "image/png",
        bytes: expect.any(Number),
      },
    ]);
    const switcher = page.getByRole("button", { name: /^Project: Main site/ });
    await expect.poll(() => imageIn(switcher.element())).toBe(api.projects[0]?.iconUrl);
  });

  test("after the icon is saved, saving the name sends only the name", async () => {
    const api = installFakeApi();
    renderApp(`/projects/${PROJECT.id}/settings?tab=general`);
    const general = form("General");
    await expect.element(saveBar("General")).toHaveTextContent("No unsaved changes");
    await userEvent.upload(page.getByLabelText("Icon, choose image"), await imageFile());
    await general.getByRole("button", { name: "Save changes" }).click();
    await expect.element(saveBar("General")).toHaveTextContent("No unsaved changes");

    await general.getByRole("textbox", { name: "Name" }).fill("Renamed site");
    await general.getByRole("button", { name: "Save changes" }).click();
    await expect.element(saveBar("General")).toHaveTextContent("No unsaved changes");
    expect(api.avatarRequests).toHaveLength(1);
    expect(api.projects[0]?.name).toBe("Renamed site");
  });

  test("without an uploaded icon the site's favicon shows, in the switcher and its menu", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const favicon = canvas.toDataURL("image/png");
    installFakeApi({ projects: [{ ...PROJECT, avatarUrl: favicon, iconUrl: null }] });
    renderApp(ANALYTICS);
    const switcher = page.getByRole("button", { name: /^Project: Main site/ });
    await expect.poll(() => imageIn(switcher.element())).toBe(favicon);
    await switcher.click();
    const item = page.getByRole("menuitem", { name: /Main site/ });
    await expect.poll(() => imageIn(item.element())).toBe(favicon);
  });
});
