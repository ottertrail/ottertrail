import { readFileSync } from "node:fs";

import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

import { thirdPartyLicenses } from "../../scripts/third-party-licenses.ts";

/** `?inline` stylesheets as their text, as Vite gives them in tests: rrweb's player CSS. */
const inlineCss = {
  name: "inline-css",
  load(id: string) {
    if (!id.endsWith(".css?inline")) return null;
    const css = readFileSync(id.slice(0, -"?inline".length), "utf8");
    return `export default ${JSON.stringify(css)};`;
  },
};

export default defineConfig({
  // The API serves dist/player.js at /replay-player.js.
  pack: {
    entry: { player: "src/main.ts" },
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify: true,
    sourcemap: true,
    dts: false,
    // Bundle dependencies for direct browser use.
    deps: { alwaysBundle: [/./] },
    plugins: [inlineCss, thirdPartyLicenses()],
    // The libraries' licenses ask for their notices to go with them: rrweb,
    // and what rrweb's own build of the player puts in it.
    banner: [
      "/*! rrweb, Copyright (c) 2018 Contributors (https://github.com/rrweb-io/rrweb/graphs/contributors), MIT License: https://github.com/rrweb-io/rrweb/blob/master/LICENSE */",
      "/*! postcss, Copyright 2013 Andrey Sitnik, MIT License: https://github.com/postcss/postcss/blob/main/LICENSE */",
      "/*! nanoid, Copyright 2017 Andrey Sitnik, MIT License: https://github.com/ai/nanoid/blob/main/LICENSE */",
      "/*! picocolors, Copyright (c) 2021-2024 Oleksii Raspopov, Kostiantyn Denysov, Anton Verinov, ISC License: https://github.com/alexeyraspopov/picocolors/blob/main/LICENSE */",
      "/*! mitt, Copyright (c) 2021 Jason Miller, MIT License: https://github.com/developit/mitt/blob/main/LICENSE */",
      "/*! base64-arraybuffer, Copyright (c) 2012 Niklas von Hertzen, MIT License: https://github.com/niklasvh/base64-arraybuffer/blob/master/LICENSE-MIT */",
    ].join("\n"),
    outputOptions: { entryFileNames: "[name].js" },
  },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["tests/*.test.ts"], environment: "node" },
      },
      {
        // Install Chromium once: pnpm exec playwright install --only-shell chromium
        extends: true,
        test: {
          name: "browser",
          include: ["tests/browser/**/*.test.ts"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            viewport: { width: 1280, height: 800 },
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
