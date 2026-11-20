import { expect, test } from "vite-plus/test";

import { documentTitle } from "../src/lib/document-title.ts";

test("the page first, then the project, then Ottertrail", () => {
  expect(documentTitle({ page: "Errors", project: "Demo shop" })).toBe(
    "Errors · Demo shop – Ottertrail",
  );
  expect(documentTitle({ page: "Projects" })).toBe("Projects – Ottertrail");
});

test("parts not known yet, empty, or the product's own name are left out", () => {
  expect(documentTitle({ page: "Errors", project: undefined })).toBe("Errors – Ottertrail");
  expect(documentTitle({ page: "  ", project: "Ottertrail" })).toBe("Ottertrail");
  expect(documentTitle({})).toBe("Ottertrail");
});
