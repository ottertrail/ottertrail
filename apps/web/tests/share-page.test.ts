import { readFileSync } from "node:fs";

import { expect, test } from "vite-plus/test";

/*
 * A shared link's page (share.html; docs/web-analytics.md, "Shared links"):
 * its own entry, never indexed, and without the dashboard's code.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const html = read("../share.html");

test("share.html asks search engines not to index or follow it, and sends no referrer", () => {
  const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
  expect(head).toContain('<meta name="robots" content="noindex, nofollow" />');
  expect(head).toContain('<meta name="referrer" content="no-referrer" />');
});

test("share.html loads its own app, not the dashboard's", () => {
  expect(html).toContain('<script type="module" src="/src/share/main.tsx"></script>');
  expect(html).not.toContain("/src/main.tsx");
  for (const file of [
    "../src/share/main.tsx",
    "../src/share/share-root.tsx",
    "../src/share/share-app.tsx",
  ]) {
    expect(read(file)).not.toMatch(
      /from "@\/(router|lib\/auth-client|lib\/access|components\/app-shell)/u,
    );
  }
});
