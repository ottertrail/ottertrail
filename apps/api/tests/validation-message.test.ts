import { describe, expect, test } from "vite-plus/test";

import { validationMessage } from "../src/validation-message.ts";

const error = (keyword: string, instancePath: string, params: Record<string, unknown>) => ({
  keyword,
  instancePath,
  schemaPath: "",
  params,
});

describe("a schema refusal as a sentence", () => {
  test("names the field in words, and where it is when nested", () => {
    expect(validationMessage([error("maxLength", "/instanceName", { limit: 100 })], "body")).toBe(
      "The instance name can have at most 100 characters.",
    );
    expect(validationMessage([error("minLength", "/events/2/name", { limit: 1 })], "body")).toBe(
      "The name in events/2 must not be empty.",
    );
    expect(validationMessage([error("type", "/events/0", { type: "object" })], "body")).toBe(
      "Item 0 of events must be an object.",
    );
    expect(validationMessage([error("format", "/projectId", { format: "uuid" })], "params")).toBe(
      "The project ID must be a valid uuid.",
    );
  });

  test("names the part of the request when the whole of it is wrong", () => {
    expect(validationMessage([error("type", "", { type: "object" })], "body")).toBe(
      "The request body must be an object.",
    );
    expect(validationMessage([], "querystring")).toBe("The query string could not be accepted.");
  });

  test("lists a short set of allowed values, never a long one", () => {
    expect(
      validationMessage(
        [error("enum", "/period", { allowedValues: ["24h", "7d"] })],
        "querystring",
      ),
    ).toBe('The period must be one of: "24h", "7d".');
    const many = Array.from({ length: 11 }, (_, index) => `v${index}`);
    expect(validationMessage([error("enum", "/country", { allowedValues: many })], "body")).toBe(
      "The country must be one of the allowed values.",
    );
  });

  test("reads right for a plural name, and counts one in the singular", () => {
    expect(validationMessage([error("minItems", "/steps", { limit: 1 })], "body")).toBe(
      "The steps must have at least 1 item.",
    );
    expect(validationMessage([error("required", "", { missingProperty: "steps" })], "body")).toBe(
      "Add the steps.",
    );
    expect(
      validationMessage([error("required", "/events/2", { missingProperty: "name" })], "body"),
    ).toBe("Add the name in events/2.");
  });
});
