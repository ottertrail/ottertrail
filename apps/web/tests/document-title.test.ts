import { expect, test } from "vite-plus/test";

import { documentTitle } from "../src/lib/document-title.ts";

test("the page first, then the project, then the instance, then Ottertrail", () => {
  expect(documentTitle({ page: "Errors", project: "Demo shop", instance: "Acme" })).toBe(
    "Errors · Demo shop · Acme – Ottertrail",
  );
  expect(documentTitle({ page: "Projects", instance: "Acme" })).toBe(
    "Projects · Acme – Ottertrail",
  );
});

test("parts not known yet, empty, or the product's own name are left out", () => {
  expect(documentTitle({ page: "Errors", project: undefined, instance: undefined })).toBe(
    "Errors – Ottertrail",
  );
  expect(documentTitle({ page: "Ottertrail", instance: "  " })).toBe("Ottertrail");
  expect(documentTitle({})).toBe("Ottertrail");
});
