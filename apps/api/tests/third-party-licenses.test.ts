import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import {
  bundledPackages,
  cssImportedPackages,
  licensesText,
  packageDirectory,
  readmeLicenseSection,
  thirdPartyLicenses,
} from "../../../scripts/third-party-licenses.ts";

describe("packageDirectory", () => {
  test.each([
    [
      "/repo/node_modules/.pnpm/fastify@5.12.8/node_modules/fastify/lib/route.js",
      "/repo/node_modules/.pnpm/fastify@5.12.8/node_modules/fastify",
    ],
    [
      "/repo/node_modules/.pnpm/@fastify+static@10.1.10/node_modules/@fastify/static/index.js",
      "/repo/node_modules/.pnpm/@fastify+static@10.1.10/node_modules/@fastify/static",
    ],
    ["/repo/node_modules/react/index.js?commonjs-es-import", "/repo/node_modules/react"],
    ["C:/repo/node_modules/react/index.js", "C:/repo/node_modules/react"],
  ])("finds the package of %s", (id, directory) => {
    expect(packageDirectory(id)).toBe(directory);
  });

  test.each([
    "/repo/apps/api/src/server.ts",
    "\0rolldown/runtime.js",
    "node:fs",
    "/repo/node_modules/@scoped",
  ])("ignores %s", (id) => {
    expect(packageDirectory(id)).toBeNull();
  });
});

describe("readmeLicenseSection", () => {
  test("takes the licence section up to the next heading as high", () => {
    const readme = [
      "# pgpass",
      "Reads passwords.",
      "## License",
      "Copyright (c) 2013 Someone",
      "### Details",
      "Permission is hereby granted.",
      "## Changelog",
      "1.0.0",
    ].join("\n");
    expect(readmeLicenseSection(readme)).toBe(
      "## License\nCopyright (c) 2013 Someone\n### Details\nPermission is hereby granted.",
    );
  });

  test("returns null without a licence section, or with an empty one", () => {
    expect(readmeLicenseSection("# Tool\nUsage.")).toBeNull();
    expect(readmeLicenseSection("# Tool\n## License\n## Other")).toBeNull();
  });
});

describe("cssImportedPackages", () => {
  test("lists packages imported by name, each once", () => {
    const css = [
      '@import "tailwindcss";',
      "@import 'tw-animate-css';",
      '@import "shadcn/tailwind.css";',
      '@import "@fontsource-variable/inter/opsz.css";',
      '@import "@fontsource-variable/inter";',
      '@import url("./local.css");',
      '@import "/absolute.css";',
      '@import "https://fonts.example.com/font.css";',
    ].join("\n");
    expect(cssImportedPackages(css)).toEqual([
      "tailwindcss",
      "tw-animate-css",
      "shadcn",
      "@fontsource-variable/inter",
    ]);
  });
});

describe("the licences file", () => {
  let directory: string;
  let modules: string;

  async function addPackage(
    name: string,
    manifest: Record<string, unknown>,
    files: Record<string, string>,
  ) {
    const packageDir = join(modules, name);
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ name, ...manifest }));
    for (const [file, content] of Object.entries(files)) {
      await writeFile(join(packageDir, file), content);
    }
    return packageDir;
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "ottertrail-licenses-"));
    modules = join(directory, "app", "node_modules");
    await addPackage("zeta", { version: "2.0.0", license: "MIT" }, { LICENSE: "MIT text\n" });
    await addPackage(
      "@scope/alpha",
      { version: "1.0.0", licenses: [{ type: "BSD-3-Clause" }] },
      { "LICENSE.md": "BSD text" },
    );
    await addPackage(
      "readme-only",
      { version: "0.1.0", license: "MIT" },
      { "README.md": "# readme-only\n## License\nCopyright (c) Someone\n" },
    );
    await addPackage("bare", { version: "3.0.0" }, {});
    await addPackage("styles", { version: "4.0.0", license: "MIT" }, { LICENSE: "styles text" });
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("lists each bundled package once, sorted, with its licence text", () => {
    const packages = bundledPackages([
      `${modules}/zeta/index.js`,
      `${modules}/zeta/lib/other.js`,
      `${modules}/@scope/alpha/index.js`,
      `${modules}/readme-only/index.js`,
      `${modules}/bare/index.js`,
      `${directory}/app/src/main.ts`,
    ]);
    expect(packages).toEqual([
      { name: "@scope/alpha", version: "1.0.0", license: "BSD-3-Clause", text: "BSD text" },
      {
        name: "bare",
        version: "3.0.0",
        license: "not declared",
        text: null,
      },
      {
        name: "readme-only",
        version: "0.1.0",
        license: "MIT",
        text: "(No licence file; from the package's README.)\n\n## License\nCopyright (c) Someone",
      },
      { name: "zeta", version: "2.0.0", license: "MIT", text: "MIT text" },
    ]);

    const text = licensesText(packages);
    expect(text).toContain("zeta 2.0.0 (MIT)\n" + "=".repeat(72) + "\n\nMIT text");
    expect(text).toContain("bare 3.0.0 (not declared)");
    expect(text).toContain("The package ships no licence file");
  });

  test("the plugin writes the file, including packages a stylesheet imports", async () => {
    const stylesheet = join(directory, "app", "src", "styles.css");
    await mkdir(join(directory, "app", "src"), { recursive: true });
    await writeFile(stylesheet, '@import "styles";\n@import "./local.css";\n');
    const emitted: { fileName: string; source: string }[] = [];
    const plugin = thirdPartyLicenses({ stylesheets: [stylesheet] });
    plugin.generateBundle.call({
      getModuleIds: () => [`${modules}/zeta/index.js`][Symbol.iterator](),
      emitFile: (file) => {
        emitted.push(file);
        return file.fileName;
      },
    });
    expect(emitted.map((file) => file.fileName)).toEqual(["THIRD_PARTY_LICENSES.txt"]);
    expect(emitted[0]?.source).toContain("styles 4.0.0 (MIT)");
    expect(emitted[0]?.source).toContain("zeta 2.0.0 (MIT)");
  });

  test("the plugin stops the build when it finds no packages at all", () => {
    const plugin = thirdPartyLicenses();
    expect(() =>
      plugin.generateBundle.call({
        getModuleIds: () => ["\0virtual", "/repo/src/main.ts"][Symbol.iterator](),
        emitFile: () => "",
      }),
    ).toThrow(/found no bundled npm packages/);
  });

  test("the plugin stops the build when a stylesheet imports a missing package", async () => {
    const stylesheet = join(directory, "app", "src", "broken.css");
    await writeFile(stylesheet, '@import "not-installed";\n');
    const plugin = thirdPartyLicenses({ stylesheets: [stylesheet] });
    expect(() =>
      plugin.generateBundle.call({
        getModuleIds: () => [][Symbol.iterator](),
        emitFile: () => "",
      }),
    ).toThrow(/imports not-installed, which is not installed/);
  });
});
